'use strict';
// Pages and widgets: what a page may hold, and how it is cleaned up.   node test/widgets.test.js
const assert = require('assert');
process.env.PHONEDESK_DATA = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'pd-wid-'));
const w = require('../server/widgets');

let failed = false;
function t(name, fn) { try { fn(); console.log('ok   ' + name); } catch (e) { failed = true; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); } }

t('a page keeps valid widgets and fills in the options', () => {
  const [p] = w.sanitizePages([{ name: 'Mine', widgets: [{ type: 'clock', x: 0, y: 0, w: 4, h: 2 }, { type: 'text', x: 4, y: 0, w: 2, h: 1, opts: { text: 'Hi', size: 'huge', evil: 'x' } }] }]);
  assert.strictEqual(p.name, 'Mine');
  assert.match(p.id, /^pg-[a-z0-9]{4,12}$/);
  assert.deepStrictEqual(p.widgets[0].opts, { face: 'digital', date: true, seconds: false });
  assert.deepStrictEqual(p.widgets[1].opts, { text: 'Hi', size: 'huge', align: 'center' }); // unknown keys dropped, defaults added
});
t('unknown widget types are dropped, addon types are kept', () => {
  const [p] = w.sanitizePages([{ widgets: [{ type: 'bogus', x: 0, y: 0, w: 2, h: 2 }, { type: 'addon:pomodoro:timer', x: 0, y: 0, w: 3, h: 2, opts: { minutes: 25, nested: { a: 1 } } }] }]);
  assert.strictEqual(p.widgets.length, 1);
  assert.strictEqual(p.widgets[0].type, 'addon:pomodoro:timer');
  assert.deepStrictEqual(p.widgets[0].opts, { minutes: 25 }); // an unknown addon widget keeps plain values only
});
t('sizes and places stay inside the grid and above the minimum', () => {
  const [p] = w.sanitizePages([{ widgets: [{ type: 'agenda', x: 50, y: 50, w: 99, h: 0 }] }]);
  const x = p.widgets[0];
  assert.ok(x.x >= 0 && x.x + x.w <= w.GRID.cols && x.y >= 0 && x.y + x.h <= w.GRID.rows);
  assert.ok(x.w <= w.GRID.cols && x.h >= w.WIDGETS.agenda.minH);
});
t('overlapping widgets move to a free spot, or are dropped when there is none', () => {
  const [p] = w.sanitizePages([{ widgets: [{ type: 'clock', x: 0, y: 0, w: 6, h: 3 }, { type: 'weather', x: 2, y: 1, w: 3, h: 2 }] }]);
  assert.strictEqual(p.widgets.length, 2);
  assert.ok(!w.overlaps(p.widgets[0], p.widgets[1]));
  const full = [{ type: 'text', x: 0, y: 0, w: 12, h: 6 }, { type: 'text', x: 0, y: 0, w: 2, h: 2 }];
  assert.strictEqual(w.sanitizePages([{ widgets: full }])[0].widgets.length, 1);
});
t('limits: pages, widgets, names, ids', () => {
  assert.strictEqual(w.sanitizePages(Array.from({ length: 30 }, () => ({ widgets: [] }))).length, w.LIMITS.pages);
  const many = Array.from({ length: 60 }, (_, i) => ({ type: 'text', x: i % 12, y: Math.floor(i / 12) % 6, w: 1, h: 1 }));
  assert.ok(w.sanitizePages([{ widgets: many }])[0].widgets.length <= w.LIMITS.widgets);
  const pages = w.sanitizePages([{ id: 'pg-same1234', name: 'x'.repeat(80), widgets: [] }, { id: 'pg-same1234', widgets: [] }]);
  assert.notStrictEqual(pages[0].id, pages[1].id);
  assert.strictEqual(pages[0].name.length, 24);
  assert.deepStrictEqual(w.sanitizePages('nope'), []);
});
t('every template makes a valid page with all its widgets', () => {
  for (const k of Object.keys(w.TEMPLATES)) {
    const p = w.fromTemplate(k);
    assert.strictEqual(p.widgets.length, w.TEMPLATES[k].widgets.length, k);
    p.widgets.forEach((x, i) => p.widgets.slice(i + 1).forEach((y) => assert.ok(!w.overlaps(x, y), k + ' overlaps')));
  }
});
t('addon widget sizes and options come from the addon when it is known', () => {
  w.setAddonLookup((a, id) => (a === 'pomodoro' && id === 'timer' ? { minW: 3, minH: 2, defW: 4, defH: 3, opts: [{ key: 'minutes', type: 'number', min: 1, max: 90, default: 25 }] } : null));
  const [p] = w.sanitizePages([{ widgets: [{ type: 'addon:pomodoro:timer', x: 0, y: 0, w: 1, h: 1, opts: { minutes: 500, junk: 1 } }] }]);
  assert.strictEqual(p.widgets[0].w, 3);
  assert.strictEqual(p.widgets[0].h, 2);
  assert.deepStrictEqual(p.widgets[0].opts, { minutes: 90 });
  w.setAddonLookup(null);
});
t('a built-in screen becomes a page with the same widgets, following the settings', () => {
  const clock = w.fromBuiltin('clock', { clockFace: 'analog', weather: true, clockForecast: true, calendarUrl: 'https://x.example/cal.ics' });
  assert.deepStrictEqual(clock.widgets.map((x) => x.type).sort(), ['agenda', 'clock', 'forecast', 'weather']);
  assert.strictEqual(clock.widgets.find((x) => x.type === 'clock').opts.face, 'analog');
  const big = w.fromBuiltin('clock', { clockFace: 'big' });
  assert.deepStrictEqual(big.widgets.map((x) => x.type), ['clock']);
  assert.strictEqual(big.widgets[0].w, 12);
  const noCal = w.fromBuiltin('clock', { clockFace: 'digital', weather: true, clockForecast: false });
  assert.deepStrictEqual(noCal.widgets.map((x) => x.type).sort(), ['clock', 'weather']);
  assert.deepStrictEqual(w.fromBuiltin('stats').widgets.map((x) => x.opts.metric), ['cpu', 'memory', 'gpu', 'network']);
  assert.strictEqual(w.fromBuiltin('shortcuts').widgets[0].type, 'shortcuts');
  assert.deepStrictEqual(w.fromBuiltin('media').widgets.map((x) => x.type), ['nowplaying', 'volume']);
  assert.strictEqual(w.fromBuiltin('mixer'), null);
  assert.strictEqual(w.fromBuiltin('lyrics'), null);
});
t('the config keeps pages, and a page that is gone leaves the swipe row', () => {
  const config = require('../server/config');
  const c = config.update({ pages: [{ id: 'pg-keep1234', name: 'Kept', widgets: [{ type: 'clock', x: 0, y: 0, w: 4, h: 2 }] }], screens: ['media', 'page:pg-keep1234', 'page:pg-gone1234'] });
  assert.deepStrictEqual(c.screens, ['media', 'page:pg-keep1234']);
  assert.strictEqual(c.pages.length, 1);
  const c2 = config.update({ pages: [] });
  assert.ok(!c2.screens.some((s) => s.startsWith('page:')));
});
require('fs').rmSync(process.env.PHONEDESK_DATA, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
t('a tap action, a page background and an accent are kept only when valid', () => {
  const [p] = w.sanitizePages([{ name: 'P', bg: 'aurora', accent: '#FFAA00', widgets: [
    { type: 'text', x: 0, y: 0, w: 2, h: 1, tap: 'screen:stats' },
    { type: 'text', x: 2, y: 0, w: 2, h: 1, tap: 'shortcut:abc123' },
    { type: 'text', x: 4, y: 0, w: 2, h: 1, tap: 'media:toggle' },
    { type: 'text', x: 6, y: 0, w: 2, h: 1, tap: 'javascript:alert(1)' },
    { type: 'addon:pomodoro:timer', x: 8, y: 0, w: 2, h: 1, tap: 'screen:media' },
  ] }]);
  assert.strictEqual(p.bg, 'aurora');
  assert.strictEqual(p.accent, '#ffaa00');
  assert.deepStrictEqual(p.widgets.map((x) => x.tap), ['screen:stats', 'shortcut:abc123', 'media:toggle', undefined, undefined]);
  const [q] = w.sanitizePages([{ bg: 'neon', accent: 'red', widgets: [] }]);
  assert.ok(!('bg' in q) && !('accent' in q));
});
