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
    config: { shortcuts: [], screens: ['media', 'clock', 'stats', 'shortcuts'], clock24: true, theme: 'dark', accent: 'auto', dimAfter: 0, nowStyle: 'immersive', lyricsMode: 'scroll', lyricsFont: 'serif', lyricsLines: 'off' },
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
    var giveUp = setTimeout(function () {
      if (ws !== sock || sock.readyState === 1) return;
      ws = null;
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try { sock.close(); } catch (e) {}
      showOffline();
      scheduleReconnect();
    }, 3000);
    sock.onopen = function () {
      clearTimeout(giveUp);
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
      clearTimeout(giveUp);
      if (ws !== sock) return;
      ws = null;
      showOffline();
      scheduleReconnect();
    };
    sock.onerror = function () { try { sock.close(); } catch (e) {} };
  }

  window.pdReconnect = function () {
    if (ws && ws.readyState === 1) return;
    if (ws) { try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); } catch (e) {} ws = null; }
    retry = 0; hostFails = 0; connect();
  };
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') window.pdReconnect(); });

  function scheduleReconnect() {
    clearTimeout(connectTimer);
    // Two misses on one address: try the next one (USB -> Wi-Fi name -> IP -> back again).
    if (++hostFails >= 2 && hosts.length > 1) { nextHost(); retry = Math.min(retry, 2); }
    var delay = Math.min(2500, 400 * Math.pow(1.5, retry++));
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
      case 'media': state.media = m.d || { active: false }; mediaClock(state.media); renderMedia(); renderClockMini(); renderSpotify(); renderLyricsHead(); renderLive(); break;
      case 'volume': state.volume = m.d; renderVolume(); renderLive(); break;
      case 'stats': state.stats = m.d; pushGraph(m.d); if (state.screen === 'stats') renderStats(); break;
      case 'history': setHistory(m.d); break;
      case 'histPoint': addHistory(m.d); break;
      case 'config': applyConfig(m.d); break;
      case 'reload': location.replace(pcUrl('/phone')); break;
      case 'show': if (screens().indexOf(m.v) >= 0) show(m.v); break;
      case 'identify': identify(m.d && m.d.name); break;
      case 'battery': serverBattery = m.d; renderBattery(); break;
      case 'mixer': state.mixer = m.d || []; if (state.screen === 'mixer') renderMixer(); break;
      case 'lyrics': setLyrics(m.d); break;
      case 'weather': setWeather(m.d); break;
      case 'calendar': setCalendar(m.d); break;
      case 'spotify': state.spotify = m.d; renderSpotify(); break;
      case 'notify': queueNotification(m.d); break;
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
  // A smooth playback clock. Players report their position only every few seconds and the timestamps are a little
  // off, so extrapolating straight from each report makes the song position jump back and forth. Instead keep our own
  // running clock and nudge it toward each report; a real jump (seek, new song, play/pause) resets it at once.
  var pc = { pos: 0, at: 0, playing: false, key: '' };
  function pcPos(now) { return pc.pos + (pc.playing ? (now - pc.at) / 1000 : 0); }
  function mediaClock(m) {
    $('ly-music').classList.toggle('paused', !m || m.status !== 'Playing');
    if (!m || !m.active) { pc.at = 0; return; }
    var now = Date.now() + state.clockOffset, playing = m.status === 'Playing';
    var key = (m.app || '') + '|' + (m.title || '') + '|' + (m.artist || '') + '|' + Math.round(m.duration || 0);
    var lag = playing && m.updated ? Math.max(0, now - m.updated) / 1000 : 0;
    var changed = key !== pc.key || playing !== pc.playing || !pc.at;
    if (changed && lag > 3) lag = 0; // a stale timestamp right after play/resume: trust the position as of now
    var rep = (m.position || 0) + lag, cur = pcPos(now);
    if (changed || Math.abs(rep - cur) > 1.2) pc = { pos: rep, at: now, playing: playing, key: key };
    else { pc.pos = cur + (rep - cur) * 0.4; pc.at = now; }
  }
  function currentPos() {
    var m = state.media;
    if (!m.active || !m.duration) return 0;
    return Math.min(Math.max(0, pcPos(Date.now() + state.clockOffset)), m.duration);
  }

  function renderMedia() {
    var m = state.media;
    toggle(document.body, 'idle', !m.active);
    toggle(document.body, 'paused', !!m.active && m.status !== 'Playing');
    if (!m.active) {
      setText(el.title, 'Nothing playing');
      setText(el.artist, 'Play something on your PC');
      setText(el.app, '');
      setAppIcon('');
      setArt('');
    } else {
      swapText(el.title, m.title || 'Unknown title');
      swapText(el.artist, m.artist || m.album || '');
      swapText(el.app, (m.game ? 'Game · ' : '') + (m.app || ''));
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

  var VIDEO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="4.5" width="21" height="15" rx="4.5" fill="#FF0033"/><path d="M10 9v6l5.2-3z" fill="#fff"/></svg>';
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

  // Same as setText, but replays a small slide-up when the text really changes (not on first paint).
  var swapReady = false;
  setTimeout(function () { swapReady = true; }, 1500);
  function swapText(node, txt) {
    if (node.textContent === txt) return;
    node.textContent = txt;
    if (!swapReady || document.hidden) return;
    node.classList.remove('swap'); void node.offsetWidth; node.classList.add('swap');
  }

  // Cover art: the old cover stays until the new one is fully loaded, then the new one fades in over it
  // (two stacked <img>s). A light sweep runs on the placeholder while loading.
  var artWrap = el.art.parentNode, artB = el.art.cloneNode(false), artTok = 0, artOld = null;
  artB.removeAttribute('id'); artWrap.appendChild(artB);
  function setArt(src) {
    if (src === lastArt) return;
    lastArt = src;
    var tok = ++artTok;
    if (!src) {
      artWrap.classList.remove('loading');
      el.art.classList.remove('ok'); artB.classList.remove('ok');
      applyAccent(null);
      return;
    }
    artWrap.classList.add('loading');
    var im = new Image();
    im.crossOrigin = 'anonymous'; // lets the accent color be read from the picture
    im.onload = function () {
      if (tok !== artTok) return;
      artWrap.classList.remove('loading');
      var front = el.art.classList.contains('ok') ? artB : el.art, back = front === el.art ? artB : el.art;
      front.src = im.src;
      front.style.zIndex = 2; back.style.zIndex = 1;
      front.classList.remove('pop'); void front.offsetWidth;
      front.classList.add('ok', 'pop');
      clearTimeout(artOld);
      artOld = setTimeout(function () { back.classList.remove('ok'); }, 470);
      if (front !== el.art) { var t = el.art; el.art = artB; artB = t; } // el.art always points at the visible one
      applyAccent(im);
    };
    im.onerror = function () {
      if (tok !== artTok) return;
      artWrap.classList.remove('loading');
      el.art.classList.remove('ok'); artB.classList.remove('ok');
      applyAccent(null);
    };
    im.src = pcUrl(src);
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
    if (state.screen === 'mixer') renderMixer();
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
    var bg = $('bg'); bg.classList.remove('bgswap'); void bg.offsetWidth; bg.classList.add('bgswap');
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
  // Clock faces: 'digital' (time, date, weather), 'analog' (a clock face beside the date), 'big' (just the time, huge).
  (function buildTicks() {
    var g = $('a-ticks'), NS = 'http://www.w3.org/2000/svg';
    for (var i = 0; i < 60; i++) {
      var big = i % 5 === 0, a = i * Math.PI / 30, r1 = big ? 80 : 86, r2 = 91;
      var l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', (100 + r1 * Math.sin(a)).toFixed(2)); l.setAttribute('y1', (100 - r1 * Math.cos(a)).toFixed(2));
      l.setAttribute('x2', (100 + r2 * Math.sin(a)).toFixed(2)); l.setAttribute('y2', (100 - r2 * Math.cos(a)).toFixed(2));
      l.setAttribute('class', big ? 'a-tk big' : 'a-tk');
      g.appendChild(l);
    }
  })();
  function face() { return state.config.clockFace || 'digital'; }
  function renderAnalog(d) {
    var s = d.getSeconds(), m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
    $('a-h').setAttribute('transform', 'rotate(' + (h * 30).toFixed(2) + ' 100 100)');
    $('a-m').setAttribute('transform', 'rotate(' + (m * 6).toFixed(2) + ' 100 100)');
    $('a-s').setAttribute('transform', 'rotate(' + (s * 6) + ' 100 100)');
  }
  function applyClockLayout() {
    var sc = $('s-clock'), f = face();
    sc.classList.toggle('face-analog', f === 'analog');
    sc.classList.toggle('face-big', f === 'big');
    renderForecast(); renderAgenda();
  }

  // Calendar: the next events from the PC (Google/Outlook iCal address set in the dashboard).
  var agenda = null;
  function setCalendar(d) { agenda = d; renderAgenda(); }
  function dayLabel(t, now) {
    var a = new Date(t), b = new Date(now);
    var da = new Date(a.getFullYear(), a.getMonth(), a.getDate()), db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    var diff = Math.round((da - db) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return a.toLocaleDateString(undefined, { weekday: 'long' });
  }
  function timeLabel(t) {
    var d = new Date(t), h = d.getHours(), mi = d.getMinutes();
    if (state.config.clock24) return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
    return ((h % 12) || 12) + ':' + (mi < 10 ? '0' : '') + mi + (h < 12 ? ' AM' : ' PM');
  }
  var agendaKey = '';
  function renderAgenda() {
    var box = $('c-agenda'), ev = agenda && agenda.events ? agenda.events : [];
    var now = Date.now() + state.clockOffset;
    ev = ev.filter(function (e) { return e.end > now || (e.allDay && e.end >= now); }).slice(0, 5);
    var show = ev.length > 0 && face() !== 'big';
    $('s-clock').classList.toggle('has-agenda', show);
    box.hidden = !show;
    if (!show) return;
    var html = '', lastDay = '', wheres = 0;
    ev.forEach(function (e) {
      var day = dayLabel(e.start, now), on = !e.allDay && e.start <= now && e.end > now;
      if (day !== lastDay) { html += '<div class="ag-day">' + escHtml(day) + '</div>'; lastDay = day; }
      var when = e.allDay ? 'All day' : on ? 'Now · until ' + timeLabel(e.end) : timeLabel(e.start);
      html += '<div class="ag-ev' + (on ? ' on' : '') + '"><span class="ag-t">' + escHtml(when) + '</span><span class="ag-n">' + escHtml(e.title) + '</span>' +
        (e.where && ++wheres <= 2 ? '<span class="ag-w">' + escHtml(e.where) + '</span>' : '') + '</div>';
    });
    if (html !== agendaKey) { agendaKey = html; $('c-ag-list').innerHTML = html; }
  }
  setInterval(function () { if (state.screen === 'clock') renderAgenda(); }, 30000);

  // 5-day forecast row under the clock.
  var fcKey = '';
  function renderForecast() {
    var box = $('c-fc'), w = weather;
    var days = w && w.days && state.config.clockForecast !== false && state.config.weather !== false && face() !== 'big' &&
      Date.now() - w.at < 6 * 3600 * 1000 ? w.days.slice(0, 5) : [];
    box.hidden = days.length < 2;
    if (box.hidden) return;
    var html = '';
    days.forEach(function (x, i) {
      var p = String(x.d).split('-'), dt = new Date(+p[0], +p[1] - 1, +p[2]);
      var name = i === 0 ? 'Today' : dt.toLocaleDateString(undefined, { weekday: 'short' });
      html += '<div class="fc-d"><span class="fc-n">' + escHtml(name) + '</span>' + wxIcon(x.code, true) + '<span class="fc-t"><b>' + x.hi + '°</b> ' + x.lo + '°</span></div>';
    });
    if (html !== fcKey) { fcKey = html; box.innerHTML = html; }
  }

  function renderClock() {
    var d = new Date(Date.now() + state.clockOffset);
    if (face() === 'analog') renderAnalog(d);
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
    if (html !== offlineLast) { offlineLast = html; $('o-time').innerHTML = html; $('o-date').textContent = dateText(d); renderWeather(); }
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
  // Live: the last 3 minutes of CPU (a point every 2 s). History: the last hour from the PC (a point every 10 s).
  var graph = { el: $('st-graph'), points: [], hist: [], dpr: Math.min(window.devicePixelRatio || 1, 2) };
  var HIST_COLORS = { mem: '#a78bfa', gpu: '#34d399' };
  function pushGraph(s) {
    if (!s) return;
    var mem = s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
    graph.points.push({ cpu: s.cpu, mem: mem, gpu: s.gpu && s.gpu.load >= 0 ? s.gpu.load : -1 });
    if (graph.points.length > 90) graph.points.shift();
  }
  function setHistory(list) { graph.hist = Array.isArray(list) ? list.slice(-360) : []; if (state.screen === 'stats') drawGraph(); }
  function addHistory(p) { if (!p) return; graph.hist.push(p); if (graph.hist.length > 360) graph.hist.shift(); }
  function sizeGraph() {
    var c = graph.el, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * graph.dpr) || c.height !== Math.round(h * graph.dpr)) { c.width = Math.round(w * graph.dpr); c.height = Math.round(h * graph.dpr); }
  }
  function drawGraph() {
    var c = graph.el; sizeGraph();
    var ctx = c.getContext('2d'), W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    // A full hour once the PC has collected a few minutes of it, otherwise the live last minutes.
    var useHist = graph.hist.length >= 12, pts = useHist ? graph.hist : graph.points, slots = useHist ? 359 : 89;
    setText($('st-hist-label'), useHist ? 'Last hour' : 'Last few minutes');
    if (pts.length < 2) return;
    var accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5b8cff';
    var step = W / slots, pad = 6 * graph.dpr, d = graph.dpr;
    // grid: 25 / 50 / 75 %
    ctx.strokeStyle = 'rgba(127,127,127,.16)'; ctx.lineWidth = 1;
    for (var g = 1; g < 4; g++) { var gy = Math.round(pad + (H - pad * 2) * g / 4) + 0.5; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
    var hasGpu = pts.some(function (p) { return p.gpu >= 0; });
    $('st-leg-gpu').hidden = $('st-leg-gpu-t').hidden = !hasGpu;
    function line(key, color, fill) {
      ctx.beginPath();
      var started = false, x0 = 0, xl = 0;
      for (var i = 0; i < pts.length; i++) {
        var v = pts[i][key];
        if (!(v >= 0)) continue;
        var x = W - (pts.length - 1 - i) * step, y = H - pad - (Math.min(100, v) / 100) * (H - pad * 2);
        if (!started) { ctx.moveTo(x, y); x0 = x; started = true; } else ctx.lineTo(x, y);
        xl = x;
      }
      if (!started) return;
      ctx.lineWidth = 2 * d; ctx.strokeStyle = color; ctx.lineJoin = 'round'; ctx.stroke();
      if (fill) { ctx.lineTo(xl, H); ctx.lineTo(x0, H); ctx.closePath(); ctx.globalAlpha = 0.14; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1; }
    }
    line('mem', HIST_COLORS.mem, false);
    if (hasGpu) line('gpu', HIST_COLORS.gpu, false);
    line('cpu', accent, true);
  }
  function speed(bps) {
    if (!(bps >= 0)) return ['–', ''];
    if (bps >= 1048576) return [(bps / 1048576).toFixed(bps >= 10485760 ? 0 : 1), 'MB/s'];
    if (bps >= 1024) return [String(Math.round(bps / 1024)), 'KB/s'];
    return [String(bps), 'B/s'];
  }
  var coreKey = '';
  function renderCores(list) {
    var box = $('st-cores-bars');
    list = list || [];
    $('st-cores-box').hidden = !list.length;
    if (!list.length) return;
    if (coreKey !== String(list.length)) {
      coreKey = String(list.length);
      var html = '';
      for (var i = 0; i < list.length; i++) html += '<i><b></b></i>';
      box.innerHTML = html;
      box.style.setProperty('--n', list.length);
      setText($('st-cores-label'), list.length + ' threads');
    }
    var bars = box.children;
    for (var j = 0; j < list.length; j++) {
      var b = bars[j].firstChild;
      b.style.transform = 'scaleY(' + Math.max(0.02, list[j] / 100) + ')';
      b.style.opacity = (0.45 + 0.55 * list[j] / 100).toFixed(2);
    }
  }
  function gb(n) { return (n / 1073741824).toFixed(1); }
  function renderStats() {
    var s = state.stats;
    if (!s) return;
    var memPct = Math.round((s.memUsed / s.memTotal) * 100);
    var up = s.uptime, dd = Math.floor(up / 86400), hh = Math.floor((up % 86400) / 3600), mi = Math.floor((up % 3600) / 60);
    setText($('st-host'), (s.host || 'PC') + ' · up ' + (dd ? dd + 'd ' : '') + hh + 'h ' + mi + 'm');
    setText($('st-cpu'), String(s.cpu));
    $('st-cpu-f').style.transform = 'scaleX(' + s.cpu / 100 + ')';
    var cl = s.coresLoad || [], peak = cl.length ? Math.max.apply(null, cl) : -1;
    setText($('st-cores'), s.cores + ' threads' + (peak >= 0 ? ' · busiest ' + peak + '%' : ''));
    setText($('st-mem'), String(memPct));
    $('st-mem-f').style.transform = 'scaleX(' + memPct / 100 + ')';
    setText($('st-mem-s'), gb(s.memUsed) + ' / ' + gb(s.memTotal) + ' GB');
    var g = s.gpu;
    $('st-gpu-card').hidden = !g || g.load < 0;
    if (g && g.load >= 0) {
      setText($('st-gpu'), String(g.load));
      $('st-gpu-f').style.transform = 'scaleX(' + g.load / 100 + ')';
      setText($('st-gpu-t'), g.temp > 0 ? g.temp + '°C' : '');
      var bits = [];
      if (g.hotspot > 0) bits.push('hotspot ' + g.hotspot + '°C');
      if (g.power > 0) bits.push(g.power + ' W');
      if (g.vram > 0) bits.push((g.vram / 1024).toFixed(1) + ' GB VRAM');
      setText($('st-gpu-s'), bits.join(' · '));
    }
    $('st-net-card').hidden = !s.net;
    if (s.net) {
      var rx = speed(s.net.rx), tx = speed(s.net.tx);
      setText($('st-rx'), rx[0]); setText($('st-rx-u'), rx[1]);
      setText($('st-tx'), '↑ ' + tx.join(' ') + ' up');
    }
    renderCores(cl);
    drawGraph();
  }

  /* ============================================================ shortcuts */
  var ICONS = ['mic', 'desktop', 'lock', 'camera', 'music', 'play', 'chart', 'folder', 'bolt', 'globe', 'game', 'code', 'chat', 'power', 'vol', 'next'];
  // Buttons are laid out by group (Audio, System, Apps...): a tab for each group, or all groups together.
  // A button can show live state under its label: the playing track, or whether the PC's sound is muted.
  var padTab = store.get('padTab', '');
  var liveKeys = []; // [{ el, sub, kind }]
  function padGroups(list) {
    var names = [];
    list.forEach(function (sc) { if (sc.group && names.indexOf(sc.group) < 0) names.push(sc.group); });
    return names;
  }
  function makeKey(sc) {
    var b = document.createElement('button');
    b.className = 'key';
    b.style.setProperty('--kc', sc.color);
    var icon = ICONS.indexOf(sc.icon) >= 0 ? sc.icon : 'bolt';
    b.innerHTML = '<svg class="ic"><use href="#i-' + icon + '"/></svg><span class="tx"><span class="lb"></span><span class="sub" hidden></span></span><i class="dot" hidden></i>';
    b.querySelector('.lb').textContent = sc.label;
    b.addEventListener('click', function () {
      buzz();
      if (!send({ t: 'shortcut', id: sc.id })) return toast('Not connected');
      b.classList.add('hit');
      setTimeout(function () { b.classList.remove('hit'); }, 180);
    });
    if (sc.live === 'media' || sc.live === 'sound') liveKeys.push({ el: b, kind: sc.live });
    return b;
  }
  function renderPad() {
    var pad = $('pad'), list = state.config.shortcuts || [];
    pad.textContent = '';
    liveKeys = [];
    if (!list.length) {
      var e = document.createElement('div'); e.className = 'empty';
      e.textContent = 'No shortcuts yet. Add some in the PhoneDesk dashboard on your PC.';
      pad.appendChild(e); return;
    }
    var names = padGroups(list);
    if (padTab && names.indexOf(padTab) < 0) padTab = '';
    pad.classList.toggle('grouped', names.length > 0);
    if (names.length) {
      var tabs = document.createElement('div'); tabs.className = 'pad-tabs'; tabs.setAttribute('role', 'tablist');
      ['All'].concat(names).forEach(function (n, i) {
        var t = document.createElement('button');
        t.setAttribute('role', 'tab');
        t.textContent = n;
        var val = i === 0 ? '' : n;
        t.setAttribute('aria-selected', val === padTab ? 'true' : 'false');
        t.addEventListener('click', function () { padTab = val; store.set('padTab', val); renderPad(); });
        tabs.appendChild(t);
      });
      pad.appendChild(tabs);
    }
    var body = document.createElement('div'); body.className = 'pad-body';
    var sections = names.length ? names.concat(['']) : [''];
    sections.forEach(function (g) {
      if (names.length && padTab && g !== padTab) return;
      var items = list.filter(function (sc) { return (sc.group || '') === g; });
      if (!items.length) return;
      var sec = document.createElement('div'); sec.className = 'pad-sec';
      if (names.length && padTab === '') { var h = document.createElement('div'); h.className = 'pad-h'; h.textContent = g || 'Other'; sec.appendChild(h); }
      var grid = document.createElement('div'); grid.className = 'pad-grid';
      grid.style.setProperty('--n', Math.min(items.length, 4));
      items.forEach(function (sc) { grid.appendChild(makeKey(sc)); });
      sec.appendChild(grid);
      body.appendChild(sec);
    });
    pad.appendChild(body);
    renderLive();
  }
  function renderLive() {
    liveKeys.forEach(function (k) {
      var sub = k.el.querySelector('.sub'), dot = k.el.querySelector('.dot'), text = '', color = '', alert = false;
      if (k.kind === 'media') {
        var m = state.media;
        if (m.active && m.status === 'Playing') { text = 'Playing' + (m.title ? ' · ' + m.title : ''); color = '#4fd98a'; }
        else if (m.active) { text = 'Paused' + (m.title ? ' · ' + m.title : ''); color = '#e5a000'; }
        else text = 'Nothing playing';
      } else {
        var muted = !!(state.volume && state.volume.muted);
        text = muted ? 'Sound muted · tap to unmute' : 'Sound on'; color = muted ? '#ef6a6a' : '#4fd98a'; alert = muted;
      }
      sub.hidden = !text; setText(sub, text);
      dot.hidden = !color; if (color) dot.style.background = color;
      toggle(k.el, 'alert', alert);
    });
  }

  /* ============================================================ screens + navigation */
  function imm() { return state.config.nowStyle !== 'classic'; }
  // In the immersive style lyrics are a sheet you pull up over Now playing, not a screen of their own.
  function screens() {
    var l = state.config.screens && state.config.screens.length ? state.config.screens : ['media'];
    if (imm()) l = l.filter(function (s) { return s !== 'lyrics'; });
    return l.length ? l : ['media'];
  }

  function show(name) {
    var list = screens();
    if (list.indexOf(name) < 0) name = list[0];
    var from = list.indexOf(state.screen), to = list.indexOf(name);
    $('screens').setAttribute('data-dir', from < 0 || from === to ? 'none' : (to > from ? 'next' : 'prev'));
    state.screen = name;
    closeLyrics(true);
    document.body.classList.toggle('scr-media', name === 'media');
    document.body.classList.toggle('scr-lyrics', name === 'lyrics');
    store.set('screen', name);
    var secs = document.querySelectorAll('.screen');
    for (var i = 0; i < secs.length; i++) toggle(secs[i], 'on', secs[i].getAttribute('data-screen') === name);
    var dots = $('dots').children;
    for (var j = 0; j < dots.length; j++) toggle(dots[j], 'on', dots[j].getAttribute('data-s') === name);
    send({ t: 'screen', v: name });
    renderAll();
  }

  function renderAll() {
    if (state.screen === 'media') { renderMedia(); drawVolume(state.volume.level, state.volume.muted); npLast = ''; renderNpTop(); }
    else if (state.screen === 'mixer') renderMixer(true);
    else if (state.screen === 'lyrics') { renderLyricsHead(); lyricTick(true); lyStart(); }
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
    $('screens').setAttribute('data-dir', dir > 0 ? 'next' : 'prev'); // wrapping around keeps the swipe direction
  }

  // Swipe left/right anywhere (except on sliders) to change screen.
  (function () {
    var sx = 0, sy = 0, st = 0, active = false;
    var root = $('screens');
    root.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.slider, .track, .ly-pill, .ly-close, .ly-nudge')) { active = false; return; }
      var p = pt(e); active = true; sx = p.x; sy = p.y; st = Date.now();
    });
    root.addEventListener('pointerup', function (e) {
      if (!active) return;
      active = false;
      var p = pt(e), dx = p.x - sx, dy = p.y - sy;
      if (Date.now() - st > 800) return;
      var lyOpen = document.body.classList.contains('ly-open');
      if (Math.abs(dy) > 55 && Math.abs(dy) > Math.abs(dx) * 1.4 && imm()) {
        if (lyOpen && dy > 0) closeLyrics();
        else if (!lyOpen && dy < 0 && state.screen === 'media') openLyrics();
        return;
      }
      if (lyOpen) return;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) step(dx < 0 ? 1 : -1);
    });
    root.addEventListener('pointercancel', function () { active = false; });
  })();

  function applyConfig(c) {
    var prevShortcuts = JSON.stringify(state.config.shortcuts), prevScreens = JSON.stringify(state.config.screens) + state.config.nowStyle;
    state.config = c;
    syncKinetic();
    document.body.classList.toggle('ns-imm', c.nowStyle !== 'classic');
    placeSourcePill();
    if (c.nowStyle === 'classic') closeLyrics(true);
    document.body.className = document.body.className.replace(/theme-\w+/, '') + ' theme-' + (c.theme || 'dark');
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', c.theme === 'light' ? '#f4f5f7' : c.theme === 'black' ? '#000000' : '#0e0f12');
    currentTint = '';
    applyAccent(el.art.classList.contains('ok') ? el.art : null);
    if (JSON.stringify(c.shortcuts) !== prevShortcuts) renderPad();
    renderBattery();
    applyClockLayout();
    applyNight(true);
    burnShift();
    if (JSON.stringify(c.screens) + c.nowStyle !== prevScreens || !$('dots').children.length) { renderDots(); show(state.screen); }
    else renderAll();
    armDim();
  }

  /* ============================================================ night mode */
  // Off, on a schedule, or when the room is dark (the phone app's light sensor; the schedule elsewhere).
  // At night: dim, optionally red, optionally on the clock; the phone app also turns the screen itself down.
  var night = { on: false, prevScreen: '', dark: false };
  function minutesOf(hm) { var p = String(hm || '').split(':'); return (+p[0] || 0) * 60 + (+p[1] || 0); }
  function inSchedule() {
    var d = new Date(Date.now() + state.clockOffset), m = d.getHours() * 60 + d.getMinutes();
    var a = minutesOf(state.config.nightFrom || '22:00'), b = minutesOf(state.config.nightTo || '07:00');
    return a === b ? false : a < b ? (m >= a && m < b) : (m >= a || m < b);
  }
  function appLux() {
    try { var a = window.PhoneDeskApp; if (a && a.getLux) { var v = +a.getLux(); return v >= 0 ? v : -1; } } catch (e) {}
    return -1;
  }
  function wantNight() {
    var mode = state.config.nightMode || 'off';
    if (mode === 'off') return false;
    if (mode === 'sensor') {
      var lux = appLux();
      if (lux >= 0) { night.dark = night.dark ? lux < 12 : lux < 4; return night.dark; } // a little hysteresis
    }
    return inSchedule();
  }
  function setAppBrightness(v) { try { var a = window.PhoneDeskApp; if (a && a.setBrightness) a.setBrightness(v); } catch (e) {} }
  function applyNight(force) {
    var on = wantNight();
    toggle(document.body, 'night-red', on && state.config.nightRed !== false);
    if (on === night.on && !force) return;
    night.on = on;
    toggle(document.body, 'night', on);
    if (on) {
      setAppBrightness(0.02);
      if (state.config.nightClock !== false && screens().indexOf('clock') >= 0 && state.screen !== 'clock') { night.prevScreen = state.screen; show('clock'); }
    } else {
      setAppBrightness(-1);
      if (night.prevScreen && state.screen === 'clock' && screens().indexOf(night.prevScreen) >= 0) show(night.prevScreen);
      night.prevScreen = '';
    }
  }
  setInterval(function () { applyNight(false); }, 15000);

  /* ============================================================ burn-in protection */
  // Every few minutes everything moves to a new spot a few pixels away (slowly, so nobody notices).
  function burnShift() {
    var r = document.documentElement.style;
    if (state.config.burnIn === false) { r.setProperty('--bx', '0px'); r.setProperty('--by', '0px'); return; }
    r.setProperty('--bx', Math.round(Math.random() * 12 - 6) + 'px');
    r.setProperty('--by', Math.round(Math.random() * 8 - 4) + 'px');
  }
  setInterval(burnShift, 3 * 60 * 1000);

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
  if (window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || /PhoneDeskApp/.test(navigator.userAgent)) document.body.classList.add('fullscreen');

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
    placeSourcePill();
    if (!show) return;
    var pct = Math.round(b.level * 100);
    $('batt-fill').setAttribute('width', (19 * Math.max(0.06, b.level)).toFixed(1));
    $('batt-bolt').style.display = b.charging ? '' : 'none';
    setText($('batt-n'), pct + '%');
    toggle(el, 'low', pct <= 20 && !b.charging);
    toggle(el, 'charging', !!b.charging);
    placeSourcePill();
  }
  // Immersive: the source pill (Spotify, YouTube...) sits right after the battery pill, with the same gap as the
  // pills on the right, whatever width the battery reading has.
  function placeSourcePill() {
    var pill = el.app.parentNode, b = $('batt');
    if (!imm()) { pill.style.left = ''; return; }
    var left = b.hidden ? 14 : b.offsetLeft + b.offsetWidth + 8;
    pill.style.left = left + 'px';
  }
  window.addEventListener('resize', placeSourcePill);
  // Only available on secure origins (USB uses localhost, so it works there).
  if (navigator.getBattery) {
    navigator.getBattery().then(function (b) {
      battery = b;
      b.addEventListener('levelchange', reportBattery);
      b.addEventListener('chargingchange', reportBattery);
      reportBattery();
    }).catch(function () {});
  }

  // Fully Kiosk Browser (and similar kiosk apps) expose the battery through their own JavaScript interface.
  function kioskBattery() {
    try {
      var f = window.fully || window.PhoneDeskApp;
      if (!f || !f.getBatteryLevel) return;
      var lvl = +f.getBatteryLevel();
      if (!(lvl >= 0)) return;
      battery = { level: Math.min(1, lvl / 100), charging: !!(f.isPlugged && f.isPlugged()) };
      reportBattery();
    } catch (e) {}
  }
  if (!navigator.getBattery) { kioskBattery(); setInterval(kioskBattery, 30000); }
  // One-off facts for the PC's log, so a missing battery can be diagnosed.
  setTimeout(function () {
    var f = window.fully || window.PhoneDeskApp, d = { secure: !!window.isSecureContext, batteryApi: !!navigator.getBattery, fully: typeof f, level: null, err: '' };
    try { if (f && f.getBatteryLevel) d.level = f.getBatteryLevel(); else if (f) d.keys = Object.keys(f).slice(0, 8).join(','); } catch (e) { d.err = String(e && e.message || e); }
    send({ t: 'diag', d: d });
  }, 4000);

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

  /* ============================================================ sliders (mixer) */
  // A drag slider that works whether or not the app is rotated. onChange(value 0..1, done)
  function bindSlider(el, onChange) {
    var rect = null, dragging = false;
    function at(e) { return Math.min(1, Math.max(0, (pt(e).x - rect.left) / rect.width)); }
    el.addEventListener('pointerdown', function (e) {
      dragging = true; rect = appRect(el); el.setPointerCapture(e.pointerId); el.classList.add('drag');
      el._dragging = true; onChange(at(e), false);
    });
    el.addEventListener('pointermove', function (e) { if (dragging) onChange(at(e), false); });
    function end(e) {
      if (!dragging) return;
      dragging = false; el.classList.remove('drag');
      onChange(at(e), true);
      setTimeout(function () { el._dragging = false; }, 600);
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  function drawSlider(el, level) {
    if (el._dragging) return;
    el.querySelector('.fill').style.transform = 'scaleX(' + level + ')';
    el.querySelector('.knob').style.transform = 'translateX(' + Math.round(level * (el.clientWidth || 1)) + 'px)';
  }
  function throttle(fn, ms) {
    var last = 0, timer = null, args = null;
    return function () {
      args = arguments;
      var now = Date.now();
      if (now - last >= ms) { last = now; fn.apply(null, args); }
      else if (!timer) timer = setTimeout(function () { timer = null; last = Date.now(); fn.apply(null, args); }, ms - (now - last));
    };
  }

  /* ============================================================ mixer screen */
  state.mixer = [];
  var mixerKey = '', mixerRows = {};
  var SPEAKER = '<svg><use href="#i-vol"/></svg>';
  function mixerRowHtml(id, name, cls) {
    return '<div class="mx-row ' + cls + '" data-id="' + id + '"><button class="mx-ic" aria-label="Mute ' + name.replace(/"/g, '') + '"></button>' +
      '<span class="mx-name"></span><div class="slider"><div class="fill"></div><div class="knob"></div></div><span class="mx-num"></span></div>';
  }
  function renderMixer(force) {
    var box = $('mixer');
    var fit = Math.max(2, Math.floor(((parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ah')) || 360) - 70) / 56));
    var apps = state.mixer.slice(0, fit - 1);
    var key = apps.map(function (a) { return a.pid; }).join(',') + '|' + (state.mixer.length - apps.length);
    if (force || key !== mixerKey) {
      mixerKey = key;
      var html = mixerRowHtml('master', 'PC volume', 'master');
      apps.forEach(function (a) { html += mixerRowHtml(a.pid, a.name, ''); });
      if (state.mixer.length > apps.length) html += '<div class="mx-more">+' + (state.mixer.length - apps.length) + ' more apps playing sound</div>';
      box.innerHTML = html;
      mixerRows = {};
      Array.prototype.forEach.call(box.querySelectorAll('.mx-row'), function (row) {
        var id = row.getAttribute('data-id');
        mixerRows[id] = row;
        var slider = row.querySelector('.slider');
        var push = throttle(function (v) {
          if (id === 'master') send({ t: 'volume', v: v }); else send({ t: 'appvol', pid: +id, v: v });
        }, 70);
        bindSlider(slider, function (v, done) {
          slider.querySelector('.fill').style.transform = 'scaleX(' + v + ')';
          slider.querySelector('.knob').style.transform = 'translateX(' + Math.round(v * slider.clientWidth) + 'px)';
          setText(row.querySelector('.mx-num'), String(Math.round(v * 100)));
          push(v);
          if (done && id !== 'master') { var a = findApp(+id); if (a) a.level = v; }
        });
        row.querySelector('.mx-ic').addEventListener('click', function () {
          buzz();
          if (id === 'master') send({ t: 'mute' }); else send({ t: 'appmute', pid: +id });
        });
      });
    }
    // values
    paintRow(mixerRows.master, 'PC volume', state.volume.level, state.volume.muted, SPEAKER, false);
    apps.forEach(function (a) {
      var ic = a.icon ? '<img src="' + pcUrl(a.icon) + '" alt="">' : SPEAKER;
      paintRow(mixerRows[a.pid], a.name, a.level, a.muted, ic, a.active);
    });
  }
  function findApp(pid) { for (var i = 0; i < state.mixer.length; i++) if (state.mixer[i].pid === pid) return state.mixer[i]; return null; }
  function paintRow(row, name, level, muted, iconHtml, live) {
    if (!row) return;
    var ic = row.querySelector('.mx-ic');
    if (ic.getAttribute('data-ic') !== iconHtml) { ic.setAttribute('data-ic', iconHtml); ic.innerHTML = muted ? '<svg><use href="#i-mute"/></svg>' : iconHtml; }
    if (muted && ic.innerHTML.indexOf('i-mute') < 0) ic.innerHTML = '<svg><use href="#i-mute"/></svg>';
    if (!muted && ic.innerHTML.indexOf('i-mute') >= 0) ic.innerHTML = iconHtml;
    toggle(ic, 'live', !!live && !muted);
    toggle(row, 'muted', !!muted);
    setText(row.querySelector('.mx-name'), name);
    var slider = row.querySelector('.slider');
    if (!slider._dragging) { drawSlider(slider, level); setText(row.querySelector('.mx-num'), String(Math.round(level * 100))); }
  }

  /* ============================================================ lyrics screen */
  var lyr = null, lyrIndex = -2;
  function renderCredit(d) {
    var t = '';
    if (d && d.credit && d.lines && d.lines.length) {
      var c = d.credit;
      t = 'Lyrics: ' + c.provider;
      if (c.uploader) t += ' · uploaded by ' + c.uploader.name;
      if (c.maker) t += ' · made by ' + c.maker.name;
    }
    setText($('ly-credit'), t); setText($('ly-credit2'), t);
  }
  function setLyrics(d) {
    renderCredit(d);
    // Plain lyrics (no timestamps): spread the lines over the song by their length so they still scroll and light up.
    // Approximate; the Earlier/Later buttons fine-tune it.
    if (d && !d.synced && !d.instrumental && d.lines && d.lines.length > 2 && state.media.active && state.media.duration > 30) {
      var dur = state.media.duration, t0 = Math.min(12, dur * 0.07), t1 = dur * 0.93, tot = 0, acc = 0;
      var wts = d.lines.map(function (l) { return l.text ? l.text.length + 8 : 6; });
      wts.forEach(function (x) { tot += x; });
      d.lines.forEach(function (l, i) { l.t = t0 + (t1 - t0) * acc / tot; acc += wts[i]; });
      d.synced = true; d.estimated = true;
    }
    $('ly-est').hidden = !(d && d.estimated);
    lyr = d;
    lyrIndex = -2;
    syncKinetic();
    var list = $('ly-list');
    list.style.transform = 'translateY(0)';
    if (!d || !d.lines || !d.lines.length) {
      list.innerHTML = '';
      lyMusicOn = false; lyMusicTxt = '#';
      if (!state.media.active) { lyMusic(''); $('ly-msg').hidden = false; setText($('ly-msg'), 'Play a song on your PC'); return; }
      $('ly-msg').hidden = true;
      lyMusic(!d ? 'Looking for lyrics…' : d.instrumental ? 'Instrumental' : 'No lyrics for this song');
      return;
    }
    $('ly-msg').hidden = true;
    lyMusicOn = true; lyMusicTxt = '#'; lyMusic('');
    var frag = document.createDocumentFragment();
    d.lines.forEach(function (l) {
      var div = document.createElement('div');
      div.className = 'ly-line' + (l.text ? '' : ' gap');
      if (isRtl(l.text)) div.dir = 'rtl';
      if (l.text) {
        var words = l.text.split(/\s+/), total = 0, acc = 0, spans = [], wf = [];
        words.forEach(function (w) { total += w.length + 1; });
        words.forEach(function (w, k) {
          var sp = document.createElement('span');
          sp.className = 'w'; sp.textContent = w;
          div.appendChild(sp);
          if (k < words.length - 1) div.appendChild(document.createTextNode(' '));
          spans.push(sp); wf.push(acc / total); acc += w.length + 1;
        });
        if (l.words && l.words.length === words.length && l.dur > 0) {
          wf = l.words.map(function (w) { return Math.max(0, Math.min(0.98, (w.t - l.t) / l.dur)); });
        }
        div._w = spans; div._wf = wf; div._cur = -2;
      }
      else div.innerHTML = '<i></i><i></i><i></i>';
      frag.appendChild(div);
    });
    list.textContent = '';
    list.appendChild(frag);
    lyricTick(true); lyStart();
  }
  function renderLyricsHead() {
    var m = state.media;
    var art = m.active && m.art ? pcUrl(m.art) : '', img = $('ly-art');
    if (img.getAttribute('data-src') !== art) {
      img.setAttribute('data-src', art);
      if (art) { img.onload = function () { img.hidden = false; $('ly-noart').hidden = true; }; img.onerror = function () { img.hidden = true; $('ly-noart').hidden = false; }; img.src = art; }
      else { img.removeAttribute('src'); img.hidden = true; $('ly-noart').hidden = false; }
    }
    setText($('ly-t'), m.active ? (m.title || '') : '');
    lyShowOffset();
    setText($('ly-a'), m.active ? (m.artist || '') : '');
    if (lyr && !lyr.synced && !lyr.instrumental && lyr.lines && lyr.lines.length > 2 && m.active && m.duration > 30) setLyrics(lyr);
    setText($('ly-song'), m.active ? (m.title || '') + (m.artist ? ' — ' + m.artist : '') : '');
    var ic = m.active ? (m.site === 'youtube' ? VIDEO_ICON : m.appIcon ? '<img src="' + pcUrl(m.appIcon) + '" alt="">' : '') : '';
    if ($('ly-ic').getAttribute('data-ic') !== ic) { $('ly-ic').setAttribute('data-ic', ic); $('ly-ic').innerHTML = ic; }
    if (!lyr) setLyrics(null);
  }
  // Where in the song are we? Binary search over the line start times.
  // How long a line is actually sung: most of the gap to the next line, but not stretched over a long instrumental break.
  function lySung(len, gap) {
    var expected = Math.max(1.5, (len / 10) * 1.7);
    return Math.max(0.8, Math.min(gap * 0.92, expected));
  }
  // The melody indicator: bars that dance while the music plays but nobody is singing (intro, instrumental break, outro),
  // or when there are no lyrics for the song.
  var lyMusicOn = false, lyMusicTxt = '';
  function lyMusic(txt) {
    var on = !!txt;
    if (on === lyMusicOn && txt === lyMusicTxt) return;
    lyMusicOn = on; lyMusicTxt = txt;
    $('ly-music').classList.toggle('show', on);
    if (on) setText($('ly-music-t'), txt);
    $('ly-list').classList.toggle('idle', on && !!lyr && !!lyr.lines && lyr.lines.length > 0);
  }
  // '' while someone is singing, otherwise what the music is doing.
  function lyIdleLabel(idx, pos) {
    var L = lyr.lines;
    if (lyr.estimated || !L.length) return '';
    if (idx < 0) return L[0].t - pos > 2.0 ? 'Intro' : '';
    var ln = L[idx], next = L[idx + 1];
    if (!ln.text) return 'Instrumental';
    var gap = (next ? next.t : ln.t + 999) - ln.t, end = ln.t + (ln.dur > 0 ? ln.dur : lySung(ln.text.length, gap));
    if (pos > end + 1.2 && (!next || next.t - pos > 2.0)) return next ? 'Instrumental' : 'Outro';
    return '';
  }
  function lyIndexAt(pos) {
    var L = lyr.lines, lo = 0, hi = L.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (L[mid].t <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  // Light a line a touch early, like the big players do; the dashboard slider shifts this per taste (later = positive).
  var lyTrackOff = store.get('lyoff', {}) || {};
  function lyTrackKey() { var m = state.media; return m && m.active ? (m.title || '') + '|' + (m.artist || '') : ''; }
  function lyTotalOffset() { return (state.config.lyricsOffset || 0) + (lyTrackOff[lyTrackKey()] || 0); }
  function lyLead() { return 0.4 - lyTotalOffset() / 1000; }
  // The two buttons on the lyrics screen: shift this song's lyrics earlier or later (remembered per song on this phone).
  function lyNudge(ms) {
    var k = lyTrackKey();
    if (!k) return;
    lyTrackOff[k] = Math.max(-5000, Math.min(5000, (lyTrackOff[k] || 0) + ms));
    var keys = Object.keys(lyTrackOff);
    if (keys.length > 200) delete lyTrackOff[keys[0]];
    store.set('lyoff', lyTrackOff);
    var t = lyTotalOffset();
    lyShowOffset();
    toast(t === 0 ? 'Lyrics: in sync' : 'Lyrics ' + (Math.abs(t) / 1000).toFixed(2) + ' s ' + (t > 0 ? 'later' : 'earlier'));
    buzz();
    lyrIndex = -2; kinIdx = -2; lyFillAt = 0;
  }
  function lyShowOffset() { var t = lyTotalOffset(); setText($('ly-off'), (t > 0 ? '+' : '') + (t / 1000).toFixed(2) + 's'); }
  $('ly-earlier').addEventListener('click', function () { lyNudge(-150); });
  $('ly-later').addEventListener('click', function () { lyNudge(150); });
  var lyFillAt = 0;
  function lyricTick(force) {
    if (!lyr || !lyr.lines.length || !lyricsVisible()) return;
    var lines = $('ly-list').children, L = lyr.lines;
    if (document.body.classList.contains('ly-kinetic')) return kinTick(force);
    if (!lyr.synced) { if (force && lines[0]) $('ly-list').style.transform = 'translateY(0)'; return; }
    var pos = currentPos() + lyLead(), idx = lyIndexAt(pos);
    lyMusic(lyIdleLabel(idx, pos));
    if (idx !== lyrIndex || force) {
      var from = Math.max(0, Math.min(lyrIndex, idx) - 3), to = Math.min(lines.length - 1, Math.max(lyrIndex, idx) + 3);
      if (force) { from = 0; to = lines.length - 1; }
      for (var i = from; i <= to; i++) {
        var d = i - idx, cls = 'ly-line' + (L[i].text ? '' : ' gap');
        if (d === 0) cls += ' on'; else if (d < 0) cls += d === -1 ? ' past near1' : ' past'; else cls += d === 1 ? ' near1' : d === 2 ? ' near2' : '';
        if (lines[i].className !== cls) {
          var becameActive = d === 0 && lines[i].className.indexOf(' on') < 0;
          lines[i].className = cls;
          if (becameActive && lines[i]._w) { lines[i]._cur = -2; for (var k = 0; k < lines[i]._w.length; k++) lines[i]._w[k].classList.remove('lit'); }
        }
      }
      lyrIndex = idx;
      var cur = lines[Math.max(0, idx)], view = $('ly-view');
      if (cur) {
        var y = cur.offsetTop - view.clientHeight * 0.42 + cur.offsetHeight / 2;
        $('ly-list').style.transform = 'translate3d(0,' + (-Math.max(0, y)) + 'px,0)';
      }
    }
    // Word-by-word fill across the current line, paced by how long the line is sung (estimated from its length).
    if (idx >= 0) {
      var now = Date.now();
      if (force || now - lyFillAt > 45) {
        lyFillAt = now;
        var start = L[idx].t, gap = (L[idx + 1] ? L[idx + 1].t : start + 6) - start;
        var sung = L[idx].dur > 0 ? L[idx].dur : (L[idx].text ? lySung(L[idx].text.length, gap) : gap);
        var p = Math.max(0, Math.min(1, (pos - start) / sung));
        var ln = lines[idx];
        if (ln._w) {
          var cw = -1;
          for (var q = 0; q < ln._wf.length; q++) { if (p >= ln._wf[q]) cw = q; else break; }
          if (cw !== ln._cur) {
            for (var r = 0; r < ln._w.length; r++) ln._w[r].classList.toggle('lit', r <= cw);
            ln._cur = cw;
          }
        }
      }
    }
  }
  /* ---- Kinetic lyrics (Lyric Speaker style): one big line at a time, words appear as they're sung,
     and the motion follows the mood of the line (slow and soft, or quick and punchy). ---- */
  var kinIdx = -2, kinEl = null, kinGone = false, kinEcho = null, kinFlip = false, kinSig = '';
  function syncKinetic() {
    var mode = state.config.lyricsMode || 'scroll', font = state.config.lyricsFont || 'serif';
    var on = mode.indexOf('kinetic') === 0 && !!lyr && !!lyr.synced && !!lyr.lines && lyr.lines.length > 0;
    var had = document.body.classList.contains('ly-kinetic');
    toggle(document.body, 'ly-kinetic', on);
    toggle(document.body, 'ly-dark', on && mode === 'kinetic-dark');
    document.body.setAttribute('data-lf', font);
    var sig = mode + '|' + font + '|' + (state.config.lyricsLines || 'off');
    if (on !== had || !on || sig !== kinSig) { kinSig = sig; kinIdx = -2; kinEl = null; kinEcho = null; $('ly-kin').textContent = ''; lyrIndex = -2; }
  }
  function isRtl(t) { return /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F]/.test(t || ''); }
  function kinRnd(a, b) { return a + Math.random() * (b - a); }
  function kinPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function kinDrop(el, ms) { if (!el) return; el.classList.add('out'); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms); }

  // Measure the laid-out (and tilted) text and make sure it is entirely on the screen: shrink it if it is too big,
  // then slide it back inside if it pokes out.
  function kinFit(el, stage, fs) {
    var sw = stage.clientWidth, sh = stage.clientHeight, mx = sw * 0.05, my = sh * 0.07;
    el.style.transition = 'none';
    var box = function () {
      var sr = stage.getBoundingClientRect(), rows = el.querySelectorAll('.kr'), l = 1e9, t = 1e9, r = -1e9, b = -1e9;
      for (var i = 0; i < rows.length; i++) {
        var q = rows[i].getBoundingClientRect();
        l = Math.min(l, q.left - sr.left); t = Math.min(t, q.top - sr.top); r = Math.max(r, q.right - sr.left); b = Math.max(b, q.bottom - sr.top);
      }
      return { l: l, t: t, r: r, b: b, w: r - l, h: b - t };
    };
    for (var it = 0; it < 6; it++) {
      var bx = box(), aw = sw - 2 * mx, ah = sh - 2 * my;
      if (bx.w <= aw + 1 && bx.h <= ah + 1) break;
      fs *= Math.min(aw / bx.w, ah / bx.h) * 0.96;
      el.style.fontSize = fs.toFixed(1) + 'px';
    }
    var f = box(), dx = 0, dy = 0;
    if (f.l < mx) dx = mx - f.l; else if (f.r > sw - mx) dx = (sw - mx) - f.r;
    if (f.t < my) dy = my - f.t; else if (f.b > sh - my) dy = (sh - my) - f.b;
    el.style.setProperty('--nx', dx.toFixed(1) + 'px');
    el.style.setProperty('--ny', dy.toFixed(1) + 'px');
    el._fs = fs;
    void el.offsetWidth;
    el.style.transition = '';
  }

  // Optional connecting lines: a dot under each word and a line that draws from word to word as they are sung.
  function kinConnect(el, kd, spans, fs) {
    var style = state.config.lyricsLines || 'off';
    if ((style !== 'curve' && style !== 'straight' && style !== 'glass') || spans.length < 2) return;
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'kc');
    svg.setAttribute('width', kd.offsetWidth); svg.setAttribute('height', kd.offsetHeight);
    var enter = [], leave = [];
    spans.forEach(function (sp, k) {
      var cx = sp.offsetLeft + sp.offsetWidth / 2, bottom = sp.offsetTop + sp.offsetHeight * 0.92 + fs * 0.1;
      var top = sp.offsetTop + sp.offsetHeight * 0.1 - fs * 0.1;
      var newRow = k > 0 && sp.parentNode !== spans[k - 1].parentNode;
      leave.push({ x: cx, y: bottom });
      enter.push(newRow ? { x: cx, y: top } : { x: cx, y: bottom });
    });
    var segs = [], dots = [];
    for (var k = 0; k < spans.length - 1; k++) {
      var a = leave[k], b = enter[k + 1], d;
      if (style === 'straight') d = 'M' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) + ' L' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
      else if (Math.abs(a.y - b.y) < fs * 0.4) {
        var my = Math.max(a.y, b.y) + fs * 0.32;
        d = 'M' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) + ' Q' + ((a.x + b.x) / 2).toFixed(1) + ' ' + my.toFixed(1) + ' ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
      } else {
        var dy = (b.y - a.y) * 0.55;
        d = 'M' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) + ' C' + a.x.toFixed(1) + ' ' + (a.y + dy).toFixed(1) + ' ' + b.x.toFixed(1) + ' ' + (b.y - dy).toFixed(1) + ' ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
      }
      var g = document.createElementNS(NS, 'path'); g.setAttribute('d', d); g.setAttribute('class', 'segg');
      var i = document.createElementNS(NS, 'path'); i.setAttribute('d', d); i.setAttribute('class', 'segi'); i.setAttribute('pathLength', '1');
      svg.appendChild(g); svg.appendChild(i); segs.push(i);
    }
    enter.forEach(function (p) {
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', p.x.toFixed(1)); c.setAttribute('cy', p.y.toFixed(1)); c.setAttribute('r', Math.max(2.4, fs * 0.055).toFixed(1)); c.setAttribute('class', 'dot');
      svg.appendChild(c); dots.push(c);
    });
    kd.appendChild(svg);
    el._segs = segs; el._dots = dots;
  }

  // "Linked" lines: every word is joined to the next, and a thread runs from the last word of the previous lyric
  // to the first word of this one, so the whole song is one continuous line.
  var kinFxEl = null, kinLastAnchor = null, kinLastAt = 0;
  function kinFxClear() {
    if (!kinFxEl) return;
    var o = kinFxEl; kinFxEl = null;
    o.classList.add('out');
    setTimeout(function () { if (o.parentNode) o.parentNode.removeChild(o); }, 900);
  }
  function kinFx(el, stage, sung, words, fs) {
    kinFxClear();
    if ((state.config.lyricsLines || 'off') !== 'glass') { kinLastAnchor = null; return; }
    var sr = stage.getBoundingClientRect(), spans = el._w;
    if (!spans || !spans.length) return;
    var anchor = function (sp, top) {
      var q = sp.getBoundingClientRect();
      return { x: q.left - sr.left + q.width / 2, y: (top ? q.top : q.bottom) - sr.top };
    };
    var first = anchor(spans[0], true), last = anchor(spans[spans.length - 1], false);
    var prev = kinLastAnchor && Date.now() - kinLastAt < 15000 ? kinLastAnchor : null;
    kinLastAnchor = last; kinLastAt = Date.now();
    if (!prev) return;
    var NS = 'http://www.w3.org/2000/svg', sw = stage.clientWidth, sh = stage.clientHeight;
    var fx = document.createElement('div'); fx.className = 'kfx';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', sw); svg.setAttribute('height', sh);
    var dy = Math.max(30, Math.abs(first.y - prev.y) * 0.5 + sh * 0.12);
    var d = 'M' + prev.x.toFixed(1) + ' ' + prev.y.toFixed(1) + ' C' + prev.x.toFixed(1) + ' ' + (prev.y + dy).toFixed(1) + ' ' + first.x.toFixed(1) + ' ' + (first.y - dy).toFixed(1) + ' ' + first.x.toFixed(1) + ' ' + first.y.toFixed(1);
    var g = document.createElementNS(NS, 'path'); g.setAttribute('d', d); g.setAttribute('class', 'tg');
    var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('class', 'ti'); p.setAttribute('pathLength', '1');
    svg.appendChild(g); svg.appendChild(p);
    [prev, first].forEach(function (a, k) {
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', a.x.toFixed(1)); c.setAttribute('cy', a.y.toFixed(1)); c.setAttribute('r', Math.max(2.6, fs * 0.055).toFixed(1)); c.setAttribute('class', 'tn' + (k ? ' later' : ''));
      svg.appendChild(c);
    });
    fx.appendChild(svg);
    stage.insertBefore(fx, stage.firstChild);
    kinFxEl = fx; fx._segs = []; fx._marks = [];
    requestAnimationFrame(function () { requestAnimationFrame(function () { fx.classList.add('draw'); }); });
    setTimeout(function () { if (kinFxEl === fx) fx.classList.add('fade'); }, 2600);
  }

  function kinShow(idx) {
    var L = lyr.lines, ln = L[idx], stage = $('ly-kin');
    // The line that was showing shrinks into a faint echo; the echo before it goes.
    if (kinEl) {
      var old = kinEl; kinEl = null;
      if (old.classList.contains('out')) { kinDrop(old, 10); }
      else {
        if (kinEcho) kinDrop(kinEcho, 600);
        old.classList.add('echo', kinFlip ? 'e1' : 'e2');
        kinFlip = !kinFlip;
        kinEcho = old;
      }
    }
    kinGone = false;
    kinFxClear();
    if (!ln || !ln.text) return;
    var gap = (L[idx + 1] ? L[idx + 1].t : ln.t + 6) - ln.t, len = ln.text.length;
    var cps = ln.dur > 0 ? len / ln.dur : len / Math.min(gap, Math.max(1.1, len * 0.085)), sung = ln.dur > 0 ? ln.dur : lySung(len, gap);
    var mood = cps > 14 ? 'hot' : cps < 8 ? 'calm' : 'mid';
    var words = ln.text.split(/\s+/);
    var rtl = isRtl(ln.text);

    // Random ragged rows of 1 to 3 words (never a lone word at the end)
    var rows = [], k = 0;
    while (k < words.length) {
      var n = kinPick([1, 2, 2, 2, 3, 3]);
      if (words.length - k - n === 1) n++;
      rows.push(words.slice(k, k + n)); k += n;
    }
    // One or two emphasis words, chosen among the longer ones
    var cand = [];
    words.forEach(function (x, q) { var c = x.replace(/[^\p{L}\p{N}]/gu, '').length; if (c >= (rtl ? 3 : 4)) cand.push({ q: q, c: c }); });
    cand.sort(function (a, b) { return b.c - a.c + (Math.random() - 0.5) * 2; });
    var ems = {};
    if (cand.length) ems[cand[0].q] = kinRnd(1.4, 1.95);
    if (cand.length > 2 && Math.random() < 0.25) ems[cand[1].q] = kinRnd(1.25, 1.55);

    var vertical = words.length <= 3 && len <= 16 && Math.random() < 0.09;
    var tilt = vertical ? -90 : (Math.random() < 0.22 ? 0 : kinRnd(-9, 9));
    var align = Math.floor(Math.random() * 3);
    var w = stage.clientWidth || 600, h = stage.clientHeight || 260;
    var maxChars = 1;
    rows.forEach(function (r) { maxChars = Math.max(maxChars, r.join(' ').length); });
    var fs = Math.min((w * 0.74) / (maxChars * 0.52 + 2), (h * 0.66) / (rows.length * 1.18 + 0.5));
    fs = Math.max(h * 0.09, Math.min(h * (mood === 'hot' ? 0.2 : 0.21), fs)) * kinRnd(0.9, 1.1);

    var el = document.createElement('div');
    el.className = 'kl m-' + mood + ' a-' + align + (rtl ? ' rtl' : (Math.random() < 0.14 ? ' it' : ''));
    if (rtl) el.dir = 'rtl';
    el.style.fontSize = fs.toFixed(1) + 'px';
    el.style.fontWeight = kinPick(mood === 'hot' ? [700, 800] : [500, 600, 600, 700]);
    el.style.setProperty('--tilt', tilt.toFixed(1) + 'deg');
    el.style.setProperty('--shift', kinRnd(-12, 12).toFixed(1) + '%');
    el.style.setProperty('--vy', kinRnd(-9, 9).toFixed(1) + '%');
    var spans = [], wf = [], acc = 0, total = 0, wi = 0;
    var kd = document.createElement('div'); kd.className = 'kd';
    words.forEach(function (x) { total += x.length + 1; });
    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'kr';
      r.forEach(function (x, q) {
        var sp = document.createElement('span');
        sp.className = 'w' + (ems[wi] ? ' em' : '');
        sp.textContent = x;
        if (ems[wi]) sp.style.fontSize = ems[wi].toFixed(2) + 'em';
        else if (Math.random() < 0.35) sp.style.fontSize = kinRnd(0.88, 1.12).toFixed(2) + 'em';
        // each word slides in from its own random side, and its fill takes as long as the word takes to sing
        var dir = kinPick([[0, 0.3], [0, -0.3], [-0.35, 0], [0.35, 0], [0, 0.15]]);
        sp.style.setProperty('--ex', dir[0] + 'em');
        sp.style.setProperty('--ey', dir[1] + 'em');
        sp.style.setProperty('--fd', Math.max(0.28, Math.min(1.3, sung * (x.length + 1) / total)).toFixed(2) + 's');
        row.appendChild(sp);
        if (q < r.length - 1) row.appendChild(document.createTextNode(' '));
        spans.push(sp); wf.push(acc / total); acc += x.length + 1; wi++;
      });
      kd.appendChild(row);
    });
    el.appendChild(kd);
    // Real word timings (word-synced lyrics): each word fills exactly while it is sung.
    if (ln.words && ln.words.length === spans.length && ln.dur > 0) {
      for (var wi2 = 0; wi2 < spans.length; wi2++) {
        wf[wi2] = Math.max(0, Math.min(0.98, (ln.words[wi2].t - ln.t) / ln.dur));
        spans[wi2].style.setProperty('--fd', Math.max(0.12, (ln.words[wi2].e || ln.words[wi2].t) - ln.words[wi2].t).toFixed(2) + 's');
      }
    }
    el._w = spans; el._wf = wf; el._cur = -2; el._sung = sung;
    stage.appendChild(el);
    kinFit(el, stage, fs);
    kinConnect(el, kd, spans, el._fs || fs);
    kinFx(el, stage, sung, words, el._fs || fs);
    kinEl = el;
  }
  function kinTick(force) {
    var L = lyr.lines, pos = currentPos() + lyLead(), idx = lyIndexAt(pos);
    lyMusic(lyIdleLabel(idx, pos));
    if (idx !== kinIdx || force) {
      if (force && idx === kinIdx && kinEl) { /* same line, just re-measure below */ }
      kinIdx = idx;
      kinShow(idx);
    }
    var el = kinEl;
    if (!el || idx < 0) return;
    var start = L[idx].t, p = Math.max(0, Math.min(1, (pos - start) / el._sung));
    var cw = -1;
    for (var q = 0; q < el._wf.length; q++) { if (p >= el._wf[q]) cw = q; else break; }
    if (cw !== el._cur) {
      for (var r = 0; r < el._w.length; r++) el._w[r].classList.toggle('in', r <= cw);
      if (kinFxEl && kinFxEl._segs) {
        var fr = (cw + 1) / el._w.length, fs2 = kinFxEl._segs, mk = kinFxEl._marks;
        for (var g2 = 0; g2 < fs2.length; g2++) fs2[g2].classList.toggle('in', fr >= (g2 + 1) / fs2.length);
        for (var m2 = 0; m2 < mk.length; m2++) mk[m2].classList.toggle('in', fr >= ((m2 >> 1) + 0.5) / (mk.length / 2));
      }
      if (el._segs) { for (var s2 = 0; s2 < el._segs.length; s2++) el._segs[s2].classList.toggle('in', cw >= s2 + 1); for (var d2 = 0; d2 < el._dots.length; d2++) el._dots[d2].classList.toggle('in', cw >= d2); }
      el._cur = cw;
    }
    // A long pause before the next line: let the words go and leave the screen quiet.
    var nextT = L[idx + 1] ? L[idx + 1].t : start + 99;
    var gone = pos > start + el._sung + 1.2 && nextT - pos > 2.0;
    if (gone !== kinGone) { kinGone = gone; toggle(el, 'out', gone); if (kinFxEl) toggle(kinFxEl, 'out', gone); }
  }
  function lyricsVisible() { return (state.screen === 'lyrics' || document.body.classList.contains('ly-open')) && document.visibilityState === 'visible'; }
  var lyRaf = 0;
  function lyFrame() { lyRaf = 0; if (!lyricsVisible()) return; lyricTick(false); lyRaf = requestAnimationFrame(lyFrame); }
  function lyStart() { if (!lyRaf && lyricsVisible()) lyRaf = requestAnimationFrame(lyFrame); }
  setInterval(lyStart, 1000);
  window.addEventListener('resize', function () { lyrIndex = -2; lyricTick(true); });
  // Tap a line to jump the song there.
  $('ly-list').addEventListener('click', function (e) {
    if (!lyr || !lyr.synced) return;
    var el = e.target.closest('.ly-line');
    if (!el) return;
    var i = Array.prototype.indexOf.call($('ly-list').children, el);
    if (i >= 0 && lyr.lines[i]) { cmd('seek', Math.max(0, lyr.lines[i].t)); lyrIndex = -2; }
  });

  // The lyrics sheet (immersive style): pull up on Now playing, pull down or tap the arrow to close.
  var lyCloseT = null;
  function openLyrics() {
    var b = document.body;
    if (b.classList.contains('ly-open')) return;
    clearTimeout(lyCloseT); b.classList.remove('ly-closing');
    b.classList.add('ly-open');
    setTimeout(function () { if (b.classList.contains('ly-open')) b.classList.add('ly-ready'); }, 300);
    renderLyricsHead(); lyricTick(true); lyStart();
    buzz();
  }
  function closeLyrics(now) {
    var b = document.body;
    if (!b.classList.contains('ly-open')) return;
    b.classList.remove('ly-open', 'ly-ready');
    if (now) { b.classList.remove('ly-closing'); return; }
    b.classList.add('ly-closing');
    clearTimeout(lyCloseT);
    lyCloseT = setTimeout(function () { b.classList.remove('ly-closing'); }, 230);
  }
  $('ly-pill').addEventListener('click', openLyrics);
  $('ly-close').addEventListener('click', function () { closeLyrics(); });

  // Time (and weather) in the corner of the immersive Now playing screen.
  var npLast = '';
  function renderNpTop() {
    if (!imm() || state.screen !== 'media') return;
    var html = clockHtml(new Date(Date.now() + state.clockOffset));
    if (html !== npLast) { npLast = html; $('np-time').innerHTML = html; }
  }
  setInterval(function () { if (document.visibilityState === 'visible') renderNpTop(); }, 1000);

  /* ============================================================ weather */
  var WX = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5" fill="#FFC53D"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" stroke="#FFC53D" stroke-width="1.8" stroke-linecap="round"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" fill="#C9CED8"/></svg>',
    partly: '<svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3.6" fill="#FFC53D"/><path d="M9 2.5v1.6M2.5 9h1.6M4.4 4.4l1.1 1.1M13.6 4.4l-1.1 1.1" stroke="#FFC53D" stroke-width="1.6" stroke-linecap="round"/><path d="M8 19.5h9.5a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.4 1.5A2.8 2.8 0 0 0 8 19.5z" fill="#DADDE3"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M6.5 18.5h11a4 4 0 0 0 0-8 5.6 5.6 0 0 0-10.7 1.6 3.2 3.2 0 0 0-.3 6.4z" fill="#C9CED8"/></svg>',
    fog: '<svg viewBox="0 0 24 24"><path d="M4 9h16M3 13h18M5 17h14" stroke="#C9CED8" stroke-width="2" stroke-linecap="round"/></svg>',
    rain: '<svg viewBox="0 0 24 24"><path d="M6.5 14.5h11a4 4 0 0 0 0-8 5.6 5.6 0 0 0-10.7 1.6 3.2 3.2 0 0 0-.3 6.4z" fill="#C9CED8"/><path d="M8 17.5l-1 2.5M12 17.5l-1 2.5M16 17.5l-1 2.5" stroke="#5B8CFF" stroke-width="1.8" stroke-linecap="round"/></svg>',
    snow: '<svg viewBox="0 0 24 24"><path d="M6.5 14.5h11a4 4 0 0 0 0-8 5.6 5.6 0 0 0-10.7 1.6 3.2 3.2 0 0 0-.3 6.4z" fill="#C9CED8"/><circle cx="8" cy="19" r="1.2" fill="#fff"/><circle cx="12" cy="20" r="1.2" fill="#fff"/><circle cx="16" cy="19" r="1.2" fill="#fff"/></svg>',
    storm: '<svg viewBox="0 0 24 24"><path d="M6.5 14.5h11a4 4 0 0 0 0-8 5.6 5.6 0 0 0-10.7 1.6 3.2 3.2 0 0 0-.3 6.4z" fill="#9AA1AE"/><path d="M12.5 15 10 19h2.5l-1 3.5 3.5-5h-2.5l1-2.5z" fill="#FFC53D"/></svg>',
  };
  function wxIcon(code, day) {
    if (code === 0) return day ? WX.sun : WX.moon;
    if (code <= 2) return day ? WX.partly : WX.cloud;
    if (code === 3) return WX.cloud;
    if (code === 45 || code === 48) return WX.fog;
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return WX.snow;
    if (code >= 95) return WX.storm;
    return WX.rain;
  }
  var weather = store.get('weather', null);
  function setWeather(w) {
    weather = w;
    store.set('weather', w);
    renderWeather();
  }
  function renderWeather() {
    var w = weather;
    // Outside the PC connection, only show weather that's a few hours old at most.
    var fresh = w && state.config.weather !== false && Date.now() - w.at < 6 * 3600 * 1000;
    var html = fresh ? wxIcon(w.code, w.day) + '<b>' + w.temp + '°' + '</b><span>' + escHtml(w.city || '') + '</span><small>H ' + w.hi + '° · L ' + w.lo + '°</small>' : '';
    if (typeof renderForecast === 'function') renderForecast();
    ['c-wx', 'o-wx', 'np-wx'].forEach(function (id) {
      var el = $(id);
      el.hidden = !fresh;
      if (el.getAttribute('data-h') !== html) { el.setAttribute('data-h', html); el.innerHTML = html; }
    });
  }
  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ============================================================ Spotify extras */
  state.spotify = null;
  function renderSpotify() {
    var sp = state.spotify, m = state.media;
    var onSpotify = sp && m.active && /spotify/i.test(m.app || '');
    $('b-like').hidden = !onSpotify || sp.liked == null;
    toggle($('b-like'), 'on', !!(onSpotify && sp.liked));
    var nxt = onSpotify && sp.next;
    $('m-next').hidden = !nxt;
    if (nxt) setText($('m-next-t'), nxt.title + (nxt.artist ? ' — ' + nxt.artist : ''));
  }
  $('b-like').addEventListener('click', function () {
    buzz();
    if (state.spotify) { state.spotify.liked = !state.spotify.liked; renderSpotify(); }
    var lb = $('b-like'); lb.classList.remove('pop'); void lb.offsetWidth; lb.classList.add('pop');
    send({ t: 'like' });
  });

  /* ============================================================ notification banners */
  var nQueue = [], nShowing = false, nTimer = null;
  var BELL = '<svg viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  function queueNotification(n) {
    if (!n || state.config.notifications === false) return;
    nQueue.push(n);
    if (nQueue.length > 5) nQueue.shift();
    if (!nShowing) nextNotification();
  }
  function nextNotification() {
    var n = nQueue.shift(), el = $('nb');
    clearTimeout(nTimer);
    if (!n) {
      if (!nShowing) return;
      // slide out, then hide
      el.classList.remove('go'); el.classList.add('out');
      nTimer = setTimeout(function () { el.hidden = true; el.classList.remove('out'); nShowing = false; if (nQueue.length) nextNotification(); }, 230);
      return;
    }
    var show = function () {
      nShowing = true;
      $('nb-ic').innerHTML = n.icon ? '<img src="' + pcUrl(n.icon) + '" alt="">' : BELL;
      setText($('nb-app'), n.app || '');
      setText($('nb-title'), n.title || (n.body ? '' : 'New notification'));
      setText($('nb-body'), n.body || '');
      el.classList.remove('out', 'go');
      el.hidden = false;
      el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
      el.classList.add('go');
      buzz();
      nTimer = setTimeout(nextNotification, 6000);
    };
    if (nShowing && !el.hidden) {
      // a banner is already up: play its exit, then the next one's entrance
      el.classList.remove('go'); el.classList.add('out');
      nTimer = setTimeout(show, 200);
    } else show();
  }
  $('nb').addEventListener('click', function (e) { e.stopPropagation(); nextNotification(); });

  /* ============================================================ boot */
  if (/[?&]debug\b/.test(location.search)) window.__pd = { state: state, setLyrics: setLyrics, openLyrics: openLyrics, applyConfig: applyConfig, tick: lyricTick, pos: currentPos, clock: mediaClock };
  renderDots();
  renderWeather();
  show(state.screen);
  renderPad();
  connect();
})();
