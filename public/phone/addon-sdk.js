/* PhoneDesk addon SDK (phone side). Include it in your screen:  <script src="/addons/sdk.js"></script>
 *
 * Your screen runs in a sandboxed frame: no network, no storage shared with PhoneDesk, no access to the page around it.
 * This file is the way in and out. Everything is asynchronous messages; there is nothing to configure.
 *
 *   PD.on('ready', fn)      the frame is connected; PD.theme, PD.permissions and PD.id are set
 *   PD.on('message', fn)    data your PC-side code sent with pd.screen.send(data)
 *   PD.on('media', fn)      what is playing (needs the "media" permission); also 'volume', 'stats'
 *   PD.on('visible', fn)    true or false: your screen was swiped to or away from
 *   PD.send(data)           data for your PC-side code (its pd.screen.on handler)
 *   PD.media.command(c)     'toggle' | 'play' | 'pause' | 'next' | 'prev'  (needs "control")
 *   PD.volume.set(0..1)     (needs "control")
 *   PD.captureSwipe(true)   keep horizontal swipes for your screen (they normally change the screen)
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
    on: function (name, fn) {
      (handlers[name] = handlers[name] || []).push(fn);
      if (name === 'ready' && PD.ready) fn();
      else if (last[name] !== undefined && name !== 'message') fn(last[name]); // late listeners still get the current state
    },
    send: function (data) { post('send', data); },
    media: { command: function (c) { post('media', c); } },
    volume: { set: function (v) { post('volume', v); } },
    captureSwipe: function (on) { capture = !!on; },
  };
  function post(t, d) { try { parent.postMessage({ pd: 1, t: t, d: d }, '*'); } catch (e) {} }
  function emit(name, d) { (handlers[name] || []).forEach(function (fn) { try { fn(d); } catch (e) { if (window.console) console.error(e); } }); }

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.pd !== 1) return;
    if (m.t === 'init') {
      PD.id = m.d.id; PD.permissions = m.d.permissions || []; PD.theme = m.d.theme || {};
      var root = document.documentElement;
      root.style.setProperty('--safe-top', '44px');     // PhoneDesk's battery pill and full-screen button sit here
      root.style.setProperty('--safe-bottom', '30px');  // and the page dots here
      Object.keys(PD.theme).forEach(function (k) { root.style.setProperty('--' + k, PD.theme[k]); });
      root.className = (root.className.replace(/\bpd-theme-\w+\b/g, '') + ' pd-theme-' + (m.d.themeName || 'dark')).trim();
      PD.ready = true;
      emit('ready');
      return;
    }
    if (m.t === 'visible') { PD.visible = !!m.d; last.visible = !!m.d; }
    else if (m.t !== 'message') last[m.t] = m.d;
    emit(m.t, m.d);
  });

  // A horizontal swipe changes the screen, as it does everywhere else in PhoneDesk, unless you captured it.
  var sx = 0, sy = 0, st = 0, on = false;
  document.addEventListener('pointerdown', function (e) { on = true; sx = e.clientX; sy = e.clientY; st = Date.now(); });
  document.addEventListener('pointercancel', function () { on = false; });
  document.addEventListener('pointerup', function (e) {
    if (!on) return;
    on = false;
    var dx = e.clientX - sx, dy = e.clientY - sy;
    if (capture || Date.now() - st > 800) return;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) post('swipe', dx < 0 ? 1 : -1);
  });

  post('ready');
})();
