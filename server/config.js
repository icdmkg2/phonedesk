'use strict';
// Config lives in data/config.json. Writes are atomic (tmp + rename) so a crash can't corrupt it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./log');

const DIR = require('./paths').DATA;
const FILE = path.join(DIR, 'config.json');

const DEFAULTS = {
  port: 8765,
  port80: true,
  artLookup: true,
  showBattery: true,
  ignoreApps: ['discord'],
  weather: true,
  weatherCity: '',
  weatherUnit: 'c',
  notifications: true,
  notifyPrivate: false,
  notifyIgnore: [],
  spotifyClientId: '',
  updateRepo: '',
  autoUpdate: true,
  onboarded: false,
  name: 'phonedesk',
  autoUsb: true,
  clock24: true,
  theme: 'dark',
  accent: 'auto',
  dimAfter: 0,
  nowStyle: 'immersive',
  screens: ['media', 'lyrics', 'mixer', 'clock', 'stats', 'shortcuts'],
  shortcuts: [
    { id: 'mute-mic', label: 'Mute mic', type: 'keys', value: 'ctrl+shift+m', icon: 'mic', color: '#e5484d' },
    { id: 'desktop', label: 'Show desktop', type: 'keys', value: 'win+d', icon: 'desktop', color: '#3e63dd' },
    { id: 'lock', label: 'Lock PC', type: 'keys', value: 'win+l', icon: 'lock', color: '#8e4ec6' },
    { id: 'screenshot', label: 'Screenshot', type: 'keys', value: 'win+shift+s', icon: 'camera', color: '#12a594' },
    { id: 'spotify', label: 'Spotify', type: 'url', value: 'spotify:', icon: 'music', color: '#1db954' },
    { id: 'youtube', label: 'YouTube', type: 'url', value: 'https://youtube.com', icon: 'play', color: '#e5484d' },
    { id: 'taskmgr', label: 'Task Manager', type: 'keys', value: 'ctrl+shift+esc', icon: 'chart', color: '#f76b15' },
    { id: 'explorer', label: 'Files', type: 'keys', value: 'win+e', icon: 'folder', color: '#ffb224' },
  ],
};

const SCREENS = ['media', 'lyrics', 'mixer', 'clock', 'stats', 'shortcuts'];
const TYPES = ['keys', 'url', 'app'];

let current = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // An existing install has already been set up: don't show first-run setup again.
    if (raw.onboarded === undefined) raw.onboarded = true;
    return sanitize({ ...DEFAULTS, ...raw });
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log.warn('config.json was unreadable, starting from defaults (old file kept as config.bad.json)');
      try { fs.copyFileSync(FILE, path.join(DIR, 'config.bad.json')); } catch {}
    }
    const c = sanitize({ ...DEFAULTS });
    save(c);
    return c;
  }
}

function sanitize(c) {
  const out = {};
  out.port = Number.isInteger(+c.port) && +c.port > 0 && +c.port < 65536 ? +c.port : DEFAULTS.port;
  out.port80 = c.port80 !== false;
  out.artLookup = c.artLookup !== false;
  out.showBattery = c.showBattery !== false;
  // Apps whose sound isn't "now playing" (voice chat). Matched against the app's id, case-insensitive.
  out.ignoreApps = (Array.isArray(c.ignoreApps) ? c.ignoreApps : ['discord'])
    .map((s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '')).filter(Boolean).slice(0, 20);
  out.name = String(c.name || 'phonedesk').toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'phonedesk';
  out.autoUsb = c.autoUsb !== false;
  out.clock24 = c.clock24 !== false;
  out.theme = ['dark', 'black', 'light'].includes(c.theme) ? c.theme : 'dark';
  out.accent = typeof c.accent === 'string' && /^(auto|#[0-9a-f]{6})$/i.test(c.accent) ? c.accent : 'auto';
  out.dimAfter = Math.max(0, Math.min(3600, +c.dimAfter || 0));
  out.nowStyle = c.nowStyle === 'classic' ? 'classic' : 'immersive';
  out.screens = Array.isArray(c.screens) ? c.screens.filter((s) => SCREENS.includes(s)) : DEFAULTS.screens.slice();
  if (!out.screens.length) out.screens = ['media'];
  // Screens added in a newer version show up once for existing users (after Now playing).
  out.knownScreens = Array.isArray(c.knownScreens) ? c.knownScreens.filter((s) => SCREENS.includes(s)) : ['media', 'clock', 'stats', 'shortcuts'];
  let insertAt = Math.min(1, out.screens.length);
  for (const s of SCREENS) {
    if (!out.knownScreens.includes(s)) {
      out.knownScreens.push(s);
      if (!out.screens.includes(s)) out.screens.splice(insertAt++, 0, s);
    }
  }
  out.weather = c.weather !== false;
  out.weatherCity = String(c.weatherCity || '').slice(0, 80);
  out.weatherUnit = c.weatherUnit === 'f' ? 'f' : 'c';
  out.notifications = c.notifications !== false;
  out.notifyPrivate = c.notifyPrivate === true;
  out.notifyIgnore = (Array.isArray(c.notifyIgnore) ? c.notifyIgnore : []).map((s) => String(s).slice(0, 120)).slice(0, 50);
  out.spotifyClientId = /^[a-f0-9]{32}$/i.test(c.spotifyClientId || '') ? c.spotifyClientId : '';
  out.updateRepo = /^[\w.-]+\/[\w.-]+$/.test(c.updateRepo || '') ? c.updateRepo : '';
  out.autoUpdate = c.autoUpdate !== false;
  out.onboarded = c.onboarded === true;
  out.shortcuts = (Array.isArray(c.shortcuts) ? c.shortcuts : []).slice(0, 24).map((s) => ({
    id: typeof s.id === 'string' && s.id ? s.id.slice(0, 40) : crypto.randomBytes(4).toString('hex'),
    label: String(s.label || 'Shortcut').slice(0, 40),
    type: TYPES.includes(s.type) ? s.type : 'keys',
    value: String(s.value || '').slice(0, 500),
    icon: String(s.icon || 'bolt').slice(0, 20),
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#3e63dd',
  }));
  return out;
}

function save(c) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    log.error('could not save config: ' + e.message);
  }
}

module.exports = {
  get: () => current,
  defaults: () => sanitize({ ...DEFAULTS }),
  update(patch) {
    current = sanitize({ ...current, ...patch });
    save(current);
    return current;
  },
};
