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
  updateRepo: 'icdmkg2/phonedesk', // official releases; an empty field falls back to this
  autoUpdate: true,
  onboarded: false,
  name: 'phonedesk',
  autoUsb: true,
  clock24: true,
  theme: 'dark',
  accent: 'auto',
  dimAfter: 0,
  nowStyle: 'immersive',
  lyricsMode: 'scroll',
  lyricsFont: 'serif',
  spicyKey: '',
  lyricsOffset: 0,
  lyricsLines: 'off',
  clockFace: 'digital',        // 'digital' | 'analog' | 'big'
  clockForecast: true,         // 5-day forecast under the clock
  calendarUrl: '',             // private iCal address (secret: never sent to phones)
  nightMode: 'off',            // 'off' | 'schedule' | 'sensor' (phone app's light sensor)
  nightFrom: '22:00',
  nightTo: '07:00',
  nightRed: true,              // red clock at night (easier on the eyes)
  nightClock: true,            // switch to the clock screen at night
  burnIn: true,                // shift the picture a few pixels now and then
  seenVersion: '',             // notes of this version were shown (What's new)
  screens: ['media', 'lyrics', 'mixer', 'clock', 'stats', 'shortcuts'],
  shortcuts: [
    { id: 'mute-mic', label: 'Mute mic', type: 'keys', value: 'ctrl+shift+m', icon: 'mic', color: '#e5484d', group: 'Audio', live: '' },
    { id: 'spotify', label: 'Spotify', type: 'url', value: 'spotify:', icon: 'music', color: '#1db954', group: 'Audio', live: 'media' },
    { id: 'desktop', label: 'Show desktop', type: 'keys', value: 'win+d', icon: 'desktop', color: '#3e63dd', group: 'System', live: '' },
    { id: 'lock', label: 'Lock PC', type: 'keys', value: 'win+l', icon: 'lock', color: '#8e4ec6', group: 'System', live: '' },
    { id: 'screenshot', label: 'Screenshot', type: 'keys', value: 'win+shift+s', icon: 'camera', color: '#12a594', group: 'System', live: '' },
    { id: 'taskmgr', label: 'Task Manager', type: 'keys', value: 'ctrl+shift+esc', icon: 'chart', color: '#f76b15', group: 'System', live: '' },
    { id: 'youtube', label: 'YouTube', type: 'url', value: 'https://youtube.com', icon: 'play', color: '#e5484d', group: 'Apps', live: '' },
    { id: 'explorer', label: 'Files', type: 'keys', value: 'win+e', icon: 'folder', color: '#ffb224', group: 'Apps', live: '' },
  ],
};

const SCREENS = ['media', 'lyrics', 'mixer', 'clock', 'stats', 'shortcuts'];
const TYPES = ['keys', 'url', 'app'];
const LIVE = ['', 'media', 'sound']; // what a button shows under its label: nothing, the playing track, or whether the PC's sound is muted

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
  out.lyricsMode = ['scroll', 'kinetic', 'kinetic-dark'].includes(c.lyricsMode) ? c.lyricsMode : 'scroll';
  out.lyricsOffset = Math.max(-2000, Math.min(2000, Math.round(+c.lyricsOffset || 0)));
  out.clockFace = ['digital', 'analog', 'big'].includes(c.clockFace) ? c.clockFace : 'digital';
  out.clockForecast = c.clockForecast !== false;
  out.calendarUrl = /^(https?|webcal):\/\/\S{4,1000}$/i.test(String(c.calendarUrl || '').trim()) ? String(c.calendarUrl).trim() : '';
  out.nightMode = ['off', 'schedule', 'sensor'].includes(c.nightMode) ? c.nightMode : 'off';
  const hm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : d);
  out.nightFrom = hm(c.nightFrom, '22:00');
  out.nightTo = hm(c.nightTo, '07:00');
  out.nightRed = c.nightRed !== false;
  out.nightClock = c.nightClock !== false;
  out.burnIn = c.burnIn !== false;
  out.seenVersion = /^\d+\.\d+\.\d+$/.test(c.seenVersion || '') ? c.seenVersion : '';
  out.lyricsLines = ['off', 'curve', 'straight', 'glass'].includes(c.lyricsLines) ? c.lyricsLines : 'off';
  out.spicyKey = /^sl_[sp]k_[A-Za-z0-9_-]{10,200}$/.test(String(c.spicyKey || '').trim()) ? String(c.spicyKey).trim() : '';
  out.lyricsFont = ['serif', 'sans', 'condensed', 'mono', 'script'].includes(c.lyricsFont) ? c.lyricsFont : 'serif';
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
  out.updateRepo = /^[\w.-]+\/[\w.-]+$/.test(c.updateRepo || '') ? c.updateRepo : DEFAULTS.updateRepo;
  out.autoUpdate = c.autoUpdate !== false;
  out.onboarded = c.onboarded === true;
  out.shortcuts = (Array.isArray(c.shortcuts) ? c.shortcuts : []).slice(0, 24).map((s) => ({
    id: typeof s.id === 'string' && s.id ? s.id.slice(0, 40) : crypto.randomBytes(4).toString('hex'),
    label: String(s.label || 'Shortcut').slice(0, 40),
    type: TYPES.includes(s.type) ? s.type : 'keys',
    value: String(s.value || '').slice(0, 500),
    icon: String(s.icon || 'bolt').slice(0, 20),
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#3e63dd',
    group: String(s.group || '').trim().slice(0, 20),
    live: LIVE.includes(s.live) ? s.live : '',
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
