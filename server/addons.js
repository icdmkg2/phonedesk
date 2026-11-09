'use strict';
// Addons: extra phone screens and PC-side code, installed from a registry or a link.
//
//   package   a .zip with addon.json at its root (docs/addons/)
//   installed DATA/addons/installed/<id>/   data DATA/addons/data/<id>/   state DATA/addons/addons.json
//   runtime   PC-side code runs in its own Node process (server/addon-host.js) with Node's permission model on
//   screen    served from /addons/<id>/... and shown on the phone inside a sandboxed iframe
//
// Everything in a package is untrusted: names are checked, sizes are limited, the SHA-256 of a registry
// download must match the registry, and the user approves the permissions before anything is installed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork, spawn } = require('child_process');
const { DATA } = require('./paths');
const log = require('./log');
const { unzip, safeName } = require('./zip');

const BASE = path.join(DATA, 'addons');
const INSTALLED = path.join(BASE, 'installed');
const DATADIR = path.join(BASE, 'data');
const STATE_FILE = path.join(BASE, 'addons.json');
const HOST_FILE = path.join(__dirname, 'addon-host.js');

const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/icdmkg2/phonedesk/main/registry/index.json';
// Where a package may be downloaded from (after redirects too): GitHub only.
const DOWNLOAD_HOSTS = ['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const MAX_PACKAGE = 20 * 1024 * 1024;

/* ---------------------------------------------------------------- permissions */
// What an addon may ask for. Shown to the user before install; the PC-side API checks them on every call.
const PERMISSIONS = {
  media: { label: 'Read what is playing', level: 'low' },
  volume: { label: 'Read the PC\'s volume', level: 'low' },
  stats: { label: 'Read CPU, memory and GPU use', level: 'low' },
  control: { label: 'Control playback and volume', level: 'medium' },
  keys: { label: 'Press keys on the PC', level: 'high' },
  run: { label: 'Run programs on the PC', level: 'high' },
};
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function permissionInfo(p) {
  if (PERMISSIONS[p]) return Object.assign({ id: p }, PERMISSIONS[p]);
  if (p === 'network:lan') return { id: p, label: 'Talk to devices on your home network', detail: 'Addresses like 192.168.x.x, 10.x.x.x or names ending in .local.', level: 'high' };
  const m = /^network:(.+)$/.exec(p);
  if (m && HOST_RE.test(m[1])) return { id: p, label: 'Talk to ' + m[1] + ' over the internet or your network', level: 'high' };
  return null;
}
/** A home-network address: private IPv4 ranges, localhost, or a .local name. */
function isLan(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
/** May this host be contacted with the granted permissions? (network:example.com, network:*.example.com) */
function hostAllowed(perms, host) {
  host = String(host).toLowerCase();
  return perms.some((p) => {
    const m = /^network:(.+)$/.exec(p);
    if (!m) return false;
    if (m[1] === 'lan') return isLan(host);
    return m[1].startsWith('*.') ? host.endsWith(m[1].slice(1)) && host.length > m[1].length - 1 : host === m[1];
  });
}

/* ---------------------------------------------------------------- manifest */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
const ICONS = ['mic', 'desktop', 'lock', 'camera', 'music', 'play', 'chart', 'folder', 'bolt', 'globe', 'game', 'code', 'chat', 'power', 'vol', 'next'];

function cmpVer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0), pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}
function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

/** addon.json -> a clean manifest, or throws an Error saying what is wrong (for developers and the install prompt). */
function validateManifest(raw, files) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('addon.json must be an object');
  const m = {};
  if (!ID_RE.test(raw.id || '')) throw new Error('"id" must be 2-40 characters: lower-case letters, numbers and dashes');
  m.id = raw.id;
  m.name = str(raw.name, 40); if (!m.name) throw new Error('"name" is required (40 characters at most)');
  if (!VER_RE.test(raw.version || '')) throw new Error('"version" must look like 1.0.0');
  m.version = raw.version;
  m.description = str(raw.description, 200); if (!m.description) throw new Error('"description" is required (200 characters at most)');
  m.author = str(raw.author, 60); if (!m.author) throw new Error('"author" is required');
  m.homepage = /^https:\/\/[^\s]+$/.test(raw.homepage || '') ? raw.homepage.slice(0, 200) : '';
  if (raw.phonedesk != null && !VER_RE.test(raw.phonedesk)) throw new Error('"phonedesk" is the oldest PhoneDesk version it needs, like 1.9.0');
  m.phonedesk = raw.phonedesk || '1.9.0';
  const perms = Array.isArray(raw.permissions) ? raw.permissions : [];
  if (perms.length > 20) throw new Error('too many permissions');
  m.permissions = [];
  for (const p of perms) {
    if (typeof p !== 'string' || !permissionInfo(p)) throw new Error('unknown permission: ' + String(p).slice(0, 60));
    if (!m.permissions.includes(p)) m.permissions.push(p);
  }
  const needFile = (rel, what) => {
    const n = safeName(String(rel || ''));
    if (!n || n.endsWith('/')) throw new Error(`"${what}" is not a valid file path`);
    if (files && !files.some((f) => f.name === n)) throw new Error(`${what} "${n}" is not in the package`);
    return n;
  };
  if (raw.screen != null) {
    if (typeof raw.screen !== 'object') throw new Error('"screen" must be an object');
    m.screen = {
      title: str(raw.screen.title, 24) || m.name.slice(0, 24),
      entry: needFile(raw.screen.entry || 'screen/index.html', 'screen entry'),
      icon: ICONS.includes(raw.screen.icon) ? raw.screen.icon : 'bolt',
    };
    if (!/\.html?$/i.test(m.screen.entry)) throw new Error('the screen entry must be an .html file');
  }
  if (raw.server != null) {
    m.server = needFile(raw.server, 'server');
    if (!/\.js$/i.test(m.server)) throw new Error('"server" must be a .js file');
  }
  if (!m.screen && !m.server) throw new Error('an addon needs a "screen", a "server", or both');
  m.actions = [];
  for (const a of Array.isArray(raw.actions) ? raw.actions.slice(0, 30) : []) {
    if (!a || !/^[a-z][a-z0-9-]{0,29}$/.test(a.id || '')) throw new Error('an action needs an "id" like "volume-up"');
    m.actions.push({ id: a.id, label: str(a.label, 40) || a.id });
  }
  if (m.actions.length && !m.server) throw new Error('actions need a "server"');
  m.settings = [];
  for (const s of Array.isArray(raw.settings) ? raw.settings.slice(0, 20) : []) {
    if (!s || !/^[a-z][a-zA-Z0-9]{0,29}$/.test(s.key || '')) throw new Error('a setting needs a "key" like "serverUrl"');
    const type = ['text', 'password', 'number', 'boolean', 'select'].includes(s.type) ? s.type : 'text';
    const o = { key: s.key, label: str(s.label, 60) || s.key, type, placeholder: str(s.placeholder, 80), hint: str(s.hint, 160) };
    if (type === 'select') o.options = (Array.isArray(s.options) ? s.options : []).slice(0, 30).map((x) => str(String(x), 40)).filter(Boolean);
    if (s.default != null) o.default = type === 'boolean' ? !!s.default : type === 'number' ? Number(s.default) || 0 : str(String(s.default), 200);
    m.settings.push(o);
  }
  return m;
}

/* ---------------------------------------------------------------- registry entries */
/** One entry of registry/index.json -> a clean entry, or throws. Also used by registry/check.js. */
function validateRegistryEntry(e) {
  if (!e || typeof e !== 'object') throw new Error('an entry must be an object');
  const out = {};
  if (!ID_RE.test(e.id || '')) throw new Error('bad id');
  out.id = e.id;
  out.name = str(e.name, 40); if (!out.name) throw new Error(e.id + ': name is required');
  if (!VER_RE.test(e.version || '')) throw new Error(e.id + ': bad version');
  out.version = e.version;
  out.author = str(e.author, 60); if (!out.author) throw new Error(e.id + ': author is required');
  out.description = str(e.description, 200); if (!out.description) throw new Error(e.id + ': description is required');
  out.homepage = /^https:\/\/[^\s]+$/.test(e.homepage || '') ? e.homepage : '';
  out.download = String(e.download || '');
  let u;
  try { u = new URL(out.download); } catch { throw new Error(e.id + ': download is not a URL'); }
  if (u.protocol !== 'https:' || !DOWNLOAD_HOSTS.includes(u.hostname)) throw new Error(e.id + ': download must be an https GitHub URL');
  if (!/\.zip$/i.test(u.pathname)) throw new Error(e.id + ': download must be a .zip');
  if (!/^[a-f0-9]{64}$/i.test(e.sha256 || '')) throw new Error(e.id + ': sha256 must be 64 hex characters');
  out.sha256 = e.sha256.toLowerCase();
  out.permissions = [];
  for (const p of Array.isArray(e.permissions) ? e.permissions : []) {
    if (!permissionInfo(p)) throw new Error(e.id + ': unknown permission ' + p);
    out.permissions.push(p);
  }
  out.phonedesk = VER_RE.test(e.phonedesk || '') ? e.phonedesk : '1.9.0';
  out.tags = (Array.isArray(e.tags) ? e.tags : []).filter((t) => typeof t === 'string').map((t) => t.slice(0, 20)).slice(0, 6);
  out.firstParty = e.firstParty === true;
  return out;
}

/* ---------------------------------------------------------------- state on disk */
let state = {}; // id -> { version, enabled, permissions, source, sha256, installedAt }
function loadState() {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { state = {}; }
}
function saveState() {
  try {
    fs.mkdirSync(BASE, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { log.error('could not save addons: ' + e.message); }
}
function dirOf(id) { return path.join(INSTALLED, id); }
function dataOf(id) { return path.join(DATADIR, id); }
function readManifest(id) {
  try { return validateManifest(JSON.parse(fs.readFileSync(path.join(dirOf(id), 'addon.json'), 'utf8'))); } catch { return null; }
}
function readSettings(id) {
  try { return JSON.parse(fs.readFileSync(path.join(dataOf(id), 'settings.json'), 'utf8')) || {}; } catch { return {}; }
}

/* ---------------------------------------------------------------- host interface (set by index.js) */
let api = {
  version: '0.0.0', broadcast() {}, media: () => ({}), volume: () => ({}), stats: () => null,
  sendKeys() {}, mediaCommand() {}, setVolume() {}, changed() {}, installed() {}, removed() {}, getConfig: () => ({}),
};
function init(hostApi) { api = Object.assign(api, hostApi); loadState(); }

/* ---------------------------------------------------------------- download */
async function download(url, wantedSha) {
  let u;
  try { u = new URL(url); } catch { throw new Error('that is not a link'); }
  if (u.protocol !== 'https:' || !DOWNLOAD_HOSTS.includes(u.hostname)) throw new Error('addons can only be downloaded from GitHub (https://github.com/…)');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(u, { headers: { 'User-Agent': 'PhoneDesk-addons' }, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
    if (!DOWNLOAD_HOSTS.includes(new URL(res.url).hostname)) throw new Error('the download was sent somewhere other than GitHub');
    if (+res.headers.get('content-length') > MAX_PACKAGE) throw new Error('the package is too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PACKAGE) throw new Error('the package is too large');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (wantedSha && sha !== wantedSha) throw new Error('the download does not match the registry\'s checksum, so it was not installed');
    return { buf, sha };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'the download timed out' : e.message);
  } finally { clearTimeout(t); }
}

/** zip bytes -> { manifest, files } with files relative to addon.json (one wrapping folder is allowed). */
function readPackage(buf) {
  let files = unzip(buf);
  let prefix = '';
  if (!files.some((f) => f.name === 'addon.json')) {
    const dirs = new Set(files.map((f) => f.name.split('/')[0]));
    const cand = [...dirs].filter((d) => files.some((f) => f.name === d + '/addon.json'));
    if (dirs.size === 1 && cand.length === 1) prefix = cand[0] + '/';
  }
  if (prefix) files = files.filter((f) => f.name.startsWith(prefix)).map((f) => ({ name: f.name.slice(prefix.length), data: f.data }));
  const mf = files.find((f) => f.name === 'addon.json');
  if (!mf) throw new Error('addon.json is missing from the package');
  let raw;
  try { raw = JSON.parse(mf.data.toString('utf8')); } catch { throw new Error('addon.json is not valid JSON'); }
  return { manifest: validateManifest(raw, files), files };
}

/* ---------------------------------------------------------------- registry */
let registry = { entries: [], fetchedAt: 0, error: '' };
async function loadRegistry(force) {
  if (!force && registry.fetchedAt && Date.now() - registry.fetchedAt < 3600 * 1000) return registry;
  const url = (api.getConfig() || {}).addonRegistry || DEFAULT_REGISTRY;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'PhoneDesk-addons' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const entries = [];
    for (const e of Array.isArray(j.addons) ? j.addons : []) {
      try { entries.push(validateRegistryEntry(e)); } catch (err) { log.warn('addon registry: skipped an entry: ' + err.message); }
    }
    registry = { entries, fetchedAt: Date.now(), error: '' };
  } catch (e) {
    registry = Object.assign({}, registry, { fetchedAt: registry.fetchedAt || 0, error: 'Couldn\'t load the addon list: ' + e.message });
  }
  return registry;
}

/** The registry as the dashboard shows it: entries with their permissions spelled out. */
function registryView(reg) {
  return { entries: reg.entries.map((e) => Object.assign({}, e, { permissionInfo: e.permissions.map(permissionInfo).filter(Boolean) })), error: reg.error, fetchedAt: reg.fetchedAt };
}

/* ---------------------------------------------------------------- install (two steps: prepare, then confirm) */
const prepared = new Map(); // token -> { files, manifest, sha, source, expires }
function prune() { const now = Date.now(); for (const [k, v] of prepared) if (v.expires < now) prepared.delete(k); }

/**
 * Downloads and checks a package, and says what it would do. Nothing is installed until confirm().
 * { registryId } installs a registry entry (checksum from the registry); { url } is a GitHub link (not reviewed).
 */
async function prepare(opt) {
  prune();
  let url = opt.url, entry = null, source = 'link';
  if (opt.registryId) {
    const reg = await loadRegistry();
    entry = reg.entries.find((e) => e.id === opt.registryId);
    if (!entry) throw new Error('that addon is not in the registry');
    url = entry.download; source = 'registry';
  }
  const { buf, sha } = await download(url, entry && entry.sha256);
  const { manifest, files } = readPackage(buf);
  if (entry) {
    if (manifest.id !== entry.id || manifest.version !== entry.version) throw new Error('the package does not match its registry entry');
    const extra = manifest.permissions.filter((p) => !entry.permissions.includes(p));
    if (extra.length) throw new Error('the package asks for permissions the registry did not list: ' + extra.join(', '));
  }
  return describePrepared(manifest, files, sha, source, entry);
}
function describePrepared(manifest, files, sha, source, entry) {
  if (cmpVer(api.version, manifest.phonedesk) < 0) throw new Error(`this addon needs PhoneDesk ${manifest.phonedesk} or newer (you have ${api.version})`);
  const old = state[manifest.id];
  if (old && cmpVer(manifest.version, old.version) < 0) throw new Error(`version ${old.version} is already installed`);
  const token = crypto.randomBytes(16).toString('hex');
  prepared.set(token, { files, manifest, sha, source, expires: Date.now() + 10 * 60 * 1000 });
  return {
    token, manifest, source, sha256: sha, reviewed: !!(entry && entry.firstParty),
    permissions: manifest.permissions.map(permissionInfo),
    added: old ? manifest.permissions.filter((p) => !old.permissions.includes(p)) : [],
    upgradeFrom: old ? old.version : null,
    warnings: source === 'link' ? ['This addon is not in the PhoneDesk registry, so nobody has reviewed it. Only install it if you trust its author.'] : [],
  };
}

function writeFiles(id, files) {
  fs.mkdirSync(INSTALLED, { recursive: true });
  const stage = path.join(INSTALLED, '.new-' + id), dest = dirOf(id);
  fs.rmSync(stage, { recursive: true, force: true });
  for (const f of files) {
    const target = path.join(stage, ...f.name.split('/'));
    if (!target.startsWith(stage + path.sep)) throw new Error('unsafe file name: ' + f.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
  stopAddon(id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(stage, dest);
}

/** Installs a prepared package once the user has approved exactly the permissions it asks for. */
function confirm(token, granted) {
  prune();
  const p = prepared.get(token);
  if (!p) throw new Error('that install expired; start it again');
  const want = [...p.manifest.permissions].sort().join(',');
  if ([...(Array.isArray(granted) ? granted : [])].sort().join(',') !== want) throw new Error('approve all of the permissions to install this addon');
  prepared.delete(token);
  const id = p.manifest.id, old = state[id];
  writeFiles(id, p.files);
  fs.mkdirSync(dataOf(id), { recursive: true });
  state[id] = { version: p.manifest.version, enabled: old ? old.enabled !== false : true, permissions: p.manifest.permissions, source: p.source, sha256: p.sha, installedAt: Date.now() };
  saveState();
  log.event('info', `Addon “${p.manifest.name}” ${old ? 'updated to' : 'installed,'} ${p.manifest.version}`);
  if (state[id].enabled) startAddon(id);
  if (!old) api.installed(id);
  api.changed();
  return describe(id);
}

/** A folder on this PC (the developer's own addon), for testing. Only from the local API. */
function installLocal(dir) {
  const root = path.resolve(String(dir || ''));
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) { if (files.length > 500) throw new Error('too many files'); files.push({ name: r, data: fs.readFileSync(full) }); }
    }
  };
  walk(root, '');
  const mf = files.find((f) => f.name === 'addon.json');
  if (!mf) throw new Error('addon.json is missing from ' + root);
  const manifest = validateManifest(JSON.parse(mf.data.toString('utf8')), files);
  const id = manifest.id;
  const old = state[id];
  writeFiles(id, files);
  fs.mkdirSync(dataOf(id), { recursive: true });
  state[id] = { version: manifest.version, enabled: true, permissions: manifest.permissions, source: 'dev', sha256: '', installedAt: Date.now() };
  saveState();
  log.event('info', `Addon “${manifest.name}” loaded from ${root}${old ? ' (reloaded)' : ''}`);
  startAddon(id);
  if (!old) api.installed(id);
  api.changed();
  return describe(id);
}

function remove(id, keepData) {
  if (!state[id]) throw new Error('that addon is not installed');
  stopAddon(id);
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  if (!keepData) fs.rmSync(dataOf(id), { recursive: true, force: true });
  const name = (readManifest(id) || {}).name || id;
  delete state[id];
  saveState();
  log.event('info', `Addon “${name}” removed`);
  api.removed(id);
  api.changed();
}

function setEnabled(id, on) {
  if (!state[id]) throw new Error('that addon is not installed');
  state[id].enabled = !!on;
  saveState();
  if (on) startAddon(id); else stopAddon(id);
  api.changed();
  return describe(id);
}

/* ---------------------------------------------------------------- settings */
function cleanSettings(m, values) {
  const cur = {}, old = values.__old || {};
  for (const s of m.settings) {
    let v = values[s.key];
    if (v === undefined) v = old[s.key] !== undefined ? old[s.key] : s.default;
    if (s.type === 'boolean') v = !!v;
    else if (s.type === 'number') v = Number.isFinite(+v) ? +v : (s.default || 0);
    else if (s.type === 'select') v = (s.options || []).includes(v) ? v : (s.default || (s.options || [])[0] || '');
    else v = typeof v === 'string' ? v.slice(0, 500) : (s.default || '');
    cur[s.key] = v;
  }
  return cur;
}
function currentSettings(id) {
  const m = readManifest(id);
  return m ? cleanSettings(m, { __old: readSettings(id) }) : {};
}
/** Saves the values the user typed. A password left empty keeps its old value. */
function setSettings(id, values) {
  const m = readManifest(id);
  if (!state[id] || !m) throw new Error('that addon is not installed');
  const old = readSettings(id), next = {};
  for (const s of m.settings) {
    let v = values ? values[s.key] : undefined;
    if (s.type === 'password' && (v === undefined || v === '')) v = old[s.key];
    next[s.key] = v;
  }
  const clean = cleanSettings(m, Object.assign({}, next, { __old: old }));
  fs.mkdirSync(dataOf(id), { recursive: true });
  fs.writeFileSync(path.join(dataOf(id), 'settings.json'), JSON.stringify(clean, null, 2));
  const h = hosts.get(id);
  if (h && h.child && h.child.connected) h.child.send({ op: 'settings', values: clean });
  return describe(id);
}

/* ---------------------------------------------------------------- describing */
function describe(id) {
  const st = state[id], m = readManifest(id);
  if (!st || !m) return null;
  const vals = readSettings(id);
  const h = hosts.get(id);
  return {
    id, name: m.name, version: st.version, description: m.description, author: m.author, homepage: m.homepage,
    enabled: st.enabled !== false, source: st.source, permissions: st.permissions.map(permissionInfo).filter(Boolean),
    screen: m.screen || null, actions: m.actions, hasServer: !!m.server,
    running: !!(h && h.child && h.child.connected), error: (h && h.error) || '',
    settings: m.settings.map((s) => Object.assign({}, s, {
      value: s.type === 'password' ? '' : cleanSettings(m, { __old: vals })[s.key],
      isSet: s.type === 'password' ? !!vals[s.key] : undefined,
    })),
    update: updates[id] || null,
  };
}
function list() { return Object.keys(state).map(describe).filter(Boolean); }

/** What the phone needs: the enabled addons that have a screen. */
function phoneScreens() {
  const out = [];
  for (const id of Object.keys(state)) {
    if (state[id].enabled === false) continue;
    const m = readManifest(id);
    if (!m || !m.screen) continue;
    out.push({ id, title: m.screen.title, icon: m.screen.icon, entry: m.screen.entry, version: state[id].version, permissions: state[id].permissions });
  }
  return out;
}
function screenIds() { return phoneScreens().map((s) => 'addon:' + s.id); }

/** Absolute path of a file of an enabled addon's screen, or null. */
function screenFile(id, rel) {
  if (!state[id] || state[id].enabled === false || !ID_RE.test(id)) return null;
  const n = safeName(String(rel || ''));
  if (!n || n.endsWith('/')) return null;
  const root = dirOf(id), file = path.join(root, ...n.split('/'));
  return file.startsWith(root + path.sep) ? file : null;
}

/* ---------------------------------------------------------------- PC-side runtime */
const hosts = new Map(); // id -> { child, restarts: [times], error, actions: Map }

function startAddon(id) {
  const m = readManifest(id);
  if (!m || !m.server || !state[id] || state[id].enabled === false) return;
  stopAddon(id);
  const dir = dirOf(id), data = dataOf(id);
  fs.mkdirSync(data, { recursive: true });
  const h = hosts.get(id) || { restarts: [], error: '' };
  hosts.set(id, h);
  const perms = state[id].permissions;
  let child;
  try {
    child = fork(HOST_FILE, [dir, data, m.server], {
      // Node's permission model: no child processes or workers, files only inside the addon's own folders.
      execArgv: ['--permission', `--allow-fs-read=${HOST_FILE}`, `--allow-fs-read=${dir}`, `--allow-fs-read=${data}`, `--allow-fs-write=${data}`],
      env: { PD_ADDON: id }, silent: true, serialization: 'json',
    });
  } catch (e) { h.error = e.message; log.error(`addon ${id}: could not start: ${e.message}`); return; }
  h.child = child; h.error = '';
  h.actions = new Map(m.actions.map((a) => [a.id, a]));
  const lines = (s) => String(s).split(/\r?\n/).filter(Boolean).slice(0, 20);
  child.stdout.on('data', (d) => lines(d).forEach((l) => log.info(`[${id}] ${l.slice(0, 300)}`)));
  child.stderr.on('data', (d) => lines(d).forEach((l) => log.warn(`[${id}] ${l.slice(0, 300)}`)));
  child.on('message', (msg) => onHostMessage(id, perms, msg));
  child.on('error', (e) => { h.error = e.message; });
  child.on('exit', (code, sig) => {
    if (h.child !== child) return; // stopped on purpose
    h.child = null;
    h.error = `stopped (${sig || 'exit ' + code})`;
    log.warn(`addon ${id} ${h.error}`);
    const now = Date.now();
    h.restarts = h.restarts.filter((t) => now - t < 5 * 60 * 1000);
    if (h.restarts.length < 5 && state[id] && state[id].enabled !== false) {
      h.restarts.push(now);
      setTimeout(() => { if (h.child == null && state[id] && state[id].enabled !== false) startAddon(id); }, 2000 * (h.restarts.length)).unref();
    } else h.error += '; not restarted (too many crashes)';
    api.changed();
  });
  child.send({ op: 'start', manifest: m, settings: currentSettings(id), permissions: perms, version: state[id].version });
  api.changed();
}
function stopAddon(id) {
  const h = hosts.get(id);
  if (!h || !h.child) return;
  const c = h.child;
  h.child = null;
  try { c.send({ op: 'stop' }); } catch {}
  setTimeout(() => { try { c.kill(); } catch {} }, 1000).unref();
}
function startAll() {
  loadState();
  for (const id of Object.keys(state)) startAddon(id);
}
function stopAll() { for (const id of hosts.keys()) stopAddon(id); }

const sendRate = new Map(); // id -> { n, at }
function onHostMessage(id, perms, msg) {
  const h = hosts.get(id);
  if (!h || !msg || typeof msg !== 'object') return;
  const reply = (rid, ok, v) => { if (h.child && h.child.connected) h.child.send({ op: 'rpcResult', id: rid, ok, value: ok ? v : String(v) }); };
  if (msg.op === 'log') return log[['info', 'warn', 'error'].includes(msg.level) ? msg.level : 'info'](`[${id}] ${String(msg.msg).slice(0, 300)}`);
  if (msg.op === 'screen') {
    const now = Date.now(), r = sendRate.get(id) || { n: 0, at: now };
    if (now - r.at > 1000) { r.n = 0; r.at = now; }
    if (++r.n > 30) return;
    sendRate.set(id, r);
    const data = JSON.stringify(msg.data === undefined ? null : msg.data);
    if (data.length > 64 * 1024) return;
    return api.broadcast({ t: 'addon', id, d: JSON.parse(data) });
  }
  if (msg.op === 'rpc') {
    Promise.resolve().then(() => rpc(id, perms, msg.method, msg.args || [])).then((v) => reply(msg.id, true, v), (e) => reply(msg.id, false, e && e.message || e));
  }
}

async function rpc(id, perms, method, args) {
  const need = (p) => { if (!perms.includes(p)) throw new Error(`this addon did not get the "${p}" permission`); };
  switch (method) {
    case 'media.get': need('media'); return api.media();
    case 'volume.get': need('volume'); return api.volume();
    case 'stats.get': need('stats'); return api.stats();
    case 'media.command': need('control'); if (!['toggle', 'play', 'pause', 'next', 'prev'].includes(args[0])) throw new Error('unknown command'); return api.mediaCommand(args[0]);
    case 'volume.set': need('control'); { const v = Number(args[0]); if (!Number.isFinite(v)) throw new Error('volume must be 0 to 1'); return api.setVolume(Math.min(1, Math.max(0, v))); }
    case 'keys.send': need('keys'); if (!/^[a-z0-9+]{1,60}$/i.test(String(args[0]))) throw new Error('bad key combination'); return api.sendKeys(String(args[0]).toLowerCase());
    case 'run.exec': need('run'); return runProgram(String(args[0] || ''), Array.isArray(args[1]) ? args[1].map(String).slice(0, 50) : []);
    case 'http.request': return httpRequest(perms, args[0] || {});
    default: throw new Error('unknown method ' + String(method).slice(0, 30));
  }
}

function runProgram(file, args) {
  if (!file || file.length > 500 || /[\u0000\r\n]/.test(file)) throw new Error('bad program');
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, timeout: 30000 });
    let out = '', err = '';
    child.stdout.on('data', (d) => { if (out.length < 100000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 100000) err += d; });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

async function httpRequest(perms, o) {
  let u;
  try { u = new URL(String(o.url)); } catch { throw new Error('bad URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http and https');
  if (!hostAllowed(perms, u.hostname)) throw new Error(`this addon did not get the "network:${u.hostname}" permission`);
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(o.method || 'GET').toUpperCase()) ? String(o.method || 'GET').toUpperCase() : 'GET';
  const headers = {};
  for (const [k, v] of Object.entries(o.headers || {})) if (/^[\w-]{1,40}$/.test(k) && typeof v === 'string' && v.length < 2000) headers[k] = v;
  let url = u, res;
  for (let hop = 0; hop < 4; hop++) { // redirects only to hosts the addon may contact
    res = await fetch(url, { method, headers, body: ['GET', 'DELETE'].includes(method) || o.body == null ? undefined : (typeof o.body === 'string' ? o.body : JSON.stringify(o.body)), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      if (!/^https?:$/.test(url.protocol) || !hostAllowed(perms, url.hostname)) throw new Error('redirected to a host this addon may not contact');
      continue;
    }
    break;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 2 * 1024 * 1024) throw new Error('the response is too large');
  return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), text: buf.toString('utf8') };
}

/* ---------------------------------------------------------------- events in, actions out */
/** Phone -> addon server (a message from the addon's own screen). */
function fromPhone(id, data) {
  const h = hosts.get(id);
  if (h && h.child && h.child.connected && state[id] && state[id].enabled !== false) h.child.send({ op: 'screenMessage', data });
}
/** media / volume / stats -> the addon servers that asked for them. */
function emit(name, data) {
  const perm = { media: 'media', volume: 'volume', stats: 'stats' }[name];
  for (const [id, h] of hosts) {
    if (h.child && h.child.connected && state[id] && state[id].permissions.includes(perm)) h.child.send({ op: 'event', name, data });
  }
}
/** A shortcut button of type "addon": value "<addon>:<action>". */
function runAction(value) {
  const [id, action] = String(value || '').split(':');
  const h = hosts.get(id);
  if (!h || !h.child || !h.child.connected || !h.actions || !h.actions.has(action)) throw new Error('that addon action is not available');
  h.child.send({ op: 'action', id: action });
}
function actionList() {
  const out = [];
  for (const id of Object.keys(state)) {
    if (state[id].enabled === false) continue;
    const m = readManifest(id);
    if (m) for (const a of m.actions) out.push({ value: id + ':' + a.id, label: a.label, addon: m.name });
  }
  return out;
}

/* ---------------------------------------------------------------- updates */
const updates = {}; // id -> { version, needsApproval }
async function checkUpdates(autoInstall) {
  const reg = await loadRegistry(true);
  for (const id of Object.keys(state)) {
    if (state[id].source !== 'registry') continue;
    const e = reg.entries.find((x) => x.id === id);
    if (!e || cmpVer(e.version, state[id].version) <= 0 || cmpVer(api.version, e.phonedesk) < 0) { delete updates[id]; continue; }
    const needsApproval = e.permissions.some((p) => !state[id].permissions.includes(p));
    updates[id] = { version: e.version, needsApproval };
    if (autoInstall && !needsApproval) {
      try { const p = await prepare({ registryId: id }); confirm(p.token, p.manifest.permissions); delete updates[id]; }
      catch (err) { log.warn(`addon ${id}: automatic update failed: ${err.message}`); }
    }
  }
  api.changed();
  return reg;
}

module.exports = {
  PERMISSIONS, DOWNLOAD_HOSTS, DEFAULT_REGISTRY,
  validateManifest, validateRegistryEntry, permissionInfo, hostAllowed, cmpVer, readPackage,
  init, startAll, stopAll, loadRegistry, registryView, checkUpdates, prepare, confirm, installLocal, remove, setEnabled, setSettings,
  list, describe, phoneScreens, screenIds, screenFile, fromPhone, emit, runAction, actionList,
  rpc, // exported for tests
  _state: () => state,
};
