'use strict';
// Runs ONE addon's server code. Started by server/addons.js with Node's permission model on:
//   --permission --allow-fs-read=<addon folder> --allow-fs-write=<addon data folder>
// so this process can not start programs or workers, and can only touch its own folders. Everything
// else goes through the `pd` object below, which asks PhoneDesk (over IPC) and is checked there.
//
// The network is NOT blocked by Node's permission model. This file removes the usual ways to open a
// connection (fetch, net, http, ...) as a safety net against mistakes, but that is not a security
// boundary against a determined author: the real protections are the permissions the user approves
// and the review of marketplace listings (docs/addons/security.md).
const fs = require('fs');
const path = require('path');
const Module = require('module');

const [, , ADDON_DIR, DATA_DIR, ENTRY] = process.argv;
const ID = process.env.PD_ADDON || 'addon';

/* ---------------------------------------------------------------- safety net */
const BLOCKED = new Set(['net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises', 'child_process', 'cluster', 'worker_threads', 'inspector', 'repl', 'vm', 'v8', 'wasi']);
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const name = String(request).replace(/^node:/, '');
  if (BLOCKED.has(name)) throw new Error(`Addons can't use "${name}". Use the pd API (pd.http, pd.run) and ask for the permission in addon.json.`);
  return realLoad.apply(this, arguments);
};
for (const g of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'WebAssembly']) { try { delete globalThis[g]; } catch {} }
const realBinding = process.binding;
process.binding = function () { throw new Error('process.binding is not available to addons'); };
void realBinding;

/* ---------------------------------------------------------------- talking to PhoneDesk */
let nextId = 1;
const waiting = new Map();
function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    process.send({ op: 'rpc', id, method, args });
  });
}

const handlers = { screen: [], event: {}, action: {}, settings: [], stop: [] };
const logger = (level) => (...a) => process.send({ op: 'log', level, msg: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') });

/* ---------------------------------------------------------------- storage: a small JSON file in the data folder */
const STORE = path.join(DATA_DIR, 'storage.json');
let store = {};
try { store = JSON.parse(fs.readFileSync(STORE, 'utf8')) || {}; } catch {}
let saveTimer = null;
function flushStore() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const text = JSON.stringify(store);
    if (text.length > 1024 * 1024) return logger('warn')('storage is over 1 MB; not saved');
    fs.writeFileSync(STORE + '.tmp', text);
    fs.renameSync(STORE + '.tmp', STORE);
  } catch (e) { logger('error')('could not save storage: ' + e.message); }
}
function saveStore() { clearTimeout(saveTimer); saveTimer = setTimeout(flushStore, 300); }

/* ---------------------------------------------------------------- the pd object */
let settings = {};
const pd = {
  id: ID,
  version: '',
  log: { info: logger('info'), warn: logger('warn'), error: logger('error') },
  settings: { all: () => Object.assign({}, settings), get: (k, d) => (settings[k] === undefined ? d : settings[k]) },
  storage: {
    get: (k, d) => (store[k] === undefined ? d : store[k]),
    set: (k, v) => { store[String(k)] = v; saveStore(); },
    delete: (k) => { delete store[k]; saveStore(); },
    all: () => JSON.parse(JSON.stringify(store)),
  },
  // The screen (and widgets) on the phone: send(data) reaches every frame of this addon's PD.on('message');
  // on(fn) gets PD.send(data) from them, with { widget: id } as the second argument when it came from a widget.
  screen: { send: (data) => process.send({ op: 'screen', data }), on: (fn) => { handlers.screen.push(fn); } },
  // 'media' | 'volume' | 'stats' (need those permissions), 'settings', 'stop'
  on(name, fn) {
    if (name === 'settings') handlers.settings.push(fn);
    else if (name === 'stop') handlers.stop.push(fn);
    else (handlers.event[name] = handlers.event[name] || []).push(fn);
  },
  action: (id, fn) => { handlers.action[id] = fn; },
  http: {
    request: (o) => call('http.request', o),
    get: (url, o) => call('http.request', Object.assign({}, o, { url, method: 'GET' })),
    async json(url, o) { const r = await call('http.request', Object.assign({}, o, { url, method: (o && o.method) || 'GET' })); if (!r.ok) throw new Error('HTTP ' + r.status); return JSON.parse(r.text); },
  },
  media: { get: () => call('media.get'), command: (c) => call('media.command', c) },
  volume: { get: () => call('volume.get'), set: (v) => call('volume.set', v) },
  stats: { get: () => call('stats.get') },
  keys: { send: (combo) => call('keys.send', combo) },
  run: { exec: (file, args) => call('run.exec', file, args) },
};

function safely(fn, ...a) {
  try { const r = fn(...a); if (r && typeof r.catch === 'function') r.catch((e) => logger('error')(String(e && e.message || e))); } catch (e) { logger('error')(String(e && e.message || e)); }
}

process.on('uncaughtException', (e) => logger('error')('uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => logger('error')('unhandled rejection: ' + (e && e.stack || e)));

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  switch (m.op) {
    case 'start': {
      pd.version = m.version || '';
      settings = m.settings || {};
      try {
        const mod = require(path.join(ADDON_DIR, ...ENTRY.split('/')));
        const fn = typeof mod === 'function' ? mod : (mod && typeof mod.default === 'function' ? mod.default : null);
        if (fn) safely(fn, pd);
      } catch (e) { logger('error')('could not start: ' + (e && e.stack || e)); process.exit(1); }
      return;
    }
    case 'ping': process.send({ op: 'pong', t: m.t }); return;
    case 'rpcResult': {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.ok) w.resolve(m.value); else w.reject(new Error(m.value));
      return;
    }
    case 'screenMessage': handlers.screen.forEach((fn) => safely(fn, m.data, m.widget ? { widget: m.widget } : {})); return;
    case 'event': (handlers.event[m.name] || []).forEach((fn) => safely(fn, m.data)); return;
    case 'action': if (handlers.action[m.id]) safely(handlers.action[m.id]); return;
    case 'settings': settings = m.values || {}; handlers.settings.forEach((fn) => safely(fn, pd.settings.all())); return;
    case 'stop': handlers.stop.forEach((fn) => safely(fn)); if (saveTimer) flushStore(); setTimeout(() => process.exit(0), 100); return;
  }
});
process.on('disconnect', () => { if (saveTimer) flushStore(); process.exit(0); }); // PhoneDesk went away
