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
};

// ---------------------------------------------------------------- bridge (media + volume)
const bridge = new Bridge(path.join(__dirname, 'bridge-win.ps1'));
bridge.on('message', (m) => {
  if (m.t === 'media') {
    if (typeof m.art === 'string') {
      if (m.art) {
        const buf = Buffer.from(m.art, 'base64');
        const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
        state.art = { id, buf, type: sniffImage(buf) };
      } else {
        state.art = null;
      }
    }
    delete m.art;
    delete m.t;
    // Keep the art id stable across position updates of the same track.
    m.art = state.art ? '/art/' + state.art.id : '';
    m.app = prettyApp(m.app);
    state.media = m;
    broadcast({ t: 'media', d: state.media });
  } else if (m.t === 'volume') {
    state.volume = { level: m.level, muted: m.muted };
    broadcast({ t: 'volume', d: state.volume });
  } else if (m.t === 'log') {
    log.warn('[bridge] ' + m.msg);
  } else if (m.t === 'ready') {
    log.info('media bridge ready');
  }
});

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
  log.info(`shortcut: ${sc.label} (${sc.type})`);
  try {
    if (sc.type === 'keys') {
      bridge.send('keys ' + sc.value);
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
  '.webmanifest': 'application/manifest+json',
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
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
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const before = config.get();
      const next = config.update(body);
      broadcast({ t: 'config', d: publicConfig() });
      if (next.autoUsb !== before.autoUsb) adb.setAuto(next.autoUsb, next.port);
      return send(res, 200, next);
    }
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
    if (p === '/api/phones/reload' && req.method === 'POST') {
      broadcast({ t: 'reload' }, 'phone');
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
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

  if (p.startsWith('/art/')) {
    const id = p.slice(5);
    if (!state.art || state.art.id !== id) return send(res, 404, 'no art', 'text/plain');
    res.writeHead(200, {
      'Content-Type': state.art.type,
      'Content-Length': state.art.buf.length,
      // Art URLs are content-addressed, so the phone can cache them forever.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return res.end(state.art.buf);
  }

  if (p === '/' || p === '/index.html') {
    // The PC itself goes to the dashboard; everyone else gets the phone UI.
    return serveStatic(req, res, isLocal(req) && !url.searchParams.has('phone') && !isAdbPhone(req) ? 'dashboard/index.html' : 'phone/index.html');
  }
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

function publicConfig() {
  const c = config.get();
  return {
    shortcuts: c.shortcuts.map(({ id, label, icon, color }) => ({ id, label, icon, color })),
    clock24: c.clock24,
    theme: c.theme,
    accent: c.accent,
    screens: c.screens,
    dimAfter: c.dimAfter,
  };
}

function sendTo(ws, msg) {
  if (ws.readyState !== 1) return;
  // Drop updates for a client that is not keeping up instead of piling up memory.
  if (ws.bufferedAmount > 256 * 1024) return;
  ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(msg, role) {
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
    log.info(`phone connected: ${client.info.device} via ${client.info.via} (${client.info.ip})`);
    broadcast({ t: 'clients' }, 'dashboard');
  }

  sendTo(ws, { t: 'hello', d: { version: VERSION, serverTime: Date.now() } });
  sendTo(ws, { t: 'config', d: publicConfig() });
  sendTo(ws, { t: 'media', d: state.media });
  sendTo(ws, { t: 'volume', d: state.volume });
  sendTo(ws, { t: 'stats', d: stats.latest() });

  ws.on('pong', () => { client.alive = true; });
  ws.on('message', (raw) => {
    client.alive = true;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    handleClientMessage(client, m);
  });
  ws.on('close', () => {
    clients.delete(client);
    if (role === 'phone') {
      log.info(`phone disconnected: ${client.info.device}`);
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
    case 'shortcut': return runShortcut(String(m.id || ''));
    case 'screen': client.info.screen = String(m.v || '').slice(0, 20); return;
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
    try { c.ws.ping(); } catch {}
  }
}, 15000).unref();

// PC stats: only computed while someone is listening.
stats.start((s) => broadcast({ t: 'stats', d: s }), () => clients.size > 0);

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
  log.info(`Dashboard: http://localhost:${port}`);
  for (const a of lanAddresses()) log.info(`Phone (Wi-Fi, by IP): http://${a.address}:${port}   [${a.name}]`);
  if (process.platform === 'win32') bridge.start();
  else log.warn('media bridge only supports Windows; media controls disabled');
  adb.onlineCheck(() => [...clients].some((c) => c.role === 'phone' && c.info.via === 'USB'));
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
