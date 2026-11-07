/* PhoneDesk phone client. Plain JS, no framework, no build step.
   Design goals for slow phones:
   - Touch the DOM only when a value actually changed.
   - The progress bar is a single CSS transition the GPU runs; JS does not tick it every frame.
   - Only the visible screen does any work. Hidden screens are display:none.
   - The connection heals itself (backoff reconnect, liveness check, resume on wake). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('pd.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('pd.' + k, JSON.stringify(v)); } catch (e) {} },
  };

  /* ============================================================ landscape-only layout
     If the screen is taller than wide, #app is rotated 90deg (see app.css) so the UI is always
     landscape. Touch coordinates then need mapping from the screen into the app's own space. */
  var rotated = false;
  function layout() {
    var W = window.innerWidth, H = window.innerHeight;
    rotated = H > W;
    document.documentElement.classList.toggle('rot', rotated);
    var st = document.documentElement.style;
    st.setProperty('--aw', (rotated ? H : W) + 'px');
    st.setProperty('--ah', (rotated ? W : H) + 'px');
    st.setProperty('--sw', W + 'px');
  }
  layout();
  // A pointer event's position in app coordinates (x along the landscape width).
  function pt(e) {
    return rotated ? { x: e.clientY, y: window.innerWidth - e.clientX } : { x: e.clientX, y: e.clientY };
  }
  // An element's box in app coordinates.
  function appRect(el) {
    var r = el.getBoundingClientRect();
    return rotated ? { left: r.top, top: window.innerWidth - r.right, width: r.height, height: r.width } : r;
  }

  var state = {
    media: { active: false },
    volume: { level: 0, muted: false },
    stats: null,
    config: { shortcuts: [], screens: ['media', 'clock', 'stats', 'shortcuts'], clock24: true, theme: 'dark', accent: 'auto', dimAfter: 0 },
    clockOffset: 0, // PC time - phone time (ms)
    screen: store.get('screen', 'media'),
  };

  /* ============================================================ connection */
  var ws = null, retry = 0, lastMsg = 0, connectTimer = null, everConnected = false;

  // Where the PC can be reached. The page itself may have come from USB (localhost) — when the
  // cable is pulled, carry on over Wi-Fi (phonedesk.local, then the PC's IP) without reloading,
  // so full screen and everything else stays as it is.
  var hosts = uniq([location.host].concat(store.get('hosts', [])));
  var activeHost = location.host; // the page just loaded from here, so it works right now
  var hostFails = 0;
  function uniq(a) { var o = []; for (var i = 0; i < a.length; i++) if (a[i] && o.indexOf(a[i]) < 0) o.push(a[i]); return o; }
  function nextHost() {
    var i = hosts.indexOf(activeHost);
    activeHost = hosts[(i + 1) % hosts.length];
    hostFails = 0;
  }
  // Absolute URL on whichever address we're talking to right now.
  function pcUrl(path) { return activeHost === location.host ? path : 'http://' + activeHost + path; }

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + activeHost + '/ws?role=phone&screen=' + encodeURIComponent(state.screen);
  }

  function connect() {
    clearTimeout(connectTimer);
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    var sock;
    try { sock = new WebSocket(wsUrl()); } catch (e) { return scheduleReconnect(); }
    ws = sock;
    sock.onopen = function () {
      retry = 0; lastMsg = Date.now(); everConnected = true; hostFails = 0;
      $('offline').hidden = true;
      reportBattery();
    };
    sock.onmessage = function (ev) {
      lastMsg = Date.now();
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onMessage(m);
    };
    sock.onclose = function () {
      if (ws !== sock) return;
      ws = null;
      showOffline();
      scheduleReconnect();
    };
    sock.onerror = function () { try { sock.close(); } catch (e) {} };
  }

  function scheduleReconnect() {
    clearTimeout(connectTimer);
    // Two misses on one address: try the next one (USB -> Wi-Fi name -> IP -> back again).
    if (++hostFails >= 2 && hosts.length > 1) { nextHost(); retry = Math.min(retry, 2); }
    var delay = Math.min(4000, 400 * Math.pow(1.6, retry++));
    connectTimer = setTimeout(connect, delay);
  }

  function showOffline() {
    // Brief blips (Wi-Fi roaming) shouldn't flash a full-screen overlay.
    setTimeout(function () {
      if (ws && ws.readyState === 1) return;
      $('o-sub').textContent = everConnected
        ? 'PC disconnected · reconnecting…'
        : 'Waiting for PhoneDesk on your PC · same Wi-Fi, or plug in by USB';
      if ($('offline').hidden) { $('offline').hidden = false; offlineShift = -1; renderOfflineClock(); }
    }, everConnected ? 1500 : 0);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  // Liveness: the PC sends something at least every 2s (stats), so 6.5s of silence means the link is
  // dead even if the socket still looks open (that's what pulling a USB cable looks like). Drop it
  // and fail over to the next address quickly.
  var pingTick = 0;
  setInterval(function () {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - lastMsg > 6500) {
      var dead = ws;
      ws = null;
      try { dead.close(); } catch (e) {}
      showOffline();
      scheduleReconnect();
      return;
    }
    if (++pingTick % 5 === 0) send({ t: 'ping', d: Date.now() });
  }, 2000);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (!ws || ws.readyState > 1) { retry = 0; connect(); }
      renderAll();
      requestWakeLock();
    }
  });
  window.addEventListener('online', function () { retry = 0; connect(); });

  function onMessage(m) {
    switch (m.t) {
      case 'hello':
        state.clockOffset = m.d.serverTime - Date.now();
        if (m.d.hosts) { store.set('hosts', m.d.hosts); hosts = uniq([activeHost, location.host].concat(m.d.hosts)); }
        break;
      case 'media': state.media = m.d || { active: false }; renderMedia(); renderClockMini(); break;
      case 'volume': state.volume = m.d; renderVolume(); break;
      case 'stats': state.stats = m.d; pushGraph(m.d); if (state.screen === 'stats') renderStats(); break;
      case 'config': applyConfig(m.d); break;
      case 'reload': location.replace(pcUrl('/phone')); break;
      case 'show': if (screens().indexOf(m.v) >= 0) show(m.v); break;
      case 'identify': identify(m.d && m.d.name); break;
      case 'battery': serverBattery = m.d; renderBattery(); break;
    }
  }

  /* ============================================================ helpers */
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function setText(el, txt) { if (el.textContent !== txt) el.textContent = txt; }
  function setHref(useEl, id) { if (useEl.getAttribute('href') !== id) useEl.setAttribute('href', id); }
  function toggle(el, cls, on) { if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on); }
  function buzz() { if (navigator.vibrate) try { navigator.vibrate(12); } catch (e) {} }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 1400);
  }

  /* ============================================================ media */
  var el = {
    art: $('art'), title: $('m-title'), artist: $('m-artist'), app: $('m-app'), appIc: $('m-app-ic'),
    fill: $('m-fill'), track: $('m-track'), pos: $('m-pos'), dur: $('m-dur'),
    playIc: $('b-play-ic'), shuffle: $('b-shuffle'), repeat: $('b-repeat'),
  };
  var seeking = false, lastArt = null, optimisticUntil = 0;

  function isPlaying() { return state.media.active && state.media.status === 'Playing'; }

  // Where is the track *now*? The PC reports a position at a timestamp; extrapolate if playing.
  function currentPos() {
    var m = state.media;
    if (!m.active || !m.duration) return 0;
    var p = m.position || 0;
    if (m.status === 'Playing' && m.updated) p += (Date.now() + state.clockOffset - m.updated) / 1000;
    return Math.min(Math.max(0, p), m.duration);
  }

  function renderMedia() {
    var m = state.media;
    toggle(document.body, 'idle', !m.active);
    if (!m.active) {
      setText(el.title, 'Nothing playing');
      setText(el.artist, 'Play something on your PC');
      setText(el.app, '');
      setAppIcon('');
      setArt('');
    } else {
      setText(el.title, m.title || 'Unknown title');
      setText(el.artist, m.artist || m.album || '');
      setText(el.app, (m.game ? 'Game · ' : '') + (m.app || ''));
      setAppIcon(m.site === 'youtube' ? 'video' : m.appIcon || '');
      setArt(m.art || '');
    }
    if (Date.now() > optimisticUntil) setHref(el.playIc, isPlaying() ? '#i-pause' : '#i-play');
    toggle(el.shuffle, 'on', m.shuffle === true);
    toggle(el.repeat, 'on', m.repeat > 0);
    toggle(el.repeat, 'rep1', m.repeat === 1);
    el.shuffle.style.visibility = m.shuffle == null ? 'hidden' : '';
    renderProgress();
  }

  // The playing app's own icon (Spotify, a game...) or a video icon for YouTube in a browser.
  var lastAppIcon = null;
  function setAppIcon(src) {
    if (src === lastAppIcon) return;
    lastAppIcon = src;
    if (!src) { el.appIc.innerHTML = ''; return; }
    if (src === 'video') { el.appIc.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="4.5" width="21" height="15" rx="4.5" fill="#FF0033"/><path d="M10 9v6l5.2-3z" fill="#fff"/></svg>'; return; }
    var img = new Image();
    img.alt = '';
    img.onerror = function () { el.appIc.innerHTML = ''; };
    img.src = pcUrl(src);
    el.appIc.innerHTML = '';
    el.appIc.appendChild(img);
  }

  function setArt(src) {
    if (src === lastArt) return;
    lastArt = src;
    el.art.classList.remove('ok');
    if (!src) { el.art.removeAttribute('src'); applyAccent(null); return; }
    el.art.onload = function () { if (lastArt === src) { el.art.classList.add('ok'); applyAccent(el.art); } };
    el.art.onerror = function () { el.art.classList.remove('ok'); };
    el.art.crossOrigin = 'anonymous'; // lets the accent color be read from the picture
    el.art.src = pcUrl(src);
  }

  // One CSS transition from "now" to "end of track". The compositor animates it; zero JS per frame.
  function renderProgress() {
    if (seeking || state.screen !== 'media') return;
    var m = state.media, f = el.fill;
    var dur = m.duration || 0, pos = currentPos();
    setText(el.dur, dur ? fmt(dur) : '0:00');
    setText(el.pos, fmt(pos));
    var frac = dur ? pos / dur : 0;
    f.style.transition = 'none';
    f.style.transform = 'scaleX(' + frac.toFixed(5) + ')';
    if (isPlaying() && dur > 0 && pos < dur) {
      void f.offsetWidth; // commit the start point
      f.style.transition = 'transform ' + (dur - pos).toFixed(2) + 's linear';
      f.style.transform = 'scaleX(1)';
    }
  }

  // Time labels tick once a second, only while the media screen is visible.
  setInterval(function () {
    if (state.screen === 'media' && isPlaying() && !seeking && document.visibilityState === 'visible') setText(el.pos, fmt(currentPos()));
  }, 1000);

  function cmd(a, v) {
    buzz();
    if (!send({ t: 'cmd', a: a, v: v })) toast('Not connected');
  }

  $('b-play').addEventListener('click', function () {
    var willPlay = !isPlaying();
    // Optimistic: flip the icon now, the PC confirms ~250ms later.
    setHref(el.playIc, willPlay ? '#i-pause' : '#i-play');
    optimisticUntil = Date.now() + 1200;
    cmd('toggle');
  });
  $('b-next').addEventListener('click', function () { cmd('next'); });
  $('b-prev').addEventListener('click', function () { cmd('prev'); });
  $('b-shuffle').addEventListener('click', function () { cmd('shuffle'); });
  $('b-repeat').addEventListener('click', function () { cmd('repeat'); });

  // Seek by tapping or dragging the progress bar.
  (function () {
    var t = el.track, rect = null, frac = 0;
    function at(e) { return Math.min(1, Math.max(0, (pt(e).x - rect.left) / rect.width)); }
    t.addEventListener('pointerdown', function (e) {
      if (!state.media.active || !state.media.duration) return;
      seeking = true; rect = appRect(t); frac = at(e);
      t.setPointerCapture(e.pointerId);
      show();
    });
    t.addEventListener('pointermove', function (e) { if (seeking) { frac = at(e); show(); } });
    function end() {
      if (!seeking) return;
      seeking = false;
      var target = frac * state.media.duration;
      state.media.position = target;
      state.media.updated = Date.now() + state.clockOffset;
      cmd('seek', target);
      renderProgress();
    }
    t.addEventListener('pointerup', end);
    t.addEventListener('pointercancel', end);
    function show() {
      el.fill.style.transition = 'none';
      el.fill.style.transform = 'scaleX(' + frac + ')';
      setText(el.pos, fmt(frac * state.media.duration));
    }
  })();

  /* ============================================================ volume */
  var vol = { slider: $('v-slider'), fill: $('v-fill'), knob: $('v-knob'), num: $('v-num'), ic: $('b-mute-ic'), dragging: false, holdUntil: 0 };

  function drawVolume(level, muted) {
    var w = vol.slider.clientWidth || 1;
    vol.fill.style.transform = 'scaleX(' + level + ')';
    vol.knob.style.transform = 'translateX(' + Math.round(level * w) + 'px)';
    setText(vol.num, String(Math.round(level * 100)));
    setHref(vol.ic, muted || level === 0 ? '#i-mute' : '#i-vol');
  }
  function renderVolume() {
    if (vol.dragging || Date.now() < vol.holdUntil) return;
    drawVolume(state.volume.level, state.volume.muted);
    if (state.screen === 'stats') renderStats();
  }
  (function () {
    var rect = null, lastSent = 0, pending = null, timer = null;
    function at(e) { return Math.min(1, Math.max(0, (pt(e).x - rect.left) / rect.width)); }
    function push(v, force) {
      pending = v;
      var now = Date.now();
      if (force || now - lastSent > 70) { lastSent = now; send({ t: 'volume', v: v }); pending = null; }
      else if (!timer) timer = setTimeout(function () { timer = null; if (pending != null) push(pending, true); }, 70);
    }
    vol.slider.addEventListener('pointerdown', function (e) {
      vol.dragging = true; rect = appRect(vol.slider);
      vol.slider.setPointerCapture(e.pointerId);
      vol.slider.classList.add('drag');
      var v = at(e); drawVolume(v, false); push(v);
    });
    vol.slider.addEventListener('pointermove', function (e) {
      if (!vol.dragging) return;
      var v = at(e); drawVolume(v, false); push(v);
    });
    function end(e) {
      if (!vol.dragging) return;
      vol.dragging = false; vol.slider.classList.remove('drag');
      var v = at(e); state.volume.level = v; push(v, true);
      vol.holdUntil = Date.now() + 600; // don't snap back while the PC catches up
    }
    vol.slider.addEventListener('pointerup', end);
    vol.slider.addEventListener('pointercancel', end);
  })();
  $('b-mute').addEventListener('click', function () { buzz(); send({ t: 'mute' }); });
  function onResize() { layout(); drawVolume(state.volume.level, state.volume.muted); renderProgress(); sizeGraph(); }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', function () { setTimeout(onResize, 150); });

  /* ============================================================ accent color from album art */
  var DEFAULT_TINT = [91, 140, 255];
  var canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  function applyAccent(img) {
    if (state.config.accent && state.config.accent !== 'auto') return setAccent(hexToRgb(state.config.accent));
    if (!img) return setAccent(DEFAULT_TINT);
    try {
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 16, 16);
      var d = ctx.getImageData(0, 0, 16, 16).data, r = 0, g = 0, b = 0, wsum = 0;
      for (var i = 0; i < d.length; i += 4) {
        var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        var w = (mx - mn) / 255 + 0.05; // favour colourful pixels over grey/black
        r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; wsum += w;
      }
      setAccent(readable([r / wsum, g / wsum, b / wsum]));
    } catch (e) { setAccent(DEFAULT_TINT); }
  }
  function hexToRgb(h) { var n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  // Push the colour into a lightness band that stays legible on the theme background.
  function readable(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0;
    if (mx !== mn) {
      var dd = mx - mn;
      s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
      h = mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
      h /= 6;
    }
    var light = document.body.classList.contains('theme-light');
    l = light ? Math.min(Math.max(l, 0.32), 0.45) : Math.min(Math.max(l, 0.58), 0.7);
    s = Math.max(s, 0.45);
    function hue(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255].map(Math.round);
  }
  var currentTint = '';
  function setAccent(rgb) {
    var key = rgb.join(',');
    if (key === currentTint) return;
    currentTint = key;
    var root = document.documentElement.style;
    root.setProperty('--tint', key);
    root.setProperty('--accent', 'rgb(' + key + ')');
  }

  /* ============================================================ clock */
  var clockEl = { time: $('c-time'), date: $('c-date'), mini: $('c-mini'), miniT: $('c-mini-t'), box: $('clock') };
  var lastClock = '', shiftMin = -1;
  function clockHtml(d) {
    var h = d.getHours(), mi = d.getMinutes();
    if (state.config.clock24) return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
    return ((h % 12) || 12) + ':' + (mi < 10 ? '0' : '') + mi + '<small>' + (h < 12 ? 'AM' : 'PM') + '</small>';
  }
  function dateText(d) { return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }); }
  // Nudge a clock a few pixels each minute so a static screen doesn't burn in.
  function nudge(box) { box.style.transform = 'translate(' + (Math.random() * 16 - 8).toFixed(0) + 'px,' + (Math.random() * 12 - 6).toFixed(0) + 'px)'; }
  function renderClock() {
    var d = new Date(Date.now() + state.clockOffset);
    var html = clockHtml(d);
    if (html !== lastClock) {
      lastClock = html;
      clockEl.time.innerHTML = html;
      clockEl.date.textContent = dateText(d);
    }
    if (d.getMinutes() !== shiftMin) { shiftMin = d.getMinutes(); nudge(clockEl.box); }
  }

  // Disconnected clock: the phone's own time, corrected by the last known PC offset.
  var offlineLast = '', offlineShift = -1;
  function renderOfflineClock() {
    if ($('offline').hidden) return;
    var d = new Date(Date.now() + state.clockOffset);
    var html = clockHtml(d);
    if (html !== offlineLast) { offlineLast = html; $('o-time').innerHTML = html; $('o-date').textContent = dateText(d); }
    if (d.getMinutes() !== offlineShift) { offlineShift = d.getMinutes(); nudge($('o-clock')); }
  }
  setInterval(function () { if (document.visibilityState === 'visible') renderOfflineClock(); }, 1000);
  function renderClockMini() {
    var m = state.media;
    toggle(clockEl.mini, 'hide', !m.active || !m.title);
    if (m.active) setText(clockEl.miniT, (m.title || '') + (m.artist ? ' — ' + m.artist : ''));
  }
  setInterval(function () { if (state.screen === 'clock' && document.visibilityState === 'visible') renderClock(); }, 1000);

  /* ============================================================ stats */
  var graph = { el: $('st-graph'), points: [], dpr: Math.min(window.devicePixelRatio || 1, 2) };
  function pushGraph(s) {
    if (!s) return;
    graph.points.push(s.cpu);
    if (graph.points.length > 90) graph.points.shift();
  }
  function sizeGraph() {
    var c = graph.el, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * graph.dpr)) { c.width = Math.round(w * graph.dpr); c.height = Math.round(h * graph.dpr); }
  }
  function drawGraph() {
    var c = graph.el; sizeGraph();
    var ctx = c.getContext('2d'), W = c.width, H = c.height, pts = graph.points;
    ctx.clearRect(0, 0, W, H);
    if (pts.length < 2) return;
    var accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5b8cff';
    var step = W / 89, pad = 8 * graph.dpr;
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      var x = W - (pts.length - 1 - i) * step, y = H - pad - (pts[i] / 100) * (H - pad * 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2 * graph.dpr; ctx.strokeStyle = accent; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(W, H); ctx.lineTo(W - (pts.length - 1) * step, H); ctx.closePath();
    ctx.globalAlpha = 0.14; ctx.fillStyle = accent; ctx.fill(); ctx.globalAlpha = 1;
  }
  function gb(n) { return (n / 1073741824).toFixed(1); }
  function renderStats() {
    var s = state.stats;
    if (!s) return;
    var memPct = Math.round((s.memUsed / s.memTotal) * 100), v = Math.round(state.volume.level * 100);
    setText($('st-host'), s.host || 'PC');
    setText($('st-cpu'), String(s.cpu));
    $('st-cpu-f').style.transform = 'scaleX(' + s.cpu / 100 + ')';
    setText($('st-cores'), s.cores + ' threads');
    setText($('st-mem'), String(memPct));
    $('st-mem-f').style.transform = 'scaleX(' + memPct / 100 + ')';
    setText($('st-mem-s'), gb(s.memUsed) + ' / ' + gb(s.memTotal) + ' GB');
    setText($('st-vol'), state.volume.muted ? '0' : String(v));
    $('st-vol-f').style.transform = 'scaleX(' + (state.volume.muted ? 0 : v / 100) + ')';
    var up = s.uptime, d = Math.floor(up / 86400), h = Math.floor((up % 86400) / 3600), mi = Math.floor((up % 3600) / 60);
    setText($('st-up'), 'PC up ' + (d ? d + 'd ' : '') + h + 'h ' + mi + 'm');
    drawGraph();
  }

  /* ============================================================ shortcuts */
  var ICONS = ['mic', 'desktop', 'lock', 'camera', 'music', 'play', 'chart', 'folder', 'bolt', 'globe', 'game', 'code', 'chat', 'power', 'vol', 'next'];
  function renderPad() {
    var pad = $('pad'), list = state.config.shortcuts || [];
    pad.textContent = '';
    if (!list.length) {
      var e = document.createElement('div'); e.className = 'empty';
      e.textContent = 'No shortcuts yet. Add some in the PhoneDesk dashboard on your PC.';
      pad.appendChild(e); return;
    }
    var frag = document.createDocumentFragment();
    list.forEach(function (sc) {
      var b = document.createElement('button');
      b.className = 'key';
      b.style.setProperty('--kc', sc.color);
      var icon = ICONS.indexOf(sc.icon) >= 0 ? sc.icon : 'bolt';
      b.innerHTML = '<svg class="ic"><use href="#i-' + icon + '"/></svg><span class="lb"></span>';
      b.querySelector('.lb').textContent = sc.label;
      b.addEventListener('click', function () {
        buzz();
        if (!send({ t: 'shortcut', id: sc.id })) return toast('Not connected');
        b.classList.add('hit');
        setTimeout(function () { b.classList.remove('hit'); }, 180);
      });
      frag.appendChild(b);
    });
    pad.appendChild(frag);
    pad.style.gridTemplateRows = 'repeat(' + Math.max(1, Math.ceil(list.length / 4)) + ', 1fr)';
  }

  /* ============================================================ screens + navigation */
  function screens() { return state.config.screens && state.config.screens.length ? state.config.screens : ['media']; }

  function show(name) {
    var list = screens();
    if (list.indexOf(name) < 0) name = list[0];
    state.screen = name;
    store.set('screen', name);
    var secs = document.querySelectorAll('.screen');
    for (var i = 0; i < secs.length; i++) toggle(secs[i], 'on', secs[i].getAttribute('data-screen') === name);
    var dots = $('dots').children;
    for (var j = 0; j < dots.length; j++) toggle(dots[j], 'on', dots[j].getAttribute('data-s') === name);
    send({ t: 'screen', v: name });
    renderAll();
  }

  function renderAll() {
    if (state.screen === 'media') { renderMedia(); drawVolume(state.volume.level, state.volume.muted); }
    else if (state.screen === 'clock') { lastClock = ''; renderClock(); renderClockMini(); }
    else if (state.screen === 'stats') renderStats();
  }

  function renderDots() {
    var nav = $('dots'), list = screens();
    nav.textContent = '';
    nav.style.display = list.length > 1 ? '' : 'none';
    list.forEach(function (s) {
      var b = document.createElement('button');
      b.setAttribute('data-s', s);
      b.setAttribute('aria-label', s);
      b.addEventListener('click', function () { show(s); });
      nav.appendChild(b);
    });
  }

  function step(dir) {
    var list = screens(), i = list.indexOf(state.screen);
    show(list[(i + dir + list.length) % list.length]);
  }

  // Swipe left/right anywhere (except on sliders) to change screen.
  (function () {
    var sx = 0, sy = 0, st = 0, active = false;
    var root = $('screens');
    root.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.slider, .track')) { active = false; return; }
      var p = pt(e); active = true; sx = p.x; sy = p.y; st = Date.now();
    });
    root.addEventListener('pointerup', function (e) {
      if (!active) return;
      active = false;
      var p = pt(e), dx = p.x - sx, dy = p.y - sy;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4 && Date.now() - st < 700) step(dx < 0 ? 1 : -1);
    });
    root.addEventListener('pointercancel', function () { active = false; });
  })();

  function applyConfig(c) {
    var prevShortcuts = JSON.stringify(state.config.shortcuts), prevScreens = JSON.stringify(state.config.screens);
    state.config = c;
    document.body.className = document.body.className.replace(/theme-\w+/, '') + ' theme-' + (c.theme || 'dark');
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', c.theme === 'light' ? '#f4f5f7' : c.theme === 'black' ? '#000000' : '#0e0f12');
    currentTint = '';
    applyAccent(el.art.classList.contains('ok') ? el.art : null);
    if (JSON.stringify(c.shortcuts) !== prevShortcuts) renderPad();
    renderBattery();
    if (JSON.stringify(c.screens) !== prevScreens || !$('dots').children.length) { renderDots(); show(state.screen); }
    else renderAll();
    armDim();
  }

  /* ============================================================ full screen, wake lock, dimming */
  var fsBtn = $('fs');
  function goFullscreen() {
    var d = document.documentElement, fn = d.requestFullscreen || d.webkitRequestFullscreen;
    if (fn && !document.fullscreenElement && !document.webkitFullscreenElement) {
      try {
        var p = fn.call(d, { navigationUI: 'hide' });
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    }
    lockLandscape();
  }
  // Browsers only allow this in full screen. When it works the page is natively landscape and the
  // CSS rotation switches itself off; when it doesn't, the CSS rotation keeps the app landscape.
  function lockLandscape() {
    try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (e) {}
  }
  // First tap anywhere: go full screen and lock to landscape. It's a desk display.
  var autoFs = false;
  document.addEventListener('pointerup', function () {
    if (autoFs) return;
    autoFs = true;
    goFullscreen();
  }, true);
  fsBtn.addEventListener('click', function (e) { e.stopPropagation(); goFullscreen(); });
  document.addEventListener('fullscreenchange', function () {
    toggle(document.body, 'fullscreen', !!document.fullscreenElement);
    if (document.fullscreenElement) lockLandscape();
  });
  document.addEventListener('webkitfullscreenchange', function () { toggle(document.body, 'fullscreen', !!document.webkitFullscreenElement); });
  // In standalone (added to home screen) mode there is no browser bar anyway.
  if (window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches) document.body.classList.add('fullscreen');

  var wakeLock = null;
  function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      // The browser drops the lock on some events; take it back while visible.
      l.addEventListener('release', function () { wakeLock = null; setTimeout(requestWakeLock, 1000); });
    }).catch(function () {});
  }
  requestWakeLock();

  var dimTimer = null;
  function armDim() {
    clearTimeout(dimTimer);
    var secs = state.config.dimAfter || 0;
    if (secs > 0) dimTimer = setTimeout(function () { $('dim').hidden = false; }, secs * 1000);
  }
  document.addEventListener('pointerdown', function (e) {
    if (!$('dim').hidden) { $('dim').hidden = true; e.preventDefault(); e.stopPropagation(); }
    armDim();
    if (!wakeLock) requestWakeLock();
  }, true);

  /* ============================================================ battery + identify (for the PC app) */
  var battery = null, serverBattery = null;
  function reportBattery() {
    renderBattery();
    if (battery) send({ t: 'battery', level: battery.level, charging: battery.charging });
  }
  // The phone's own reading wins; over USB the PC also reads it with adb, for browsers that can't.
  function renderBattery() {
    var b = battery || serverBattery, el = $('batt');
    var show = !!b && state.config.showBattery !== false;
    if (el.hidden === show) el.hidden = !show;
    if (!show) return;
    var pct = Math.round(b.level * 100);
    $('batt-fill').setAttribute('width', (19 * Math.max(0.06, b.level)).toFixed(1));
    $('batt-bolt').style.display = b.charging ? '' : 'none';
    setText($('batt-n'), pct + '%');
    toggle(el, 'low', pct <= 20 && !b.charging);
    toggle(el, 'charging', !!b.charging);
  }
  // Only available on secure origins (USB uses localhost, so it works there).
  if (navigator.getBattery) {
    navigator.getBattery().then(function (b) {
      battery = b;
      b.addEventListener('levelchange', reportBattery);
      b.addEventListener('chargingchange', reportBattery);
      reportBattery();
    }).catch(function () {});
  }

  // "Identify" from the PC app: flash this phone so you know which one it is.
  function identify(name) {
    var el = $('identify');
    $('identify-name').textContent = name || 'This phone';
    el.hidden = false;
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
    buzz();
    clearTimeout(identify.t);
    identify.t = setTimeout(function () { el.hidden = true; }, 2200);
  }

  /* ============================================================ boot */
  renderDots();
  show(state.screen);
  renderPad();
  connect();
})();
