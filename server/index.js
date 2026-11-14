'use strict';
// PhoneDesk server: one small Node process. No Electron, no native modules.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const log = require('./log');
const config = require('./config');
const Bridge = require('./bridge');
const adb = require('./adb');
const stats = require('./stats');
const mdns = require('./mdns');
const autostart = require('./autostart');
const artwork = require('./artwork');
const lyrics = require('./lyrics');
const weather = require('./weather');
const calendar = require('./calendar');
const spotify = require('./spotify');
const notify = require('./notify');
const updater = require('./updater');
const firewall = require('./firewall');
const addons = require('./addons');
const widgets = require('./widgets');

const { ROOT } = require('./paths');
const PUBLIC = path.join(ROOT, 'public');
const VERSION = require('../package.json').version;

// Never let one bad event take the whole thing down.
process.on('uncaughtException', (e) => log.error('uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log.error('unhandled rejection: ' + (e && e.stack || e)));

// ---------------------------------------------------------------- state
const state = {
  media: { active: false },
  volume: { level: 0, muted: false },
  art: null, // { id, type, buf }
  mixer: [],
  gpu: null,
  lyrics: null,
  bt: [],      // Bluetooth devices that report a battery: [{ name, level }]
  toggles: null, // Quick toggles from the bridge: { micMuted, dark, wifi, bluetooth }, each true/false/null
  recent: [],  // songs played lately, newest first: [{ title, artist, app, at }]
  mediaRaw: '', // the playing app's Windows id (e.g. Spotify.exe)
};

// ---------------------------------------------------------------- bridge (media + volume)
const bridge = new Bridge(path.join(__dirname, 'bridge-win.ps1'));
bridge.on('message', (m) => {
  if (m.t === 'media') {
    // A new track: drop the old picture right away instead of showing it on the next song.
    const key = m.active ? [m.app, m.title, m.artist].join('|') : '';
    if (key !== trackKey) {
      trackKey = key;
      state.art = null;
      state.lyrics = null;
      broadcast({ t: 'lyrics', d: null });
      if (m.active && m.title) {
        state.recent = [{ title: String(m.title).slice(0, 120), artist: String(m.artist || '').slice(0, 120), app: String(m.app || '').slice(0, 80), at: Date.now() }]
          .concat(state.recent.filter((r) => !(r.title === m.title && r.artist === (m.artist || '')))).slice(0, 20);
        broadcast({ t: 'recent', d: state.recent });
      }
      if (m.active) {
        findLyrics(m, key);
        if (/spotify/i.test(m.app || '')) spotify.kick(config.get());
      }
    } else if (m.active && lyricsNoLength && m.duration > 0) {
      // Firefox-based browsers tell a new song's length only after a moment (or a pause): the first lookup had none,
      // which finds no lyrics or those of another version. Look again now that the length is known.
      findLyrics(m, key);
    }
    if (typeof m.art === 'string') {
      if (m.art) setArt(Buffer.from(m.art, 'base64'));
      else {
        state.art = null;
        // The app has no picture for this track: try to find one online.
        if (m.active && config.get().artLookup) {
          const wanted = trackKey;
          artwork.find(m).then((buf) => {
            if (!buf || trackKey !== wanted || state.art) return;
            setArt(buf);
            state.media = Object.assign({}, state.media, { art: '/art/' + state.art.id });
            broadcast({ t: 'media', d: state.media });
          });
        }
      }
    }
    delete m.art;
    delete m.t;
    // Keep the art id stable across position updates of the same track.
    m.art = state.art ? '/art/' + state.art.id : '';
    const rawApp = m.app;
    state.mediaRaw = m.active ? rawApp : '';
    const ic = appIcons.get(rawApp);
    m.appIcon = ic ? '/appicon/' + ic.id : '';
    m.game = !!(ic && ic.game);
    m.site = siteOf(rawApp, m.title);
    m.app = m.site === 'youtube' ? 'YouTube' : ic && ic.name && ic.name.length <= 24 ? ic.name : prettyApp(rawApp);
    if (m.site === 'youtube') m.title = String(m.title || '').replace(/\s+-\s+YouTube( Music)?$/i, '');
    state.media = m;
    if (m.active && rawApp) seenApps.set(rawApp, { token: appToken(rawApp), name: m.app, icon: m.appIcon || '' });
    broadcast({ t: 'media', d: state.media });
  } else if (m.t === 'appicon') {
    const buf = Buffer.from(m.png || '', 'base64');
    if (buf.length) {
      const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
      appIcons.set(m.app, { id, buf, name: String(m.name || '').trim(), game: !!m.game });
      if (state.mixer.some((x) => x.app === m.app)) broadcastMixer();
    }
  } else if (m.t === 'volume') {
    state.volume = { level: m.level, muted: m.muted };
    broadcast({ t: 'volume', d: state.volume });
  } else if (m.t === 'mixer') {
    state.mixer = Array.isArray(m.items) ? m.items : [];
    broadcastMixer();
  } else if (m.t === 'gpu') {
    state.gpu = { load: m.load, temp: m.temp, hotspot: m.hotspot, fan: m.fan, power: m.power, vram: m.vram };
  } else if (m.t === 'net') {
    stats.setNet(+m.rx, +m.tx);
  } else if (m.t === 'sys') {
    stats.setExtras({ cpuTemp: m.cpuTemp, procs: m.procs, procsMem: m.procsMem });
  } else if (m.t === 'bt') {
    // every connected Bluetooth device; level is -1 when it does not report a battery
    const KINDS = ['audio', 'keyboard', 'mouse', 'controller', 'input', 'phone', 'computer', 'watch'];
    const items = (Array.isArray(m.items) ? m.items : []).filter((x) => x && x.name)
      .slice(0, 16).map((x) => ({ name: String(x.name).slice(0, 60), level: +x.level >= 0 && +x.level <= 100 ? Math.round(+x.level) : -1, kind: KINDS.includes(x.kind) ? x.kind : '' }))
      .sort((a, b) => (b.level >= 0) - (a.level >= 0) || a.name.localeCompare(b.name));
    if (JSON.stringify(items) !== JSON.stringify(state.bt)) { state.bt = items; broadcast({ t: 'bt', d: items }); }
  } else if (m.t === 'toggles') {
    // the Quick toggles: true/false, or null when this PC can't read that one
    const b = (v) => (v === true || v === false ? v : null);
    const t = { micMuted: b(m.micMuted), dark: b(m.dark), wifi: b(m.wifi), bluetooth: b(m.bluetooth) };
    if (JSON.stringify(t) !== JSON.stringify(state.toggles)) { state.toggles = t; broadcast({ t: 'toggles', d: t }); }
  } else if (m.t === 'log') {
    log.warn('[bridge] ' + m.msg);
  } else if (m.t === 'ready') {
    log.info('media bridge ready');
    bridge.send('ignore ' + config.get().ignoreApps.join(','));
  }
});

let trackKey = '';
// Apps seen playing this run, for "Hide these apps" in the PC window: raw id -> { token, name, icon }
const seenApps = new Map();
/** The part of a player's id that stays the same and survives the ignore list's cleaning (lower case, [a-z0-9._-]). */
function appToken(raw) {
  let s = String(raw || '').toLowerCase();
  if (s.includes('!')) s = s.split('!')[0].split('_')[0]; // a Store app: its package name
  else if (/[\\/]/.test(s)) s = s.split(/[\\/]/).pop().replace(/\.exe$/, ''); // a path: the program
  else s = s.replace(/\.exe$/, '');
  return s.replace(/[^a-z0-9._-]/g, '').slice(0, 60);
}
let lyricsNoLength = false; // the current song's lyrics were looked up before its length was known
let lyricsSeq = 0;
function findLyrics(m, key) {
  lyricsNoLength = !(m.duration > 0);
  const seq = ++lyricsSeq;
  lyrics.find(m, config.get()).then((l) => {
    if (trackKey !== key) return;
    // an older lookup (made before the length was known) only fills in while the newer one has found nothing yet
    if (seq !== lyricsSeq && (!l || (state.lyrics && state.lyrics.key === key && !state.lyrics.none))) return;
    // a second lookup (now with the length) that finds nothing keeps what the first one found
    if (!l && state.lyrics && state.lyrics.key === key && !state.lyrics.none) return;
    state.lyrics = l ? Object.assign({ key }, l) : { key, none: true, lines: [] };
    broadcast({ t: 'lyrics', d: state.lyrics });
  });
}
const appIcons = new Map(); // app id -> { id, buf, name, game }

function iconUrl(app) { const ic = appIcons.get(app); return ic ? '/appicon/' + ic.id : ''; }
function mixerView() {
  return state.mixer.map((x) => ({ pid: x.pid, name: x.name, level: x.level, muted: x.muted, active: x.active, system: x.system, icon: iconUrl(x.app) }));
}
function broadcastMixer() { broadcast({ t: 'mixer', d: mixerView() }); }

// ---------------------------------------------------------------- notifications
const pendingIcons = new Map();
function onNotification(n) {
  const c = config.get();
  if (/phonedesk/i.test(n.app) || c.notifyIgnore.some((x) => x && n.app.toLowerCase().includes(x.toLowerCase()))) return;
  const deliver = () => {
    const ic = appIcons.get(n.app);
    const msg = {
      id: n.id,
      app: ic && ic.name ? ic.name : n.appName,
      icon: ic ? '/appicon/' + ic.id : '',
      title: c.notifyPrivate ? '' : n.title,
      body: c.notifyPrivate ? '' : n.body,
    };
    broadcast({ t: 'notify', d: msg }, 'phone');
    addons.emit('notification', { app: msg.app, title: msg.title, body: msg.body });
  };
  if (appIcons.has(n.app)) return deliver();
  // Ask the bridge for this app's icon and name, then send (with or without it) shortly after.
  bridge.send('icon ' + n.app);
  setTimeout(deliver, 1200);
}

const BROWSERS = /chrome|msedge|firefox|308046b0af4a39cb|6f193ccc56814779|opera|brave|vivaldi|zen/i;
// What a browser tab is playing, judged by the tab title.
function siteOf(app, title) {
  if (!BROWSERS.test(String(app || ''))) return '';
  if (/-\s*YouTube( Music)?$/i.test(String(title || ''))) return 'youtube';
  return '';
}
const adbBattery = new Map(); // 'usb' or a phone's Wi-Fi IP -> { level, charging }
function pushAdbBattery(c) {
  if (c.role !== 'phone') return;
  const b = adbBattery.get(c.info.via === 'USB' ? 'usb' : c.info.ip);
  if (!b) return;
  if (!c.ownBattery) c.info.battery = { level: Math.round(b.level * 100), charging: b.charging };
  sendTo(c.ws, { t: 'battery', d: b });
}
function setArt(buf) {
  const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  state.art = { id, buf, type: sniffImage(buf) };
}

function prettyApp(id) {
  if (!id) return '';
  const s = String(id).toLowerCase();
  if (s.includes('spotify')) return 'Spotify';
  if (s.includes('chrome')) return 'Chrome';
  if (s.includes('msedge') || s.includes('edge')) return 'Edge';
  if (s.includes('firefox')) return 'Firefox';
  if (s.includes('zunemusic') || s.includes('media player')) return 'Media Player';
  if (s.includes('vlc')) return 'VLC';
  if (s.includes('discord')) return 'Discord';
  if (/^[0-9a-f]{16}$/.test(s)) return 'Browser'; // a Firefox-family browser the bridge could not name yet (the icon lookup names it)
  return String(id).replace(/\.exe$/i, '').split(/[!\\/]/).pop();
}

function sniffImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

// ---------------------------------------------------------------- shortcuts
function runShortcut(id) {
  const sc = config.get().shortcuts.find((s) => s.id === id);
  if (!sc) return;
  log.event('shortcut', `Shortcut “${sc.label}” pressed`);
  try {
    if (sc.type === 'keys') {
      bridge.send('keys ' + sc.value);
    } else if (sc.type === 'addon') {
      addons.runAction(sc.value);
    } else if (sc.type === 'url' || sc.type === 'app') {
      // `start` handles URLs, files, and app paths; detached so it never blocks or ties to us.
      const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', sc.value], {
        detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: false,
      });
      child.on('error', (e) => log.error('shortcut failed: ' + e.message));
      child.unref();
    }
  } catch (e) {
    log.error('shortcut failed: ' + e.message);
  }
}

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.apk': 'application/vnd.android.package-archive',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
};

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveStatic(req, res, rel) {
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  if (rel === 'phone/index.html') { // the phone page carries the version it came from, so an old copy can tell it is stale
    return fs.readFile(file, 'utf8', (err, html) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      send(res, 200, html.replace('<meta name="pd-version" content="">', `<meta name="pd-version" content="${VERSION}">`), 'text/html; charset=utf-8');
    });
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found', 'text/plain');
    const etag = '"' + st.size.toString(36) + '-' + st.mtimeMs.toString(36) + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      ETag: etag,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/** The raw bytes of a request body (a .zip picked in the PC window), up to max bytes. */
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('that file is too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Every address a phone can reach this PC on, best first. A phone that loaded PhoneDesk over USB
// (localhost) uses these to carry on over Wi-Fi when the cable is pulled, and vice versa.
function phoneHosts() {
  const port = config.get().port;
  const suffix = port80Ok ? '' : ':' + port;
  const list = [mdns.name() + suffix, ...lanAddresses().map((a) => a.address + suffix), 'localhost:' + port];
  return [...new Set(list)];
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    if (/vethernet|virtualbox|vmware|docker|wsl|hyper-v|loopback|tailscale|zerotier|mullvad|wireguard/i.test(name)) continue;
    for (const a of ifs[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      if (a.address.startsWith('192.168.56.')) continue; // VirtualBox host-only adapter
      const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      out.push({ name, address: a.address, score: (priv ? 2 : 0) + (/wi-?fi|wlan|ethernet/i.test(name) ? 1 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

async function handleApi(req, res, url) {
  if (!isLocal(req)) return send(res, 403, { error: 'dashboard API is only available on this PC' });
  const p = url.pathname;
  try {
    if (p === '/api/status' && req.method === 'GET') {
      const port = config.get().port;
      const addrs = lanAddresses();
      return send(res, 200, {
        version: VERSION,
        uptime: process.uptime(),
        port,
        urls: addrs.map((a) => ({ name: a.name, url: `http://${a.address}${port80Ok ? '' : ':' + port}` })),
        nameUrl: `http://${mdns.name()}${port80Ok ? '' : ':' + port}`,
        port80: port80Ok,
        clients: [...clients].filter((c) => c.role === 'phone').map((c) => c.info),
        bridge: bridge.status(),
        lyrics: state.lyrics && state.lyrics.lines && state.lyrics.lines.length ? { credit: state.lyrics.credit || null, wordSynced: !!state.lyrics.wordSynced, synced: !!state.lyrics.synced } : null,
        adb: adb.status(),
        media: state.media,
        volume: state.volume,
      });
    }
    if (p === '/api/qr' && req.method === 'GET') {
      const text = url.searchParams.get('text') || '';
      const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } });
      return send(res, 200, svg, 'image/svg+xml');
    }
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, config.get());
    if (p === '/api/media-apps' && req.method === 'GET') { // apps seen playing, newest first, and which one plays now
      const now = state.mediaRaw ? appToken(state.mediaRaw) : '';
      const list = [...seenApps.values()].reverse().filter((a, i, l) => a.token && l.findIndex((b) => b.token === a.token) === i);
      return send(res, 200, { now, apps: list });
    }
    if (p === '/api/diagnostics' && req.method === 'GET') {
      const z = require('./diagnostics').build({
        version: VERSION, config: config.get(), log, update: updater.status(), bridge: bridge.status ? bridge.status() : null,
        phones: [...clients].filter((c) => c.role === 'phone').map((c) => c.info),
      });
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${z.name}"`, 'Content-Length': z.data.length, 'Cache-Control': 'no-store' });
      log.event('info', 'Saved a diagnostics file');
      return res.end(z.data);
    }
    if (p === '/api/whatsnew' && req.method === 'GET') {
      const c = config.get();
      const notes = require('./changelog').forVersion(VERSION);
      // Shown once after an update; a fresh install sees first-run setup instead.
      return send(res, 200, Object.assign({ version: VERSION, show: !!notes && c.onboarded && c.seenVersion !== VERSION }, notes || {}));
    }
    if (p === '/api/whatsnew/seen' && req.method === 'POST') {
      config.update({ seenVersion: VERSION });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/calendar/check' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await calendar.check(String(body.url || '').trim()));
    }
    if (p === '/api/spicy/check' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await require('./spicylyrics').check(String(body.key || config.get().spicyKey || '')));
    }
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const before = config.get();
      const next = config.update(body);
      broadcast({ t: 'config', d: publicConfig() });
      if (next.autoUsb !== before.autoUsb) adb.setAuto(next.autoUsb, next.port);
      if (next.ignoreApps.join(',') !== before.ignoreApps.join(',')) bridge.send('ignore ' + next.ignoreApps.join(','));
      if (next.calendarUrl !== before.calendarUrl) calendar.reload(next);
      if (next.weather !== before.weather || next.weatherCity !== before.weatherCity || next.weatherUnit !== before.weatherUnit) weather.reload(next);
      return send(res, 200, next);
    }
    if (p === '/api/pages/new' && req.method === 'POST') {
      const b = await readBody(req), c = config.get();
      if (c.pages.length >= widgets.LIMITS.pages) throw new Error(`${widgets.LIMITS.pages} pages is the most`);
      const page = widgets.fromTemplate(String(b.template || 'blank'), String(b.name || ''));
      const next = config.update({ pages: [...c.pages, page], screens: [...c.screens, 'page:' + page.id] });
      broadcast({ t: 'config', d: publicConfig() });
      return send(res, 200, { page, config: next });
    }
    if (p === '/api/pages/from-screen' && req.method === 'POST') {
      // Customize a built-in screen: a page with the same widgets takes its place in the swipe row
      const b = await readBody(req), c = config.get(), screen = String(b.screen || '');
      if (!c.screens.includes(screen)) throw new Error('that screen is not on the phone');
      if (c.pages.length >= widgets.LIMITS.pages) throw new Error(`${widgets.LIMITS.pages} pages is the most`);
      const page = widgets.fromBuiltin(screen, c);
      if (!page) throw new Error('that screen is not made of widgets');
      const next = config.update({ pages: [...c.pages, page], screens: c.screens.map((x) => (x === screen ? 'page:' + page.id : x)) });
      broadcast({ t: 'config', d: publicConfig() });
      return send(res, 200, { page, config: next });
    }
    if (p === '/api/photos' && req.method === 'GET') { photoCache.at = 0; const l = photoList(); return send(res, 200, { count: l.length, dir: config.get().photosDir || '' }); }
    if (p === '/api/widgets' && req.method === 'GET') return send(res, 200, Object.assign(widgets.catalog(), { addonWidgets: addons.widgetList() }));
    if (p === '/api/addons' && req.method === 'GET') {
      const reg = await addons.loadRegistry();
      return send(res, 200, { installed: addons.list(), registry: addons.registryView(reg), actions: addons.actionList(), version: VERSION });
    }
    if (p === '/api/addons/refresh' && req.method === 'POST') {
      const reg = await addons.checkUpdates(false);
      return send(res, 200, { installed: addons.list(), registry: addons.registryView(reg), actions: addons.actionList(), version: VERSION });
    }
    if (p === '/api/addons/prepare' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await addons.prepare({ registryId: typeof body.registryId === 'string' ? body.registryId : '', url: typeof body.url === 'string' ? body.url.trim() : '' }));
    }
    if (p === '/api/addons/prepare-file' && req.method === 'POST') return send(res, 200, addons.prepareFile(await readRaw(req, 20 * 1024 * 1024)));
    if (p === '/api/addons/confirm' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, addons.confirm(String(b.token || ''), b.permissions)); }
    if (p === '/api/addons/remove' && req.method === 'POST') { const b = await readBody(req); addons.remove(String(b.id || ''), b.keepData === true); return send(res, 200, { ok: true }); }
    if (p === '/api/addons/enable' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, addons.setEnabled(String(b.id || ''), b.enabled !== false)); }
    if (p === '/api/addons/log' && req.method === 'GET') return send(res, 200, addons.diag(String(url.searchParams.get('id') || '')));
    if (p === '/api/addons/settings' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, addons.setSettings(String(b.id || ''), b.values || {})); }
    if (p === '/api/addons/dev' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, addons.installLocal(String(b.dir || ''))); }
    if (p === '/api/logs' && req.method === 'GET') return send(res, 200, log.recent());
    if (p === '/api/adb/connect' && req.method === 'POST') {
      const r = await adb.connectAll(config.get().port, true);
      return send(res, 200, r);
    }
    if (p === '/api/adb/install' && req.method === 'POST') {
      const r = await adb.install();
      return send(res, 200, r);
    }
    if (p === '/api/shortcut' && req.method === 'POST') {
      const body = await readBody(req);
      runShortcut(body.id);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/bridge/restart' && req.method === 'POST') {
      bridge.restart();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/shutdown' && req.method === 'POST') {
      send(res, 200, { ok: true });
      return void setTimeout(shutdown, 50);
    }
    const pm = p.match(/^\/api\/phones\/([a-f0-9]{8})\/(identify|reload|screen)$/);
    if (pm && req.method === 'POST') {
      const c = [...clients].find((x) => x.role === 'phone' && x.info.id === pm[1]);
      if (!c) return send(res, 404, { error: 'that phone is not connected' });
      const body = await readBody(req);
      if (pm[2] === 'identify') sendTo(c.ws, { t: 'identify', d: { name: c.info.device } });
      if (pm[2] === 'reload') sendTo(c.ws, { t: 'reload' });
      if (pm[2] === 'screen') sendTo(c.ws, { t: 'show', v: String(body.screen || '') });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/activity' && req.method === 'GET') return send(res, 200, log.activity());
    if (p === '/api/spotify' && req.method === 'GET') {
      return send(res, 200, { clientId: config.get().spotifyClientId, connected: spotify.connected(), redirect: spotifyRedirect(), now: spotify.latest() });
    }
    if (p === '/api/spotify/login' && req.method === 'GET') {
      const id = config.get().spotifyClientId;
      if (!id) return send(res, 400, { error: 'Add your Spotify Client ID first' });
      res.writeHead(302, { Location: spotify.loginUrl(id, spotifyRedirect()) });
      return res.end();
    }
    if (p === '/api/spotify/disconnect' && req.method === 'POST') { spotify.disconnect(); return send(res, 200, { ok: true }); }
    if (p === '/api/weather' && req.method === 'GET') return send(res, 200, weather.latest() || {});
    if (p === '/api/update' && req.method === 'GET') return send(res, 200, updater.status());
    if (p === '/api/update/check' && req.method === 'POST') return send(res, 200, await updater.check(config.get(), VERSION));
    if (p === '/api/update/download' && req.method === 'POST') return send(res, 200, await updater.download());
    if (p === '/api/update/install' && req.method === 'POST') { updater.install(); return send(res, 200, { ok: true }); }
    if (p === '/api/firewall' && req.method === 'GET') return send(res, 200, await firewall.check());
    if (p === '/api/firewall/fix' && req.method === 'POST') return send(res, 200, await firewall.fix());
    if (p === '/api/autostart') {
      if (req.method === 'POST') { const body = await readBody(req); await autostart.set(!!body.enabled); }
      return send(res, 200, await autostart.get());
    }
    if (p === '/api/phones/reload' && req.method === 'POST') {
      broadcast({ t: 'reload' }, 'phone');
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    if (p.startsWith('/api/addons')) { log.warn('addons: ' + e.message); return send(res, 400, { error: e.message }); } // mostly a package or a link that is not right
    log.error('api ' + p + ': ' + e.message);
    return send(res, 500, { error: e.message });
  }
}

let port80Ok = false;

function app(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad url', 'text/plain'); }
  const p = url.pathname;

  if (p.startsWith('/api/')) return void handleApi(req, res, url);

  if (p === '/spotify/callback') {
    if (!isLocal(req)) return send(res, 403, 'forbidden', 'text/plain');
    const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>PhoneDesk</title><body style="font:16px system-ui;background:#0b0c0f;color:#edeff3;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:22px">${title}</h1><p style="color:#9aa1ae">${text}</p></div>`;
    spotify.callback(url.searchParams)
      .then(() => { send(res, 200, page('Spotify is connected', 'You can close this tab and go back to PhoneDesk.'), 'text/html; charset=utf-8'); broadcast({ t: 'spotifyStatus' }, 'dashboard'); })
      .catch((e) => send(res, 400, page('Spotify didn\'t connect', String(e.message).replace(/</g, '&lt;')), 'text/html; charset=utf-8'));
    return;
  }

  if (p.startsWith('/appicon/')) {
    const id = p.slice(9);
    const ic = [...appIcons.values()].find((x) => x.id === id);
    if (!ic) return send(res, 404, 'no icon', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': ic.buf.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
    return res.end(ic.buf);
  }

  if (p.startsWith('/art/')) {
    const id = p.slice(5);
    if (!state.art || state.art.id !== id) return send(res, 404, 'no art', 'text/plain');
    res.writeHead(200, {
      'Content-Type': state.art.type,
      'Content-Length': state.art.buf.length,
      // Art URLs are content-addressed, so the phone can cache them forever.
      'Cache-Control': 'public, max-age=31536000, immutable',
      // The phone may have loaded its page from another address (USB) than it now talks to (Wi-Fi).
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(state.art.buf);
  }

  // An addon's screen: its own files, shown on the phone in a sandboxed frame with no network access of its own.
  if (p === '/addons/sdk.js') return serveStatic(req, res, 'phone/addon-sdk.js');
  if (p.startsWith('/addons/')) {
    const m = /^\/addons\/([a-z0-9-]{2,40})\/(.+)$/.exec(p);
    let rel = '';
    try { rel = m ? decodeURIComponent(m[2]) : ''; } catch { rel = ''; }
    const file = m && addons.screenFile(m[1], rel);
    if (!file) return send(res, 404, 'not found', 'text/plain');
    return fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        // No network from the page itself (connect-src 'none'); data comes through the SDK. Its own files only.
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-ancestors 'self'",
      });
      fs.createReadStream(file).pipe(res);
    });
  }

  if (p === '/' || p === '/index.html') {
    // The PC itself goes to the dashboard; everyone else gets the phone UI.
    return serveStatic(req, res, isLocal(req) && !url.searchParams.has('phone') && !isAdbPhone(req) ? 'dashboard/index.html' : 'phone/index.html');
  }
  { const ph = /^\/photos\/(\d{1,4})$/.exec(p); if (ph) return servePhoto(req, res, +ph[1]); }
  if (p === '/phone' || p === '/phone/') return serveStatic(req, res, 'phone/index.html');
  if (p === '/dashboard' || p === '/dashboard/') return serveStatic(req, res, 'dashboard/index.html');
  return serveStatic(req, res, p.slice(1));
}
const server = http.createServer(app);
const server80 = http.createServer(app);

// A phone over USB (adb reverse) also connects from 127.0.0.1. Its browser is mobile, so tell by UA.
function isAdbPhone(req) {
  return /Android|Mobile/i.test(req.headers['user-agent'] || '');
}

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
function onUpgrade(req, socket, head) {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}
server.on('upgrade', onUpgrade);
server80.on('upgrade', onUpgrade);
const clients = new Set();

// ---------------------------------------------------------------- photo frame
// Pictures from one folder on this PC (chosen in the PC window), for the Photo frame widget. Only image files from
// that folder (not its subfolders) are served, by number, so nothing else on the PC can be reached.
const PHOTO_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
let photoCache = { dir: '', at: 0, list: [] };
function photoList() {
  const dir = config.get().photosDir || '';
  if (!dir) return [];
  if (photoCache.dir === dir && Date.now() - photoCache.at < 60000) return photoCache.list;
  let list = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && PHOTO_TYPES[path.extname(e.name).toLowerCase()])
      .map((e) => e.name).sort().slice(0, 1000);
  } catch (e) { log.warn('photo folder: ' + e.message); }
  photoCache = { dir, at: Date.now(), list };
  return list;
}
function servePhoto(req, res, n) {
  const list = photoList(), name = list[n];
  if (!name) return send(res, 404, 'not found', 'text/plain');
  const file = path.join(config.get().photosDir, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile() || st.size > 40 * 1024 * 1024) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': PHOTO_TYPES[path.extname(name).toLowerCase()], 'Content-Length': st.size, 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
}

function publicConfig() {
  const c = config.get();
  const addonScreens = addons.screenIds();
  return {
    version: VERSION,
    shortcuts: c.shortcuts.map(({ id, label, icon, color, group, live }) => ({ id, label, icon, color, group, live })),
    clock24: c.clock24,
    theme: c.theme,
    accent: c.accent,
    screens: c.screens.filter((x) => !x.startsWith('addon:') || addonScreens.includes(x)),
    addons: addons.phoneScreens(),
    addonWidgets: addons.widgetList().map(({ type, entry, aid, wid, name, version, permissions }) => ({ type, entry, aid, wid, name, version, permissions })),
    pages: c.pages,
    dimAfter: c.dimAfter,
    schedule: c.schedule,
    notes: c.notes,
    photos: photoList().length,
    doubleTapPlay: c.doubleTapPlay,
    look: c.look,
    nowStyle: c.nowStyle,
    lyricsMode: c.lyricsMode,
    lyricsFont: c.lyricsFont,
    lyricsLines: c.lyricsLines,
    lyricsOffset: c.lyricsOffset,
    clockFace: c.clockFace,
    clockForecast: c.clockForecast,
    nightMode: c.nightMode,
    nightFrom: c.nightFrom,
    nightTo: c.nightTo,
    nightRed: c.nightRed,
    nightClock: c.nightClock,
    burnIn: c.burnIn,
    showBattery: c.showBattery,
    weather: c.weather,
    notifications: c.notifications,
  };
}

function sendTo(ws, msg) {
  if (ws.readyState !== 1) return;
  // Drop updates for a client that is not keeping up instead of piling up memory.
  if (ws.bufferedAmount > 256 * 1024) return;
  ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(msg, role) {
  if (!role && (msg.t === 'media' || msg.t === 'volume' || msg.t === 'stats')) addons.emit(msg.t, msg.d); // addons that asked for it
  const data = JSON.stringify(msg);
  for (const c of clients) if (!role || c.role === role) sendTo(c.ws, data);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const role = url.searchParams.get('role') === 'dashboard' ? 'dashboard' : 'phone';
  const ua = req.headers['user-agent'] || '';
  const client = {
    ws, role, alive: true,
    info: {
      id: crypto.randomBytes(4).toString('hex'),
      ip: (req.socket.remoteAddress || '').replace('::ffff:', ''),
      via: isLocal(req) ? 'USB' : 'Wi-Fi',
      device: deviceName(ua),
      since: Date.now(),
      screen: url.searchParams.get('screen') || '',
    },
  };
  clients.add(client);
  if (role === 'phone') {
    log.event('phone', `${client.info.device} connected over ${client.info.via}`);
    pushAdbBattery(client);
    // On Wi-Fi: try a network ADB link (only works if the phone has it switched on).
    if (client.info.via === 'Wi-Fi' && config.get().autoUsb) adb.tryWifi(client.info.ip);
    broadcast({ t: 'clients' }, 'dashboard');
  }

  sendTo(ws, { t: 'hello', d: { version: VERSION, serverTime: Date.now(), hosts: phoneHosts() } });
  sendTo(ws, { t: 'config', d: publicConfig() });
  sendTo(ws, { t: 'media', d: state.media });
  sendTo(ws, { t: 'volume', d: state.volume });
  sendTo(ws, { t: 'stats', d: Object.assign({}, stats.latest(), { gpu: state.gpu }) });
  sendTo(ws, { t: 'history', d: stats.history() });
  sendTo(ws, { t: 'mixer', d: mixerView() });
  sendTo(ws, { t: 'lyrics', d: state.lyrics });
  sendTo(ws, { t: 'weather', d: weather.latest() });
  sendTo(ws, { t: 'calendar', d: calendar.latest() });
  sendTo(ws, { t: 'spotify', d: spotify.latest() });
  sendTo(ws, { t: 'bt', d: state.bt });
  if (state.toggles) sendTo(ws, { t: 'toggles', d: state.toggles });
  sendTo(ws, { t: 'recent', d: state.recent });
  if (role === 'dashboard') sendTo(ws, { t: 'update', d: updater.status() });

  ws.on('pong', () => {
    client.alive = true;
    if (client.pingAt) client.info.rtt = Date.now() - client.pingAt;
  });
  client.pingAt = Date.now();
  try { ws.ping(); } catch {}
  ws.on('message', (raw) => {
    client.alive = true;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    handleClientMessage(client, m);
  });
  ws.on('close', () => {
    clients.delete(client);
    if (role === 'phone') {
      log.event('phone', `${client.info.device} disconnected`);
      broadcast({ t: 'clients' }, 'dashboard');
    }
  });
  ws.on('error', () => {});
});

const MEDIA_CMDS = new Set(['toggle', 'play', 'pause', 'next', 'prev', 'shuffle', 'repeat']);
function handleClientMessage(client, m) {
  switch (m.t) {
    case 'ping': return sendTo(client.ws, { t: 'pong', d: m.d });
    case 'cmd':
      if (MEDIA_CMDS.has(m.a)) bridge.send(m.a);
      else if (m.a === 'seek' && Number.isFinite(+m.v)) bridge.send('seek ' + Math.max(0, +m.v).toFixed(2));
      return;
    case 'volume':
      if (Number.isFinite(+m.v)) bridge.send('volume ' + Math.min(1, Math.max(0, +m.v)).toFixed(3));
      return;
    case 'mute': return bridge.send('mute');
    case 'qt': // a Quick toggles tile: sound is the volume mute; the rest go to the bridge
      if (m.k === 'sound') return bridge.send('mute');
      if (['mic', 'wifi', 'bluetooth', 'dark'].includes(m.k)) bridge.send('qt ' + m.k);
      return;
    case 'appvol':
      if (Number.isInteger(+m.pid) && Number.isFinite(+m.v)) bridge.send(`appvol ${+m.pid} ${Math.min(1, Math.max(0, +m.v)).toFixed(3)}`);
      return;
    case 'appmute': if (Number.isInteger(+m.pid)) bridge.send('appmute ' + +m.pid); return;
    case 'like': spotify.toggleLike(config.get()).catch((e) => log.warn('spotify like: ' + e.message)); return;
    case 'shortcut': return runShortcut(String(m.id || ''));
    case 'addon': // a message from an addon's screen on the phone to the addon's PC-side code
      if (typeof m.id === 'string' && JSON.stringify(m.d === undefined ? null : m.d).length < 64 * 1024) addons.fromPhone(m.id, m.d, typeof m.w === 'string' ? m.w.slice(0, 30) : '');
      return;
    case 'screen': client.info.screen = String(m.v || '').slice(0, 20); return;
    case 'note': { // a to-do ticked on the phone
      const c = config.get(), id = String(m.id || '');
      if (!c.notes.some((n) => n.id === id)) return;
      config.update({ notes: c.notes.map((n) => (n.id === id ? Object.assign({}, n, { done: !!m.done }) : n)) });
      broadcast({ t: 'config', d: publicConfig() });
      return;
    }
    case 'pageEdit': { // widgets moved or resized on the phone: only their places and sizes change
      const c = config.get(), page = c.pages.find((p) => p.id === m.id);
      if (!page || !Array.isArray(m.widgets)) return;
      const pos = new Map(m.widgets.filter((w) => w && typeof w.id === 'string').map((w) => [w.id, w]));
      const widgetsNext = page.widgets.map((w) => { const q = pos.get(w.id); return q ? Object.assign({}, w, { x: +q.x, y: +q.y, w: +q.w, h: +q.h }) : w; });
      config.update({ pages: c.pages.map((p) => (p.id === page.id ? Object.assign({}, p, { widgets: widgetsNext }) : p)) });
      broadcast({ t: 'config', d: publicConfig() });
      log.event('info', `Page “${page.name}” rearranged on the phone`);
      return;
    }
    case 'diag': log.info('phone info: ' + JSON.stringify(m.d || {}).slice(0, 300)); return;
    case 'battery':
      if (Number.isFinite(+m.level)) { client.ownBattery = true; client.info.battery = { level: Math.round(+m.level * 100), charging: !!m.charging }; }
      return;
  }
}

function deviceName(ua) {
  const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
  if (m) {
    const model = m[1].trim();
    if (/^SM-A115/i.test(model)) return 'Samsung Galaxy A11';
    return model === 'K' ? 'Android phone' : model;
  }
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Windows/.test(ua)) return 'Windows browser';
  return 'Browser';
}

// Heartbeat: drop dead sockets so the phone list stays truthful.
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    c.pingAt = Date.now();
    try { c.ws.ping(); } catch {}
  }
}, 10000).unref();

// PC stats: only computed while someone is listening.
stats.start((s) => broadcast({ t: 'stats', d: Object.assign({}, s, { gpu: state.gpu }) }), () => clients.size > 0,
  () => (state.gpu && state.gpu.load >= 0 ? state.gpu.load : -1),
  (point) => broadcast({ t: 'histPoint', d: point }));

// Extras that run on their own schedule.
function spotifyRedirect() { return `http://127.0.0.1:${config.get().port}/spotify/callback`; }
weather.start(() => config.get(), (w) => { broadcast({ t: 'weather', d: w }); addons.emit('weather', w); });
calendar.start(() => config.get(), (c) => { broadcast({ t: 'calendar', d: c }); addons.emit('calendar', c); });
spotify.start(() => config.get(), () => /spotify/i.test(state.mediaRaw), (s) => broadcast({ t: 'spotify', d: s }));
notify.start(() => config.get().notifications && clients.size > 0, onNotification);
updater.start(() => config.get(), VERSION, (s) => broadcast({ t: 'update', d: s }, 'dashboard'));


// ---------------------------------------------------------------- addons
addons.init({
  version: VERSION,
  broadcast: (m) => broadcast(m), // phones, and the layout editor's preview (which connects as a dashboard)
  media: () => state.media,
  volume: () => state.volume,
  stats: () => Object.assign({}, stats.latest(), { gpu: state.gpu }),
  weather: () => weather.latest(),
  calendar: () => calendar.latest(),
  sendKeys: (k) => bridge.send('keys ' + k),
  mediaCommand: (c) => bridge.send(c),
  setVolume: (v) => bridge.send('volume ' + v.toFixed(3)),
  getConfig: () => config.get(),
  // A new addon with a screen gets a page in the phone's swipe row; a removed one loses it.
  installed: (id) => {
    if (!addons.screenIds().includes('addon:' + id)) return;
    const c = config.get();
    if (!c.screens.includes('addon:' + id)) config.update({ screens: [...c.screens, 'addon:' + id] });
  },
  removed: (id) => {
    const c = config.get();
    if (c.screens.includes('addon:' + id)) config.update({ screens: c.screens.filter((x) => x !== 'addon:' + id) });
  },
  changed: () => { broadcast({ t: 'config', d: publicConfig() }); broadcast({ t: 'addons' }, 'dashboard'); },
});
widgets.setAddonLookup(addons.widgetDesc);
process.on('exit', () => addons.stopAll());

// ---------------------------------------------------------------- start
const port = config.get().port;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log.error(`port ${port} is already in use. Is PhoneDesk already running? Change "port" in data/config.json if needed.`);
    process.exit(2);
  }
  log.error('server error: ' + e.message);
});
server.listen(port, '0.0.0.0', () => {
  log.info(`PhoneDesk ${VERSION} running`);
  addons.startAll();
  setTimeout(() => { if (config.get().autoUpdateAddons) addons.checkUpdates(true).catch(() => {}); }, 3 * 60 * 1000).unref();
  setInterval(() => { if (config.get().autoUpdateAddons) addons.checkUpdates(true).catch(() => {}); }, 6 * 3600 * 1000).unref();
  log.info(`Dashboard: http://localhost:${port}`);
  for (const a of lanAddresses()) log.info(`Phone (Wi-Fi, by IP): http://${a.address}:${port}   [${a.name}]`);
  if (process.platform === 'win32') bridge.start();
  else log.warn('media bridge only supports Windows; media controls disabled');
  // Is PhoneDesk already open on this phone? (Wi-Fi link: match by IP; cable: any USB phone.)
  adb.onlineCheck((wifiIp) => [...clients].some((c) => c.role === 'phone' && (wifiIp ? c.info.ip === wifiIp : c.info.via === 'USB')));
  adb.setPhoneUrl(() => `http://${mdns.name()}${port80Ok ? '' : ':' + port}/phone`);
  // Battery read through adb (USB or Wi-Fi link). Works even when the phone's browser can't report it.
  adb.onBattery((b, where) => {
    const key = where.wifiIp || (where.onlyCable ? 'usb' : null); // several cables: can't tell which is which
    if (!key) return;
    adbBattery.set(key, b);
    for (const c of clients) pushAdbBattery(c);
  });
  adb.setAuto(config.get().autoUsb, port, 10000);
  // Also serve on port 80 so the phone address can be just http://phonedesk.local
  const startMdns = () => mdns.start({ name: config.get().name, port: port80Ok ? 80 : port });
  if (config.get().port80 && port !== 80) {
    server80.once('error', (e) => {
      log.info(`port 80 is busy (${e.code}), phones will use :${port}`);
      startMdns();
    });
    server80.listen(80, '0.0.0.0', () => { port80Ok = true; startMdns(); });
  } else {
    port80Ok = port === 80;
    startMdns();
  }
  if (process.argv.includes('--open')) {
    spawn('cmd.exe', ['/d', '/c', 'start', '""', `http://localhost:${port}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down');
  bridge.stop();
  adb.stopAuto();
  for (const c of clients) try { c.ws.close(1001); } catch {}
  mdns.stop();
  server.close();
  server80.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
