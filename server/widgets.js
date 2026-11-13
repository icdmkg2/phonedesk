'use strict';
// Pages and widgets: you build a page by placing widgets on a grid, and the page joins the phone's swipe row.
//
//   page    { id: 'pg-ab12cd34', name, widgets: [ widget ] }
//   widget  { id, type, x, y, w, h, opts }   (grid cells: 12 across, 6 down)
//   type    a built-in one below, or 'addon:<addonId>:<widgetId>' for a widget an addon provides
//
// This file only describes and checks the data (no dependencies), so the server, the dashboard's editor and the
// tests agree on what a page can hold. Drawing the widgets is done on the phone (public/phone/app.js).
const crypto = require('crypto');

const GRID = { cols: 12, rows: 6 };
const LIMITS = { pages: 12, widgets: 24 };
/** What a tap on a widget can do: open a screen, press a shortcut button, or control the music. */
const TAP = /^(screen:[a-z0-9:_-]{1,60}|shortcut:[\w-]{1,40}|media:(toggle|next|prev))$/;
/** Page backgrounds the phone can draw (empty: the normal one). */
const BACKGROUNDS = ['', 'black', 'aurora', 'dusk', 'forest', 'slate'];
/** How a widget is drawn: '' a card (the default), 'clear' no card at all, 'outline' only a border. */
const LOOKS = ['', 'clear', 'outline'];
/** How round a page's corners are ('' the theme's). */
const RADII = ['', 'none', 'small', 'large'];

const T = (key, label, type, o) => Object.assign({ key, label, type }, o);
/** Built-in widgets. opts use the same field types as addon settings: text, number, boolean, select. */
const WIDGETS = {
  clock: {
    name: 'Clock', desc: 'The time, as digits or a clock face', defW: 6, defH: 3, minW: 2, minH: 1,
    opts: [T('face', 'Face', 'select', { options: ['digital', 'analog', 'big'], default: 'digital' }), T('date', 'Show the date', 'boolean', { default: true }), T('seconds', 'Show seconds', 'boolean', { default: false })],
  },
  weather: { name: 'Weather', desc: 'Current conditions and the high and low', defW: 3, defH: 2, minW: 2, minH: 1, opts: [] },
  forecast: { name: '5-day forecast', desc: 'The next five days', defW: 6, defH: 2, minW: 4, minH: 1, opts: [] },
  agenda: { name: 'Calendar agenda', desc: 'Your next events', defW: 4, defH: 4, minW: 3, minH: 2, opts: [T('count', 'Events to show', 'number', { default: 4, min: 1, max: 8 })] },
  nowplaying: {
    name: 'Now playing', desc: 'What is playing: cover, source, title, progress and controls', defW: 5, defH: 3, minW: 2, minH: 1,
    opts: [T('cover', 'Show the cover', 'boolean', { default: true }), T('source', 'Show the app it plays in', 'boolean', { default: true }), T('progress', 'Show the progress bar', 'boolean', { default: true }), T('controls', 'Show the controls', 'boolean', { default: true }), T('upnext', 'Show what plays next (Spotify)', 'boolean', { default: true })],
  },
  lyrics: {
    name: 'Lyrics', desc: 'The line being sung, with the lines around it', defW: 6, defH: 3, minW: 3, minH: 1,
    opts: [T('context', 'Show the lines before and after', 'boolean', { default: true }), T('words', 'Light up the words as they are sung', 'boolean', { default: true }), T('align', 'Align', 'select', { options: ['left', 'center'], default: 'center' })],
  },
  stats: {
    name: 'PC stats', desc: 'CPU, memory, GPU, network, disks and the busiest apps, with graphs', defW: 6, defH: 3, minW: 2, minH: 1,
    opts: [T('metric', 'Show', 'select', { options: ['all', 'cpu', 'memory', 'gpu', 'network', 'disks', 'apps'], default: 'all' }), T('graph', 'Show graphs', 'boolean', { default: true })],
  },
  volume: { name: 'Volume', desc: 'The PC\'s volume, with a slider', defW: 4, defH: 1, minW: 3, minH: 1, opts: [] },
  shortcuts: {
    name: 'Shortcut buttons', desc: 'Your shortcut buttons, or one group of them', defW: 6, defH: 3, minW: 2, minH: 1,
    opts: [T('group', 'Group (empty: all buttons)', 'text', { default: '', placeholder: 'Audio' })],
  },
  worldclock: {
    name: 'World clock', desc: 'The time in up to four places', defW: 6, defH: 2, minW: 2, minH: 1,
    opts: [T('zones', 'Places (Name=Time/Zone; …)', 'text', { default: 'London=Europe/London; New York=America/New_York; Tokyo=Asia/Tokyo', placeholder: 'London=Europe/London; Tokyo=Asia/Tokyo' }), T('hour12', '12-hour clock', 'boolean', { default: false })],
  },
  timer: {
    name: 'Timer', desc: 'A countdown or a stopwatch you start with a tap', defW: 4, defH: 2, minW: 2, minH: 1,
    opts: [T('mode', 'Kind', 'select', { options: ['timer', 'stopwatch'], default: 'timer' }), T('minutes', 'Minutes (timer)', 'number', { default: 5, min: 1, max: 600 })],
  },
  notes: {
    name: 'Notes', desc: 'Your notes and to-dos (written in the PC window); tap one to tick it off', defW: 4, defH: 4, minW: 2, minH: 1,
    opts: [T('title', 'Title', 'text', { default: 'To do' }), T('hideDone', 'Hide what is done', 'boolean', { default: false })],
  },
  photos: {
    name: 'Photo frame', desc: 'Pictures from a folder on your PC, one after another', defW: 6, defH: 4, minW: 2, minH: 2,
    opts: [T('interval', 'Seconds per picture', 'number', { default: 30, min: 5, max: 3600 }), T('fit', 'Fit', 'select', { options: ['fill', 'whole picture'], default: 'fill' }), T('shuffle', 'Shuffle', 'boolean', { default: true })],
  },
  recent: {
    name: 'Recently played', desc: 'The songs played lately on the PC', defW: 4, defH: 3, minW: 2, minH: 1,
    opts: [T('count', 'Songs to show', 'number', { default: 5, min: 1, max: 20 })],
  },
  devices: {
    name: 'Bluetooth devices', desc: 'Every Bluetooth device connected to the PC (headphones, mouse, keyboard, controller...) with its battery when it reports one', defW: 5, defH: 2, minW: 2, minH: 1,
    opts: [T('onlyBattery', 'Only devices that report a battery', 'boolean', { default: false })],
  },
  text: {
    name: 'Text', desc: 'A line or two of your own text', defW: 4, defH: 2, minW: 1, minH: 1,
    opts: [T('text', 'Text', 'text', { default: 'Hello' }), T('size', 'Size', 'select', { options: ['small', 'medium', 'large', 'huge'], default: 'large' }), T('align', 'Align', 'select', { options: ['left', 'center', 'right'], default: 'center' })],
  },
};

/** Ready-made pages to start from. */
const TEMPLATES = {
  clock: {
    name: 'Clock layout', desc: 'A clock with weather, the forecast and your calendar',
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 7, h: 4, opts: { face: 'digital', date: true } },
      { type: 'weather', x: 7, y: 0, w: 5, h: 2 },
      { type: 'agenda', x: 7, y: 2, w: 5, h: 4, opts: { count: 4 } },
      { type: 'forecast', x: 0, y: 4, w: 7, h: 2 },
    ],
  },
  desk: {
    name: 'Desk overview', desc: 'Now playing, the clock, PC stats and shortcut buttons',
    widgets: [
      { type: 'nowplaying', x: 0, y: 0, w: 6, h: 3 },
      { type: 'clock', x: 6, y: 0, w: 6, h: 2, opts: { face: 'digital', date: true } },
      { type: 'stats', x: 6, y: 2, w: 3, h: 2, opts: { metric: 'cpu' } },
      { type: 'stats', x: 9, y: 2, w: 3, h: 2, opts: { metric: 'memory' } },
      { type: 'shortcuts', x: 0, y: 3, w: 6, h: 3 },
      { type: 'volume', x: 6, y: 4, w: 6, h: 2 },
    ],
  },
  music: {
    name: 'Music', desc: 'Now playing next to the lyrics, with the volume',
    widgets: [
      { type: 'nowplaying', x: 0, y: 0, w: 5, h: 5 },
      { type: 'lyrics', x: 5, y: 0, w: 7, h: 5 },
      { type: 'volume', x: 0, y: 5, w: 12, h: 1 },
    ],
  },
  blank: { name: 'Blank page', desc: 'Start from nothing and add widgets', widgets: [] },
};

/* ---------------------------------------------------------------- addon widgets */
let lookupAddon = () => null; // (addonId, widgetId) -> { minW, minH, defW, defH, opts } | null, set by the server
function setAddonLookup(fn) { lookupAddon = typeof fn === 'function' ? fn : () => null; }

const ADDON_TYPE = /^addon:([a-z0-9][a-z0-9-]{1,39}):([a-z][a-z0-9-]{0,29})$/;
/** The description of a widget type (built-in or from an addon), or null. */
function describe(type) {
  if (WIDGETS[type]) return WIDGETS[type];
  const m = ADDON_TYPE.exec(String(type));
  return m ? lookupAddon(m[1], m[2]) : null;
}
function isKnownShape(type) { return !!WIDGETS[type] || ADDON_TYPE.test(String(type)); }

/* ---------------------------------------------------------------- checking */
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const rid = (prefix) => prefix + crypto.randomBytes(4).toString('hex');

/** Options for one widget: only the keys its description knows, each coerced to its type. */
function cleanOpts(desc, opts) {
  const src = opts && typeof opts === 'object' ? opts : {};
  const out = {};
  for (const f of (desc && desc.opts) || []) {
    let v = src[f.key];
    if (v === undefined) v = f.default;
    if (f.type === 'boolean') v = v === undefined ? false : !!v;
    else if (f.type === 'number') v = Math.min(f.max != null ? f.max : 1e6, Math.max(f.min != null ? f.min : -1e6, Number.isFinite(+v) ? +v : (f.default || 0)));
    else if (f.type === 'select') v = (f.options || []).includes(v) ? v : (f.default !== undefined ? f.default : (f.options || [])[0] || '');
    else if (f.type === 'password') v = '';
    else v = typeof v === 'string' ? v.slice(0, 200) : (f.default || '');
    out[f.key] = v;
  }
  return out;
}

/** Options of a widget we know nothing about (its addon is not installed, or has not started yet): keep plain values. */
function rawOpts(opts) {
  const out = {};
  if (opts && typeof opts === 'object') for (const k of Object.keys(opts).slice(0, 20)) if (/^[a-zA-Z][a-zA-Z0-9]{0,29}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof opts[k])) out[k] = typeof opts[k] === 'string' ? opts[k].slice(0, 200) : opts[k];
  return out;
}
function overlaps(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
/** The first free spot (top to bottom, left to right) for a w x h widget among the others, or null. */
function findFree(widgets, w, h) {
  for (let y = 0; y + h <= GRID.rows; y++) for (let x = 0; x + w <= GRID.cols; x++) if (!widgets.some((o) => overlaps({ x, y, w, h }, o))) return { x, y };
  return null;
}

/**
 * Anything -> a valid list of pages. Unknown built-in widget types are dropped; sizes and places are kept inside
 * the grid; a widget that would sit on top of an earlier one moves to the first free spot (or is dropped if none).
 */
function sanitizePages(list) {
  const out = [], seen = new Set();
  for (const p of (Array.isArray(list) ? list : []).slice(0, LIMITS.pages)) {
    if (!p || typeof p !== 'object') continue;
    let id = /^pg-[a-z0-9]{4,12}$/.test(p.id || '') ? p.id : rid('pg-');
    while (seen.has(id)) id = rid('pg-');
    seen.add(id);
    const widgets = [], ids = new Set();
    for (const w of (Array.isArray(p.widgets) ? p.widgets : []).slice(0, LIMITS.widgets)) {
      if (!w || typeof w !== 'object' || !isKnownShape(w.type)) continue;
      const desc = describe(w.type);
      const minW = (desc && desc.minW) || 1, minH = (desc && desc.minH) || 1;
      const cw = int(w.w, minW, GRID.cols, (desc && desc.defW) || 3), ch = int(w.h, minH, GRID.rows, (desc && desc.defH) || 2);
      const item = { id: /^w[a-z0-9]{4,10}$/.test(w.id || '') && !ids.has(w.id) ? w.id : rid('w'), type: w.type, x: int(w.x, 0, GRID.cols - cw, 0), y: int(w.y, 0, GRID.rows - ch, 0), w: cw, h: ch, opts: desc ? cleanOpts(desc, w.opts) : rawOpts(w.opts) };
      if (typeof w.tap === 'string' && TAP.test(w.tap) && !ADDON_TYPE.test(String(w.type))) item.tap = w.tap; // addon widgets are frames: they handle their own taps
      if (typeof w.hold === 'string' && TAP.test(w.hold) && !ADDON_TYPE.test(String(w.type))) item.hold = w.hold; // a long press
      if (LOOKS.includes(w.look) && w.look) item.look = w.look;
      if (widgets.some((o) => overlaps(item, o))) {
        const spot = findFree(widgets, item.w, item.h);
        if (!spot) continue;
        item.x = spot.x; item.y = spot.y;
      }
      ids.add(item.id);
      widgets.push(item);
    }
    const page = { id, name: String(p.name || '').trim().slice(0, 24) || 'Page', widgets };
    if (BACKGROUNDS.includes(p.bg) && p.bg) page.bg = p.bg;
    if (/^#[0-9a-f]{6}$/i.test(p.accent || '')) page.accent = p.accent.toLowerCase();
    if (RADII.includes(p.radius) && p.radius) page.radius = p.radius;
    out.push(page);
  }
  return out;
}

/** A new page from a template: fresh ids, checked like any other page. */
function fromTemplate(key, name) {
  const t = TEMPLATES[key] || TEMPLATES.blank;
  return sanitizePages([{ name: name || t.name, widgets: t.widgets.map((w) => Object.assign({}, w)) }])[0];
}

/* ---------------------------------------------------------------- the built-in screens as pages */
const BUILTIN_NAMES = { media: 'Now playing', clock: 'Clock', stats: 'PC stats', shortcuts: 'Shortcuts' };
/**
 * A page that looks like a built-in screen (using the person's current settings), so the screen can be customized
 * like any page. null for screens that are not made of widgets (the volume mixer, lyrics).
 */
function fromBuiltin(screen, cfg) {
  cfg = cfg || {};
  let ws;
  if (screen === 'clock') {
    const face = ['digital', 'analog', 'big'].includes(cfg.clockFace) ? cfg.clockFace : 'digital', big = face === 'big';
    const weather = !big && cfg.weather !== false, agenda = !big && !!cfg.calendarUrl, forecast = !big && cfg.clockForecast !== false && cfg.weather !== false;
    const right = weather || agenda, cw = right ? 7 : 12, ch = forecast ? 4 : 6;
    ws = [{ type: 'clock', x: 0, y: 0, w: cw, h: ch, opts: { face, date: !big, seconds: false } }];
    if (forecast) ws.push({ type: 'forecast', x: 0, y: 4, w: cw, h: 2 });
    if (weather) ws.push({ type: 'weather', x: 7, y: 0, w: 5, h: agenda ? 2 : 4 });
    if (agenda) ws.push({ type: 'agenda', x: 7, y: weather ? 2 : 0, w: 5, h: weather ? 4 : 6, opts: { count: 5 } });
  } else if (screen === 'stats') {
    ws = ['cpu', 'memory', 'gpu', 'network'].map((m, i) => ({ type: 'stats', x: (i % 2) * 6, y: Math.floor(i / 2) * 3, w: 6, h: 3, opts: { metric: m } }));
  } else if (screen === 'shortcuts') {
    ws = [{ type: 'shortcuts', x: 0, y: 0, w: 12, h: 6, opts: { group: '' } }];
  } else if (screen === 'media') {
    ws = [{ type: 'nowplaying', x: 0, y: 0, w: 12, h: 5, opts: { cover: true, controls: true } }, { type: 'volume', x: 0, y: 5, w: 12, h: 1 }];
  } else return null;
  return sanitizePages([{ name: BUILTIN_NAMES[screen] + ' (custom)', widgets: ws }])[0];
}

/** What the dashboard's editor needs: the built-in types and the templates. */
function catalog() {
  return {
    grid: GRID, limits: LIMITS, backgrounds: BACKGROUNDS.filter(Boolean), looks: LOOKS.filter(Boolean), radii: RADII.filter(Boolean), builtin: Object.keys(BUILTIN_NAMES),
    types: Object.entries(WIDGETS).map(([type, d]) => Object.assign({ type }, d)),
    templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, name: t.name, desc: t.desc, count: t.widgets.length })),
  };
}

module.exports = { BUILTIN_NAMES, fromBuiltin, GRID, LIMITS, WIDGETS, TEMPLATES, ADDON_TYPE, setAddonLookup, describe, sanitizePages, fromTemplate, catalog, findFree, overlaps, cleanOpts };
