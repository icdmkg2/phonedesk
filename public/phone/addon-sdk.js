/* PhoneDesk addon SDK (phone side). Include it in your screen:  <script src="/addons/sdk.js"></script>
 *
 * Your screen runs in a sandboxed frame: no network, no storage shared with PhoneDesk, no access to the page around it.
 * This file is the way in and out. Everything is asynchronous messages; there is nothing to configure.
 *
 *   PD.on('ready', fn)      the frame is connected; PD.theme, PD.permissions and PD.id are set
 *   PD.on('message', fn)    data your PC-side code sent with pd.screen.send(data)
 *   PD.on('media', fn)      what is playing (needs the "media" permission); also 'volume', 'stats',
 *                           'weather', 'calendar' and 'notification' (each needs the permission of that name; notifications: "notifications")
 *   PD.on('visible', fn)    true or false: your screen was swiped to or away from
 *   PD.send(data)           data for your PC-side code (its pd.screen.on handler)
 *   PD.widget, PD.options   in a widget: its size in pixels and the options chosen in the layout editor; PD.on('resize', fn) when it changes
 *   PD.media.command(c)     'toggle' | 'play' | 'pause' | 'next' | 'prev'  (needs "control")
 *   PD.volume.set(0..1)     (needs "control")
 *   PD.captureSwipe(true)   keep horizontal swipes for your screen (they normally change the screen)
 *   PD.autoscale(w, h)      a widget: design it in ems for a w x h pixel box; the page font size then follows the
 *                           widget's real size, so everything keeps its proportions and nothing is clipped
 *
 * PhoneDesk's colours arrive as CSS variables on <html>: --bg --fg --fg2 --fg3 --card --line --accent --radius.
 * Keep your content clear of the top --safe-top (44px: battery pill, full-screen button) and bottom --safe-bottom (30px: page dots).
 */
(function () {
  'use strict';
  var handlers = {};
  var last = {};
  var capture = false;
  var PD = window.PD = {
    id: '', permissions: [], theme: {}, visible: false, ready: false,
    widget: null, options: {}, // set when this frame is a widget: { id, instance, w, h } and the options chosen in the layout editor
    on: function (name, fn) {
      (handlers[name] = handlers[name] || []).push(fn);
      if (name === 'ready' && PD.ready) fn();
      else if (last[name] !== undefined && name !== 'message') fn(last[name]); // late listeners still get the current state
    },
    send: function (data) { post('send', data); },
    media: { command: function (c) { post('media', c); } },
    volume: { set: function (v) { post('volume', v); } },
    captureSwipe: function (on) { capture = !!on; },
    autoscale: function (w, h, base) {
      scale = { w: +w || 200, h: +h || 100, base: +base || 14 };
      applyScale();
    },
  };
  var scale = null;
  // Size the root font so that a layout made in ems for scale.w x scale.h fits the frame's real size.
  function applyScale() {
    if (!scale) return;
    var w = (PD.widget && PD.widget.w) || window.innerWidth, h = (PD.widget && PD.widget.h) || window.innerHeight;
    var f = scale.base * Math.min(w / scale.w, h / scale.h);
    document.documentElement.style.fontSize = Math.max(8, Math.min(64, f)).toFixed(2) + 'px';
  }
  window.addEventListener('resize', applyScale);
  function post(t, d) { try { parent.postMessage({ pd: 1, t: t, d: d }, '*'); } catch (e) {} }
  function emit(name, d) { (handlers[name] || []).forEach(function (fn) { try { fn(d); } catch (e) { if (window.console) console.error(e); } }); }

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.pd !== 1) return;
    if (m.t === 'init') {
      PD.id = m.d.id; PD.permissions = m.d.permissions || []; PD.theme = m.d.theme || {};
      PD.widget = m.d.widget || null; PD.options = (m.d.widget && m.d.widget.options) || {};
      var root = document.documentElement;
      root.style.setProperty('--safe-top', '44px');     // PhoneDesk's battery pill and full-screen button sit here
      root.style.setProperty('--safe-bottom', '30px');  // and the page dots here
      Object.keys(PD.theme).forEach(function (k) { root.style.setProperty('--' + k, PD.theme[k]); });
      root.className = (root.className.replace(/\bpd-theme-\w+\b/g, '') + ' pd-theme-' + (m.d.themeName || 'dark')).trim();
      PD.ready = true;
      applyScale();
      emit('ready');
      return;
    }
    if (m.t === 'resize' && PD.widget) { PD.widget.w = m.d.w; PD.widget.h = m.d.h; last.resize = m.d; applyScale(); }
    else if (m.t === 'visible') { PD.visible = !!m.d; last.visible = !!m.d; }
    else if (m.t !== 'message') last[m.t] = m.d;
    emit(m.t, m.d);
  });

  // A horizontal swipe changes the screen, as it does everywhere else in PhoneDesk, unless you captured it.
  // On a touch screen this uses touch events: the browser cancels pointer events as soon as it treats a
  // touch as a pan, so a swipe inside the frame would never be seen (and the phone would be stuck on this screen).
  var sx = 0, sy = 0, st = 0, on = false, lastTouch = 0;
  function down(x, y) { on = true; sx = x; sy = y; st = Date.now(); }
  function up(x, y) {
    if (!on) return;
    on = false;
    var dx = x - sx, dy = y - sy;
    if (capture || Date.now() - st > 800) return;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) post('swipe', dx < 0 ? 1 : -1);
  }
  document.addEventListener('touchstart', function (e) { lastTouch = Date.now(); var t = e.touches[0]; if (e.touches.length === 1 && t) down(t.clientX, t.clientY); else on = false; }, { passive: true });
  document.addEventListener('touchend', function (e) { lastTouch = Date.now(); var t = e.changedTouches[0]; if (t) up(t.clientX, t.clientY); }, { passive: true });
  document.addEventListener('touchcancel', function () { on = false; }, { passive: true });
  // a mouse or a pen (touches are handled above)
  function byTouch(e) { return e.pointerType === 'touch' || Date.now() - lastTouch < 800; }
  document.addEventListener('pointerdown', function (e) { if (!byTouch(e)) down(e.clientX, e.clientY); });
  document.addEventListener('pointerup', function (e) { if (!byTouch(e)) up(e.clientX, e.clientY); });

  post('ready');
})();
