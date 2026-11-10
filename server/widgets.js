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
    name: 'Now playing', desc: 'What is playing, with controls', defW: 5, defH: 3, minW: 3, minH: 2,
    opts: [T('cover', 'Show the cover', 'boolean', { default: true }), T('controls', 'Show the controls', 'boolean', { default: true })],
  },
  stats: {
    name: 'PC stats', desc: 'CPU, memory, GPU or network', defW: 4, defH: 2, minW: 2, minH: 1,
    opts: [T('metric', 'Show', 'select', { options: ['cpu', 'memory', 'gpu', 'network'], default: 'cpu' })],
  },
  volume: { name: 'Volume', desc: 'The PC\'s volume, with a slider', defW: 4, defH: 1, minW: 3, minH: 1, opts: [] },
  shortcuts: {
    name: 'Shortcut buttons', desc: 'Your shortcut buttons, or one group of them', defW: 6, defH: 3, minW: 2, minH: 1,
    opts: [T('group', 'Group (empty: all buttons)', 'text', { default: '', placeholder: 'Audio' })],
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
    grid: GRID, limits: LIMITS, backgrounds: BACKGROUNDS.filter(Boolean), builtin: Object.keys(BUILTIN_NAMES),
    types: Object.entries(WIDGETS).map(([type, d]) => Object.assign({ type }, d)),
    templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, name: t.name, desc: t.desc, count: t.widgets.length })),
  };
}

module.exports = { BUILTIN_NAMES, fromBuiltin, GRID, LIMITS, WIDGETS, TEMPLATES, ADDON_TYPE, setAddonLookup, describe, sanitizePages, fromTemplate, catalog, findFree, overlaps, cleanOpts };
