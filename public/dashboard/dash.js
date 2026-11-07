/* PhoneDesk desktop app (runs in the PhoneDesk window, or any browser on this PC). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  if (new URLSearchParams(location.search).has('app')) document.body.classList.add('in-app');

  const SCREEN_NAMES = { media: 'Now playing', lyrics: 'Lyrics', mixer: 'Volume mixer', clock: 'Clock', stats: 'PC stats', shortcuts: 'Shortcuts' };
  const SCREEN_DESC = { media: 'art, controls, volume', lyrics: 'synced to the song', mixer: 'volume per app', clock: 'time, weather, track', stats: 'CPU, memory, GPU', shortcuts: 'your buttons' };
  const ALL_SCREENS = Object.keys(SCREEN_NAMES);
  const ICONS = ['bolt', 'mic', 'desktop', 'lock', 'camera', 'music', 'play', 'chart', 'folder', 'globe', 'game', 'code', 'chat', 'power', 'vol', 'next'];
  const COLORS = ['#E5484D', '#F76B15', '#F5A524', '#2FBF71', '#12A594', '#5B8CFF', '#A47CF3', '#F472B6'];
  const ACCENTS = ['#5B8CFF', '#2FBF71', '#F5A524', '#F472B6', '#A47CF3'];
  const DIM_STEPS = [0, 30, 60, 300, 900, 1800];
  const DIM_LABELS = ['never', 'after 30 s', 'after 1 min', 'after 5 min', 'after 15 min', 'after 30 min'];

  const state = {
    media: { active: false }, volume: { level: 0, muted: false }, stats: null,
    config: null, status: null, activity: [], offset: 0, connected: false,
    selPhone: null, previewScreen: 'media',
  };

  /* ------------------------------------------------------------ helpers */
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('on'), 1800);
  }
  async function api(path, body) {
    const res = await fetch('/api/' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }
  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(ts).toLocaleDateString();
  }
  function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }
  function icon(name) { return '<svg aria-hidden="true"><use href="#i-' + (ICONS.includes(name) ? name : 'bolt') + '"/></svg>'; }
  function nameUrl() { return state.status ? state.status.nameUrl : 'http://phonedesk.local'; }
  function copy(text) { navigator.clipboard.writeText(text).then(() => toast('Copied ' + text), () => toast(text)); }

  /* ------------------------------------------------------------ navigation */
  function go(view) {
    if (!$('v-' + view)) view = 'overview';
    $$('.nav').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + view));
    history.replaceState(null, '', location.pathname + location.search + '#' + view);
    $('main').scrollTop = 0;
    if (view === 'activity') loadActivity(true);
  }
  $$('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) go(g.dataset.goto);
    const c = e.target.closest('.copy-url');
    if (c) copy(nameUrl() + '/phone');
  });

  /* ------------------------------------------------------------ live connection */
  let ws = null;
  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws?role=dashboard`);
    ws.onopen = () => { state.connected = true; state.wsFailed = false; refresh(); renderStatus(); };
    ws.onclose = () => { state.connected = false; state.wsFailed = true; renderStatus(); setTimeout(connect, 1500); };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hello') state.offset = m.d.serverTime - Date.now();
      else if (m.t === 'media') { state.media = m.d || { active: false }; renderMedia(); renderMirrors(); }
      else if (m.t === 'volume') { state.volume = m.d; renderVolume(); }
      else if (m.t === 'stats') { state.stats = m.d; renderPc(); }
      else if (m.t === 'clients') { refresh(); loadActivity(); onboardPoll(); }
      else if (m.t === 'mixer') { state.mixer = m.d || []; if (state.previewScreen === 'mixer' || (selectedPhone() || {}).screen === 'mixer') renderMirrors(); }
      else if (m.t === 'lyrics') { state.lyrics = m.d; renderMirrors(); }
      else if (m.t === 'weather') { state.weather = m.d; renderMirrors(); renderWeatherNow(); }
      else if (m.t === 'update') { state.update = m.d; renderUpdate(); }
      else if (m.t === 'spotifyStatus') loadSpotify();
    };
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  async function refresh() {
    try {
      state.status = await api('status');
    } catch { return; }
    renderStatus();
    renderOverview();
    renderConnection();
  }
  async function loadConfig() {
    state.config = await api('config');
    if (!scDirty) { draft = clone(state.config.shortcuts); renderShortcuts(); }
    renderDisplay();
    renderConnectionSettings();
    renderMirrors();
  }
  async function loadActivity(withLogs) {
    try { state.activity = await api('activity'); } catch { return; }
    renderFeed();
    if (withLogs || $('ac-tech').open) {
      const lines = await api('logs').catch(() => []);
      $('ac-logs').innerHTML = lines.map((l) => `<span class="${l.level}">${new Date(l.ts).toLocaleTimeString()}  ${esc(l.msg)}</span>`).join('\n') || 'No logs yet.';
    }
  }
  $('ac-tech').addEventListener('toggle', () => loadActivity(true));

  function renderStatus() {
    const s = state.status;
    let cls = '', text = 'Connecting…';
    if (state.wsFailed) { cls = 'bad'; text = 'Not running'; }
    if (state.connected && s) {
      if (s.bridge.ready) { cls = 'ok'; text = 'Running'; } else { cls = 'warn'; text = 'Starting media…'; }
    }
    $('st-dot').className = 'dot ' + cls;
    setText($('st-text'), text);
    if (s) setText($('st-ver'), 'v' + s.version);
    $('nav-warn').hidden = !(s && s.adb.devices.some((d) => d.state === 'unauthorized'));
  }

  /* ------------------------------------------------------------ mini phone (mirror + previews) */
  function curPos() {
    const m = state.media;
    if (!m.active || !m.duration) return 0;
    let p = m.position || 0;
    if (m.status === 'Playing' && m.updated) p += (Date.now() + state.offset - m.updated) / 1000;
    return Math.min(Math.max(0, p), m.duration);
  }
  function clockText(d) {
    const h = d.getHours(), mi = String(d.getMinutes()).padStart(2, '0');
    return state.config && !state.config.clock24 ? ((h % 12) || 12) + ':' + mi : String(h).padStart(2, '0') + ':' + mi;
  }
  const VIDEO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="4.5" width="21" height="15" rx="4.5" fill="#FF0033"/><path d="M10 9v6l5.2-3z" fill="#fff"/></svg>';
  function appIconHtml(m, size) {
    if (!m.active) return '';
    if (m.site === 'youtube') return VIDEO_ICON;
    return m.appIcon ? `<img src="${esc(m.appIcon)}" alt="" width="${size}" height="${size}">` : '';
  }
  function appLabel(m) { return m.active ? (m.game ? 'Game · ' : '') + (m.app || '') : ''; }

  function mini(screen) {
    const cfg = state.config || {};
    const theme = cfg.theme || 'dark';
    const accent = cfg.accent && cfg.accent !== 'auto' ? cfg.accent : '#8FA9FF';
    const cls = 'mini' + (theme === 'light' ? ' light' : theme === 'black' ? ' black' : '');
    const style = `--mini-accent:${accent}`;
    const m = state.media, now = new Date(Date.now() + state.offset);
    if (screen === 'offline' || screen === 'clock') {
      const track = screen === 'clock' && m.active ? `<div class="d" style="margin-top:2cqw">${esc(m.title || '')}</div>` : '';
      const w = state.weather && cfg.weather !== false ? `<div class="mini-wx"><b>${state.weather.temp}°</b><span>${esc(state.weather.city || '')}</span></div>` : '';
      return `<div class="${cls} mini-clock" style="${style}"><div class="t">${clockText(now)}</div><div class="d">${esc(now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</div>${w}${track}${screen === 'offline' ? '<div class="s">PC disconnected · reconnecting…</div>' : ''}</div>`;
    }
    if (screen === 'lyrics') {
      const l = state.lyrics;
      if (!l || !l.lines || !l.lines.length) return `<div class="${cls}"><div class="mini-empty">${m.active ? (l ? 'No lyrics for this song' : 'Looking for lyrics…') : 'Play a song on your PC'}</div></div>`;
      let i = 0;
      if (l.synced) { const pos = curPos(); l.lines.forEach((x, k) => { if (x.t <= pos) i = k; }); }
      const pick = [i - 1, i, i + 1, i + 2].filter((k) => k >= 0 && k < l.lines.length);
      return `<div class="${cls} mini-lyrics" style="${style}">${pick.map((k) => `<div class="${k === i ? 'on' : ''}">${esc(l.lines[k].text || '♪')}</div>`).join('')}</div>`;
    }
    if (screen === 'mixer') {
      const rows = [{ name: 'PC volume', level: state.volume.level, icon: '' }].concat((state.mixer || []).slice(0, 4));
      return `<div class="${cls} mini-mixer" style="${style}">${rows.map((r) => `<div class="r">${r.icon ? `<img src="${esc(r.icon)}" alt="">` : '<svg><use href="#i-vol"/></svg>'}<span>${esc(r.name)}</span><i><b style="width:${Math.round(r.level * 100)}%"></b></i></div>`).join('')}</div>`;
    }
    if (screen === 'stats') {
      const s = state.stats || { cpu: 0, memUsed: 0, memTotal: 1 };
      return `<div class="${cls} mini-stats" style="${style}"><div>CPU<b>${s.cpu}%</b></div><div>Memory<b>${Math.round((s.memUsed / s.memTotal) * 100)}%</b></div><div>Volume<b>${Math.round(state.volume.level * 100)}%</b></div></div>`;
    }
    if (screen === 'shortcuts') {
      const list = (cfg.shortcuts || []).slice(0, 8);
      if (!list.length) return `<div class="${cls}"><div class="mini-empty">No shortcut buttons yet</div></div>`;
      return `<div class="${cls} mini-pad" style="${style}">${list.map((k) => `<div style="--kc:${esc(k.color)}">${icon(k.icon)}${esc(k.label)}</div>`).join('')}</div>`;
    }
    const art = m.active && m.art ? `<img src="${esc(m.art)}" alt="">` : '<svg><use href="#i-note"/></svg>';
    const frac = m.active && m.duration ? (curPos() / m.duration) * 100 : 0;
    return `<div class="${cls} mini-media" style="${style}">
      <div class="mini-art">${art}</div>
      <div class="mini-info">
        <div class="mini-app">${appIconHtml(m, 14)}<span>${esc(appLabel(m))}</span></div>
        <div class="mini-title">${esc(m.active ? m.title || 'Unknown title' : 'Nothing playing')}</div>
        <div class="mini-artist">${esc(m.active ? m.artist || m.album || '' : 'Play something on your PC')}</div>
        <div class="mini-bar"><i class="mini-progress" style="width:${frac.toFixed(2)}%"></i></div>
        <div class="mini-ctrl"><i></i><b></b><i></i></div>
      </div></div>`;
  }
  const lastMini = new WeakMap();
  function paint(el, html) {
    // Ignore the progress width when deciding whether to rebuild; the 1s ticker moves it.
    const key = html.replace(/width:[\d.]+%/, '');
    if (lastMini.get(el) !== key) { lastMini.set(el, key); el.innerHTML = html; }
  }
  function renderMirrors() {
    const p = selectedPhone();
    if (p) paint($('ov-mirror'), mini(p.screen || 'media'));
    paint($('ds-preview'), mini(state.previewScreen));
  }
  // Progress bars and clocks tick once a second without rebuilding anything else.
  setInterval(() => {
    if (document.hidden) return;
    const frac = state.media.active && state.media.duration ? (curPos() / state.media.duration) * 100 : 0;
    $$('.mini-progress').forEach((i) => { i.style.width = frac.toFixed(2) + '%'; });
    const t = clockText(new Date(Date.now() + state.offset));
    $$('.mini-clock .t').forEach((el) => setText(el, t));
  }, 1000);

  /* ------------------------------------------------------------ overview */
  function selectedPhone() {
    const list = state.status ? state.status.clients : [];
    return list.find((c) => c.id === state.selPhone) || list[0] || null;
  }
  function renderOverview() {
    const s = state.status;
    const phones = s.clients;
    const p = selectedPhone();
    state.selPhone = p ? p.id : null;
    $('ov-hero').hidden = !p;
    $('ov-empty').hidden = !!p;
    $('ov-reload').hidden = !p;
    setText($('ov-sub'), !p ? 'No phone connected yet.' : phones.length > 1 ? `${phones.length} phones connected.`
      : `Your phone is connected and showing ${SCREEN_NAMES[p.screen] || 'PhoneDesk'}.`);

    $$('.name-url').forEach((el) => setText(el, nameUrl().replace(/^http:\/\//, '')));
    $$('.name-url-full').forEach((el) => setText(el, nameUrl()));
    $$('.apk-url').forEach((el) => setText(el, nameUrl() + '/phone/PhoneDesk.apk'));
    const qr = '/api/qr?text=' + encodeURIComponent(nameUrl() + '/phone');
    $$('.qr-img').forEach((img) => { if (img.getAttribute('src') !== qr) img.src = qr; });

    if (!p) return;
    const tabs = $('ov-tabs');
    tabs.hidden = phones.length < 2;
    if (phones.length > 1) {
      const html = phones.map((c) => `<button data-id="${c.id}" class="${c.id === p.id ? 'on' : ''}">${esc(c.device)} · ${esc(c.via)}</button>`).join('');
      if (tabs.innerHTML !== html) tabs.innerHTML = html;
    }
    const via = $('ov-via');
    setText(via, p.via);
    via.className = 'badge' + (p.via === 'USB' ? ' usb' : '');
    setText($('ov-name'), p.device);
    setText($('ov-rtt'), p.rtt != null ? p.rtt + ' ms' : '–');
    setText($('ov-screen'), SCREEN_NAMES[p.screen] || '–');
    $('ov-batt-help').hidden = !!p.battery;
    setText($('ov-batt'), p.battery ? p.battery.level + '%' + (p.battery.charging ? ' ⚡' : '') : '–');
    $('ov-batt').title = p.battery ? '' : 'Battery level is only shared over USB';
    renderMirrors();
  }
  $('ov-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.selPhone = b.dataset.id; renderOverview(); } });
  $('ov-reload').addEventListener('click', async () => { const p = selectedPhone(); if (p) { await api(`phones/${p.id}/reload`, {}).catch(() => {}); toast('Reloading ' + p.device); } });
  $('ov-identify').addEventListener('click', async () => { const p = selectedPhone(); if (p) { await api(`phones/${p.id}/identify`, {}).catch((e) => toast(e.message)); } });
  const switchMenu = $('ov-switch-menu');
  $('ov-switch').addEventListener('click', (e) => {
    e.stopPropagation();
    let list = state.config ? state.config.screens : ALL_SCREENS;
    if (state.config && state.config.nowStyle !== 'classic') list = list.filter((s) => s !== 'lyrics'); // a pull-up sheet in the Immersive style
    switchMenu.innerHTML = list.map((s) => `<button data-s="${s}">${SCREEN_NAMES[s]}</button>`).join('');
    switchMenu.hidden = !switchMenu.hidden;
    $('ov-switch').setAttribute('aria-expanded', String(!switchMenu.hidden));
  });
  switchMenu.addEventListener('click', async (e) => {
    e.stopPropagation();
    const b = e.target.closest('button');
    const p = selectedPhone();
    switchMenu.hidden = true;
    if (b && p) { await api(`phones/${p.id}/screen`, { screen: b.dataset.s }).catch(() => {}); setTimeout(refresh, 300); }
  });
  document.addEventListener('click', () => { switchMenu.hidden = true; });

  function renderMedia() {
    const m = state.media;
    setText($('np-title'), m.active ? m.title || 'Unknown title' : 'Nothing playing');
    setText($('np-artist'), m.active ? m.artist || m.album || '' : 'Start music or a video on this PC');
    const tag = $('np-app');
    const tagHtml = appIconHtml(m, 16) + '<span>' + esc(appLabel(m)) + '</span>';
    if (tag.innerHTML !== tagHtml) tag.innerHTML = tagHtml;
    const art = $('np-art');
    if (m.active && m.art) { if (art.getAttribute('src') !== m.art) art.src = m.art; art.hidden = false; } else art.hidden = true;
    $('np-play').setAttribute('href', m.active && m.status === 'Playing' ? '#i-pause' : '#i-play');
  }
  let volDrag = false;
  function renderVolume() {
    if (volDrag) return;
    $('np-vol').value = Math.round(state.volume.level * 100);
    setText($('np-vol-n'), state.volume.muted ? 'off' : String(Math.round(state.volume.level * 100)));
  }
  $$('[data-cmd]').forEach((b) => b.addEventListener('click', () => send({ t: 'cmd', a: b.dataset.cmd })));
  $('np-vol').addEventListener('input', (e) => { volDrag = true; setText($('np-vol-n'), e.target.value); send({ t: 'volume', v: e.target.value / 100 }); });
  $('np-vol').addEventListener('change', () => setTimeout(() => { volDrag = false; }, 500));

  function renderPc() {
    const s = state.stats;
    if (!s) return;
    const mem = Math.round((s.memUsed / s.memTotal) * 100);
    setText($('pc-name'), s.host || 'This PC');
    setText($('pc-cpu'), s.cpu + '%');
    setText($('pc-mem'), mem + '%');
    $('pc-cpu-m').style.width = s.cpu + '%';
    $('pc-mem-m').style.width = mem + '%';
    const g = s.gpu;
    $('pc-gpu-box').hidden = !g || g.load < 0;
    if (g && g.load >= 0) {
      setText($('pc-gpu'), g.load + '%');
      setText($('pc-gpu-t'), g.temp > 0 ? '· ' + g.temp + '°C' + (g.hotspot > 0 ? ' (hotspot ' + g.hotspot + '°C)' : '') : '');
      $('pc-gpu-m').style.width = g.load + '%';
    }
    if (state.previewScreen === 'stats' || (selectedPhone() || {}).screen === 'stats') renderMirrors();
  }

  function feedItem(a) {
    const color = a.kind === 'problem' ? 'warn' : a.kind === 'phone' ? 'ok' : '';
    return `<li><span class="dot ${color}" style="${color ? '' : 'background:var(--accent)'}"></span><span class="msg">${esc(a.msg)}</span><time>${ago(a.ts)}</time></li>`;
  }
  function renderFeed() {
    const list = state.activity.slice().reverse();
    $('ov-feed').innerHTML = list.slice(0, 5).map(feedItem).join('') || '<li class="empty">Nothing yet. Connect a phone or press a shortcut.</li>';
    $('ac-feed').innerHTML = list.map(feedItem).join('') || '<li class="empty">Nothing yet.</li>';
  }

  /* ------------------------------------------------------------ shortcuts editor */
  let draft = [], sel = 0, scDirty = false, saveTimer = null, recording = false;
  const KEY_LABEL = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', win: 'Win', esc: 'Esc', pageup: 'Page Up', pagedown: 'Page Down', printscreen: 'Print Screen', backspace: 'Backspace', delete: 'Delete', enter: 'Enter', space: 'Space', tab: 'Tab', up: '↑', down: '↓', left: '←', right: '→', mediaplay: 'Play/Pause', medianext: 'Next track', mediaprev: 'Previous track', volumeup: 'Volume up', volumedown: 'Volume down', volumemute: 'Mute' };
  const CODE_KEY = { Enter: 'enter', Escape: 'esc', Tab: 'tab', Space: 'space', Backspace: 'backspace', Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert', PrintScreen: 'printscreen', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', MediaPlayPause: 'mediaplay', MediaTrackNext: 'medianext', MediaTrackPrevious: 'mediaprev', AudioVolumeUp: 'volumeup', AudioVolumeDown: 'volumedown', AudioVolumeMute: 'volumemute' };

  function cur() { return draft[sel]; }
  function scheduleSave() {
    scDirty = true;
    setText($('sc-state'), 'Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveShortcuts, 500);
  }
  async function saveShortcuts() {
    clearTimeout(saveTimer);
    try {
      state.config = await api('config', { shortcuts: draft });
      scDirty = false;
      setText($('sc-state'), 'Saved');
      renderMirrors();
    } catch (e) { setText($('sc-state'), 'Couldn\'t save: ' + e.message); }
  }

  function renderShortcuts() {
    const pad = $('sc-pad');
    if (sel >= draft.length) sel = Math.max(0, draft.length - 1);
    setText($('sc-count'), draft.length + ' of 24 buttons');
    pad.innerHTML = draft.map((k, i) =>
      `<button class="key${i === sel ? ' on' : ''}" draggable="true" data-i="${i}" style="--kc:${esc(k.color)}" aria-label="Edit ${esc(k.label)}">${icon(k.icon)}<span>${esc(k.label || 'Untitled')}</span></button>`
    ).join('') + (draft.length < 24 ? '<button class="key add" id="sc-add-tile" aria-label="Add a button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Add</span></button>' : '');
    pad.style.gridTemplateRows = `repeat(${Math.max(2, Math.ceil((draft.length + 1) / 4))}, minmax(0, 1fr))`;
    $('sc-editor').hidden = !draft.length;
    renderEditor();
  }
  function renderEditor() {
    const k = cur();
    if (!k) return;
    k.color = String(k.color || '#5B8CFF').toUpperCase(); // palette compares in upper case
    $('sc-editor').style.setProperty('--kc', k.color);
    setText($('ed-title'), k.label || 'Untitled');
    $('ed-icon-preview').setAttribute('href', '#i-' + (ICONS.includes(k.icon) ? k.icon : 'bolt'));
    if (document.activeElement !== $('ed-label')) $('ed-label').value = k.label;
    $$('#ed-type button').forEach((b) => b.classList.toggle('on', b.dataset.v === k.type));
    const isKeys = k.type === 'keys';
    $('ed-keys-field').hidden = !isKeys;
    $('ed-value-field').hidden = isKeys;
    if (!isKeys) {
      $('ed-value-field').firstChild.textContent = k.type === 'url' ? 'Link' : 'App';
      if (document.activeElement !== $('ed-value')) $('ed-value').value = k.value;
      $('ed-value').placeholder = k.type === 'url' ? 'https://… or spotify:' : 'C:\\Program Files\\App\\app.exe';
      setText($('ed-value-hint'), k.type === 'url' ? 'A website, or an app link like spotify: or discord://' : 'The full path to a program, file or folder.');
    }
    renderRecorder();
    $('ed-icons').innerHTML = ICONS.map((ic) => `<button data-ic="${ic}" class="${ic === k.icon ? 'on' : ''}" aria-label="${ic}" aria-pressed="${ic === k.icon}">${icon(ic)}</button>`).join('');
    const custom = !COLORS.includes(k.color);
    $('ed-colors').innerHTML = COLORS.map((c) => `<button class="swatch${c === k.color ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('') +
      `<label class="custom-color${custom ? ' swatch on' : ''}" style="${custom ? 'background:' + esc(k.color) : ''}" title="Pick any color"><input type="color" id="ed-color-pick" value="${esc(k.color)}" aria-label="Pick any color"></label>`;
  }
  function renderRecorder() {
    const k = cur();
    if (!k) return;
    const rec = $('ed-rec');
    rec.classList.toggle('rec', recording);
    if (recording) {
      rec.innerHTML = '<span>Press the keys now…</span><span class="act">Esc to cancel</span>';
      setText($('ed-rec-hint'), 'Hold the modifiers (Ctrl, Shift, Alt), then press the key.');
    } else {
      const parts = (k.value || '').split('+').map((s) => s.trim()).filter(Boolean);
      rec.innerHTML = (parts.length ? parts.map((p) => `<kbd>${esc(KEY_LABEL[p] || p.toUpperCase())}</kbd>`).join('<span class="plus">+</span>') : '<span class="muted">No keys yet</span>') +
        '<span class="act">' + (parts.length ? 'Record new' : 'Record') + '</span>';
      setText($('ed-rec-hint'), 'Click, then press the keys.');
    }
    $('ed-win').textContent = /(^|\+)win(\+|$)/.test(k.value || '') ? 'Remove Win key' : 'Add Win key';
  }

  $('sc-pad').addEventListener('click', (e) => {
    const b = e.target.closest('.key');
    if (!b) return;
    if (b.id === 'sc-add-tile') return addShortcut();
    sel = +b.dataset.i; recording = false; renderShortcuts();
  });
  // Drag one button onto another to swap them.
  let dragFrom = null;
  $('sc-pad').addEventListener('dragstart', (e) => { const b = e.target.closest('.key[data-i]'); if (!b) return; dragFrom = +b.dataset.i; b.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; });
  $('sc-pad').addEventListener('dragend', () => { dragFrom = null; $$('#sc-pad .key').forEach((k) => k.classList.remove('drag', 'over')); });
  $('sc-pad').addEventListener('dragover', (e) => { const b = e.target.closest('.key[data-i]'); if (b && dragFrom != null) { e.preventDefault(); $$('#sc-pad .key').forEach((k) => k.classList.toggle('over', k === b)); } });
  $('sc-pad').addEventListener('drop', (e) => {
    const b = e.target.closest('.key[data-i]');
    if (!b || dragFrom == null) return;
    e.preventDefault();
    const to = +b.dataset.i;
    if (to !== dragFrom) { const t = draft[to]; draft[to] = draft[dragFrom]; draft[dragFrom] = t; sel = to; scheduleSave(); }
    renderShortcuts();
  });

  function addShortcut() {
    if (draft.length >= 24) return toast('24 buttons is the most a phone can show');
    draft.push({ id: Math.random().toString(36).slice(2, 10), label: 'New button', type: 'keys', value: '', icon: 'bolt', color: COLORS[draft.length % COLORS.length] });
    sel = draft.length - 1;
    scheduleSave();
    renderShortcuts();
    $('ed-label').focus();
    $('ed-label').select();
  }
  $('sc-add').addEventListener('click', addShortcut);
  $('ed-label').addEventListener('input', (e) => { cur().label = e.target.value; scheduleSave(); renderShortcuts(); });
  $('ed-value').addEventListener('input', (e) => { cur().value = e.target.value; scheduleSave(); });
  $('ed-type').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (cur().type !== b.dataset.v) { cur().type = b.dataset.v; cur().value = ''; recording = b.dataset.v === 'keys'; scheduleSave(); renderEditor(); }
  });
  $('ed-icons').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { cur().icon = b.dataset.ic; scheduleSave(); renderShortcuts(); } });
  $('ed-colors').addEventListener('click', (e) => { const b = e.target.closest('.swatch[data-c]'); if (b) { cur().color = b.dataset.c; scheduleSave(); renderShortcuts(); } });
  $('ed-colors').addEventListener('change', (e) => { if (e.target.id === 'ed-color-pick') { cur().color = e.target.value; scheduleSave(); renderShortcuts(); } });
  $('ed-rec').addEventListener('click', () => { recording = !recording; renderRecorder(); });
  $('ed-win').addEventListener('click', () => {
    const k = cur();
    const parts = (k.value || '').split('+').filter(Boolean);
    const i = parts.indexOf('win');
    if (i >= 0) parts.splice(i, 1); else parts.unshift('win');
    k.value = parts.join('+');
    scheduleSave(); renderRecorder();
  });
  document.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return; // wait for the real key
    if (e.code === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey) { recording = false; renderRecorder(); return; }
    let key = CODE_KEY[e.code];
    if (!key && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
    if (!key && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
    if (!key && /^F([1-9]|1[0-2])$/.test(e.code)) key = e.code.toLowerCase();
    if (!key) { toast('That key can\'t be used. Try a letter, number, F-key or arrow.'); return; }
    const k = cur();
    const hadWin = /(^|\+)win(\+|$)/.test(k.value || '');
    const parts = [];
    if (e.metaKey || hadWin) parts.push('win');
    if (e.ctrlKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    parts.push(key);
    k.value = parts.join('+');
    recording = false;
    scheduleSave(); renderRecorder();
  }, true);
  $('ed-test').addEventListener('click', async () => {
    const k = cur();
    if (!k.value) return toast('Set what it does first');
    if (scDirty) await saveShortcuts();
    await api('shortcut', { id: k.id });
    toast('Ran “' + k.label + '”');
  });
  $('ed-delete').addEventListener('click', () => {
    const k = cur();
    if (!confirm('Delete the “' + k.label + '” button?')) return;
    draft.splice(sel, 1);
    scheduleSave(); renderShortcuts();
  });

  /* ------------------------------------------------------------ phone display */
  async function saveConfig(patch) {
    try { state.config = await api('config', patch); renderDisplay(); renderMirrors(); }
    catch (e) { toast('Couldn\'t save: ' + e.message); }
  }
  function renderDisplay() {
    const c = state.config;
    if (!c) return;
    $$('#ds-nstyle .theme').forEach((b) => { const on = b.dataset.v === (c.nowStyle || 'immersive'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $$('#ds-lystyle .theme').forEach((b) => { const on = b.dataset.v === (c.lyricsMode || 'scroll'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    if (document.activeElement !== $('ds-lyoffset')) { $('ds-lyoffset').value = c.lyricsOffset || 0; setText($('ds-lyoffset-n'), ((c.lyricsOffset || 0) > 0 ? '+' : '') + (c.lyricsOffset || 0) + ' ms'); }
    $$('#ds-lylines button').forEach((b) => { const on = b.dataset.v === (c.lyricsLines || 'off'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $$('#ds-lyfont button').forEach((b) => { const on = b.dataset.v === (c.lyricsFont || 'serif'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $$('#ds-themes .theme').forEach((b) => { b.classList.toggle('on', b.dataset.v === c.theme); b.setAttribute('aria-pressed', String(b.dataset.v === c.theme)); });
    c.accent = c.accent === 'auto' ? 'auto' : String(c.accent).toUpperCase();
    const custom = c.accent !== 'auto' && !ACCENTS.includes(c.accent);
    $('ds-accent').innerHTML =
      `<button class="btn sm${c.accent === 'auto' ? ' primary' : ''}" data-a="auto">From album art</button>` +
      ACCENTS.map((a) => `<button class="swatch${a === c.accent ? ' on' : ''}" data-a="${a}" style="background:${a}" aria-label="Accent ${a}"></button>`).join('') +
      `<label class="custom-color${custom ? ' swatch on' : ''}" style="${custom ? 'background:' + c.accent : ''}" title="Pick any color"><input type="color" id="ds-accent-pick" value="${custom ? c.accent : '#5B8CFF'}" aria-label="Pick any accent color"></label>`;
    $$('#ds-clock button').forEach((b) => b.classList.toggle('on', (b.dataset.v === '24') === c.clock24));
    let di = DIM_STEPS.indexOf(c.dimAfter);
    if (di < 0) di = DIM_STEPS.reduce((best, v, i) => Math.abs(v - c.dimAfter) < Math.abs(DIM_STEPS[best] - c.dimAfter) ? i : best, 0);
    $('ds-dim').value = di;
    setText($('ds-dim-label'), DIM_LABELS[di]);
    const order = c.screens.concat(ALL_SCREENS.filter((s) => !c.screens.includes(s)));
    $('ds-screens').innerHTML = order.map((s) => {
      const on = c.screens.includes(s);
      return `<li class="${on ? '' : 'off'}" draggable="true" data-s="${s}"><span class="grip" aria-hidden="true">⋮⋮</span><span class="name">${SCREEN_NAMES[s]}</span><span class="desc">${SCREEN_DESC[s]}</span>` +
        `<span class="switch"><input type="checkbox" ${on ? 'checked' : ''} ${on && c.screens.length === 1 ? 'disabled' : ''} aria-label="Show ${SCREEN_NAMES[s]}"><span></span></span></li>`;
    }).join('');
    $('ds-batt').checked = c.showBattery !== false;
    $('ds-wx').checked = c.weather !== false;
    $('ds-wx-row').hidden = c.weather === false;
    if (document.activeElement !== $('ds-wx-city')) $('ds-wx-city').value = c.weatherCity || '';
    $$('#ds-wx-unit button').forEach((b) => b.classList.toggle('on', b.dataset.v === (c.weatherUnit || 'c')));
    $('ds-nt').checked = c.notifications !== false;
    $('ds-nt-priv').checked = !!c.notifyPrivate;
    $('ds-nt-priv').closest('label').hidden = c.notifications === false;
    $('ds-art').checked = c.artLookup !== false;
    $$('#ds-pills button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.previewScreen));
    setText($('ds-prev-label'), state.previewScreen === 'offline' ? 'When the PC is off' : SCREEN_NAMES[state.previewScreen]);
  }
  $('ds-batt').addEventListener('change', (e) => saveConfig({ showBattery: e.target.checked }));
  $('ds-wx').addEventListener('change', (e) => saveConfig({ weather: e.target.checked }));
  $('ds-wx-city').addEventListener('change', (e) => saveConfig({ weatherCity: e.target.value.trim() }).then(() => toast('Weather updated')));
  $('ds-wx-unit').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) saveConfig({ weatherUnit: b.dataset.v }); });
  $('ds-nt').addEventListener('change', (e) => saveConfig({ notifications: e.target.checked }));
  $('ds-nt-priv').addEventListener('change', (e) => saveConfig({ notifyPrivate: e.target.checked }));
  function renderWeatherNow() {
    const w = state.weather;
    setText($('ds-wx-now'), w ? `Now: ${w.temp}°${w.unit} in ${w.city}` : '');
  }
  $('ds-art').addEventListener('change', (e) => saveConfig({ artLookup: e.target.checked }));
  $('ds-nstyle').addEventListener('click', (e) => { const b = e.target.closest('.theme'); if (b) saveConfig({ nowStyle: b.dataset.v }); });
  $('ds-lyoffset').addEventListener('input', (e) => setText($('ds-lyoffset-n'), (+e.target.value > 0 ? '+' : '') + e.target.value + ' ms'));
  $('ds-lyoffset').addEventListener('change', (e) => saveConfig({ lyricsOffset: +e.target.value }));
  $('ds-lylines').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) saveConfig({ lyricsLines: b.dataset.v }); });
  $('ds-lyfont').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) saveConfig({ lyricsFont: b.dataset.v }); });
  $('ds-lystyle').addEventListener('click', (e) => { const b = e.target.closest('.theme'); if (b) saveConfig({ lyricsMode: b.dataset.v }); });
  $('ds-themes').addEventListener('click', (e) => { const b = e.target.closest('.theme'); if (b) saveConfig({ theme: b.dataset.v }); });
  $('ds-accent').addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) saveConfig({ accent: b.dataset.a }); });
  $('ds-accent').addEventListener('change', (e) => { if (e.target.id === 'ds-accent-pick') saveConfig({ accent: e.target.value }); });
  $('ds-clock').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) saveConfig({ clock24: b.dataset.v === '24' }); });
  $('ds-dim').addEventListener('input', (e) => setText($('ds-dim-label'), DIM_LABELS[+e.target.value]));
  $('ds-dim').addEventListener('change', (e) => saveConfig({ dimAfter: DIM_STEPS[+e.target.value] }));
  $('ds-pills').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.previewScreen = b.dataset.v; renderDisplay(); renderMirrors(); } });
  $('ds-screens').addEventListener('change', (e) => {
    const li = e.target.closest('li');
    const list = state.config.screens.slice();
    if (e.target.checked) list.push(li.dataset.s); else list.splice(list.indexOf(li.dataset.s), 1);
    saveConfig({ screens: list });
  });
  let dragScreen = null;
  $('ds-screens').addEventListener('dragstart', (e) => { const li = e.target.closest('li'); if (li) { dragScreen = li.dataset.s; li.classList.add('drag'); } });
  $('ds-screens').addEventListener('dragend', () => { dragScreen = null; $$('#ds-screens li').forEach((l) => l.classList.remove('drag', 'over')); });
  $('ds-screens').addEventListener('dragover', (e) => { const li = e.target.closest('li'); if (li && dragScreen) { e.preventDefault(); $$('#ds-screens li').forEach((l) => l.classList.toggle('over', l === li)); } });
  $('ds-screens').addEventListener('drop', (e) => {
    const li = e.target.closest('li');
    if (!li || !dragScreen) return;
    e.preventDefault();
    const order = $$('#ds-screens li').map((l) => l.dataset.s).filter((s) => s !== dragScreen);
    order.splice(order.indexOf(li.dataset.s), 0, dragScreen);
    saveConfig({ screens: order.filter((s) => state.config.screens.includes(s)) });
  });

  /* ------------------------------------------------------------ connection */
  function renderConnection() {
    const s = state.status;
    const urls = s.urls;
    const html = urls.length ? urls.map((u) => `<div class="url"><span class="u mono">${esc(u.url)}/phone</span><small>${esc(u.name)}</small><button class="btn sm" data-copy="${esc(u.url)}/phone">Copy</button></div>`).join('')
      : '<p class="small muted">This PC isn\'t on a network right now. Use USB instead.</p>';
    if ($('cn-urls').innerHTML !== html) $('cn-urls').innerHTML = html;

    // Phones that are connected right now (any way: USB, Wi-Fi, charger)
    const ph = s.clients || [];
    setText($('cn-count'), ph.length ? ph.length + ' connected' : 'None');
    $('cn-count').className = 'badge' + (ph.length ? ' usb' : '');
    const phtml = ph.length ? ph.map((c) => `<div class="phone-row"><span class="dot ok"></span><div class="pr-main"><b>${esc(c.device)}</b><small>Showing ${esc(SCREEN_NAMES[c.screen] || 'PhoneDesk')}</small></div><span class="badge${c.via === 'USB' ? ' usb' : ''}">${esc(c.via)}</span><span class="pr-stat">${c.rtt != null ? c.rtt + ' ms' : '–'}</span><span class="pr-stat">${c.battery ? c.battery.level + '%' + (c.battery.charging ? ' ⚡' : '') : '–'}</span><button class="btn sm" data-identify="${c.id}">Identify</button></div>`).join('')
      : '<p class="small muted">No phone yet. Scan the code below, or plug one in.</p>';
    if ($('cn-phones').innerHTML !== phtml) $('cn-phones').innerHTML = phtml;

    const a = s.adb;
    $('cn-adb-install').hidden = a.found || a.installing;
    $('cn-usb-connect').disabled = !a.found || !a.devices.some((d) => d.reversed);
    let usb;
    if (a.installing) usb = '<div class="dev"><span class="dot warn"></span>Downloading ADB…</div>';
    else if (!a.found) usb = '<div class="dev"><span class="dot"></span>ADB isn\'t installed yet. Download it to use USB.</div>';
    else if (!a.devices.length) usb = '<div class="dev"><span class="dot"></span>No cable-linked phone</div>';
    else usb = a.devices.map((d) => {
      const st = d.state === 'device' ? (d.reversed ? ['ok', 'Linked'] : ['warn', 'Linking…']) : d.state === 'unauthorized' ? ['warn', 'Accept the prompt on the phone'] : ['', d.state];
      return `<div class="dev"><span class="dot ${st[0]}"></span>${esc(d.model)}<span class="badge${d.via === 'USB' ? ' usb' : ''}">${esc(d.via || 'USB')}</span><small>${st[1]}</small></div>`;
    }).join('');
    if ($('cn-usb').innerHTML !== usb) $('cn-usb').innerHTML = usb;
    setText($('cn-bridge-info'), s.bridge.ready ? 'Running' + (s.bridge.restarts ? ` · restarted ${s.bridge.restarts}×` : '') : 'Starting…');
  }
  $('cn-phones').addEventListener('click', (e) => {
    const b = e.target.closest('[data-identify]');
    if (b) api(`phones/${b.dataset.identify}/identify`, {}).catch((er) => toast(er.message));
  });
  function renderConnectionSettings() {
    const c = state.config;
    $('cn-autousb').checked = c.autoUsb;
    if (document.activeElement !== $('cn-port')) $('cn-port').value = c.port;
    if (document.activeElement !== $('cn-name')) $('cn-name').value = c.name;
    setText($('cn-name-ex'), c.name + '.local');
  }
  $('cn-urls').addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) copy(b.dataset.copy); });
  $('cn-autousb').addEventListener('change', (e) => saveConfig({ autoUsb: e.target.checked }).then(renderConnectionSettings));
  $('cn-port').addEventListener('change', (e) => saveConfig({ port: +e.target.value }).then(() => toast('Saved. Restart PhoneDesk to use the new port.')));
  $('cn-name').addEventListener('change', (e) => saveConfig({ name: e.target.value }).then(() => { renderConnectionSettings(); toast('Saved. Restart PhoneDesk to use the new name.'); }));
  $('cn-bridge').addEventListener('click', async () => { await api('bridge/restart', {}); toast('Restarting the media bridge'); setTimeout(refresh, 2500); });
  $('cn-usb-connect').addEventListener('click', async () => {
    const r = await api('adb/connect', {}).catch((e) => { toast(e.message); return null; });
    if (r) toast(r.devices.some((d) => d.reversed) ? 'Opened PhoneDesk on the phone' : 'No linked phone found');
    refresh();
  });
  $('cn-adb-install').addEventListener('click', async () => {
    $('cn-adb-install').hidden = true;
    toast('Downloading ADB from Google…');
    const p = api('adb/install', {});
    setTimeout(refresh, 300);
    const r = await p.catch(() => null);
    toast(r && r.found ? 'ADB is ready' : 'ADB download failed. See Activity → Technical log.');
    refresh();
  });

  /* ------------------------------------------------------------ start with Windows */
  async function loadAutostart() {
    const a = await api('autostart').catch(() => null);
    $('autostart-row').hidden = !a || !a.available;
    if (a) $('autostart').checked = a.enabled;
  }
  $('autostart').addEventListener('change', async (e) => {
    const a = await api('autostart', { enabled: e.target.checked }).catch(() => null);
    if (a) { $('autostart').checked = a.enabled; toast(a.enabled ? 'PhoneDesk will start with Windows' : 'PhoneDesk won\'t start with Windows'); }
  });

  /* ------------------------------------------------------------ Spotify */
  async function loadSpotify() {
    const sp = await api('spotify').catch(() => null);
    if (!sp) return;
    setText($('sp-redirect'), sp.redirect);
    if (document.activeElement !== $('sp-id')) $('sp-id').value = sp.clientId || '';
    $('sp-setup').hidden = sp.connected;
    $('sp-connect').hidden = sp.connected;
    $('sp-disconnect').hidden = !sp.connected;
    const b = $('sp-badge');
    setText(b, sp.connected ? 'Connected' : 'Not connected');
    b.className = 'badge' + (sp.connected ? ' usb' : '');
    setText($('sp-state'), sp.connected ? (sp.now ? 'Now: ' + sp.now.title : 'Play something on Spotify') : '');
  }
  $('sp-copy').addEventListener('click', () => copy($('sp-redirect').textContent));
  $('sp-id').addEventListener('change', (e) => saveConfig({ spotifyClientId: e.target.value.trim() }));
  $('sp-connect').addEventListener('click', async () => {
    const id = $('sp-id').value.trim();
    if (!/^[a-f0-9]{32}$/i.test(id)) return toast('Paste the Client ID from your Spotify app first');
    await saveConfig({ spotifyClientId: id });
    // Opens in your normal browser (the app window sends other sites there).
    window.open('/api/spotify/login', '_blank');
    toast('Finish signing in to Spotify in your browser');
    setText($('sp-state'), 'Waiting for Spotify…');
  });
  $('sp-disconnect').addEventListener('click', async () => { await api('spotify/disconnect', {}); loadSpotify(); });

  /* ------------------------------------------------------------ updates */
  function renderUpdate() {
    const u = state.update || {};
    const badge = $('up-badge'), text = $('up-text');
    $('up-install').hidden = u.state !== 'ready';
    $('up-check').disabled = u.state === 'source' || u.state === 'checking' || u.state === 'downloading';
    const ver = state.status ? 'v' + state.status.version : '';
    const map = {
      source: ['Dev', 'Running from source code, so it updates with git instead.'],
      off: ['Off', 'No release source set. Add a GitHub repository below to get updates.'],
      idle: [ver, 'Updates are checked a minute after start and every 6 hours.'],
      checking: ['Checking', 'Looking for a newer version…'],
      latest: [ver, 'You have the latest version.'],
      downloading: ['Downloading', `Downloading PhoneDesk ${u.version || ''}…`],
      ready: ['Update ready', `PhoneDesk ${u.version} is downloaded and checked. Installing takes a few seconds; PhoneDesk restarts by itself.`],
      installing: ['Installing', 'Installing the update. PhoneDesk will restart.'],
      error: ['Problem', 'Couldn\'t update: ' + (u.error || 'unknown error')],
    };
    const [b, t] = map[u.state] || [ver, ''];
    setText(badge, b);
    badge.className = 'badge' + (u.state === 'ready' ? ' usb' : u.state === 'error' ? ' warn' : '');
    setText(text, t);
  }
  $('up-check').addEventListener('click', async () => { state.update = await api('update/check', {}).catch((e) => ({ state: 'error', error: e.message })); renderUpdate(); });
  $('up-install').addEventListener('click', async () => { await api('update/install', {}).catch((e) => toast(e.message)); });
  $('up-auto').addEventListener('change', (e) => saveConfig({ autoUpdate: e.target.checked }));
  $('up-repo').addEventListener('change', (e) => saveConfig({ updateRepo: e.target.value.trim() }).then(async () => {
    state.update = await api('update/check', {}).catch(() => state.update); renderUpdate();
  }));
  function renderUpdateSettings() {
    const c = state.config;
    $('up-auto').checked = c.autoUpdate !== false;
    if (document.activeElement !== $('up-repo')) $('up-repo').value = c.updateRepo || '';
  }

  /* ------------------------------------------------------------ first-run setup */
  let obStep = 0, fwState = null;
  function openOnboarding() {
    obStep = 0;
    $('onboard').hidden = false;
    $('ob-wx').checked = state.config.weather !== false;
    $('ob-wx-city').value = state.config.weatherCity || '';
    $('ob-nt').checked = state.config.notifications !== false;
    renderOnboarding();
  }
  function renderOnboarding() {
    $$('.ob-step').forEach((s) => { s.hidden = +s.dataset.step !== obStep; });
    $$('#ob-dots i').forEach((d, i) => d.classList.toggle('on', i <= obStep));
    $('ob-back').hidden = obStep === 0;
    $('ob-next').textContent = obStep === 0 ? 'Get started' : obStep === 3 ? 'Finish' : 'Next';
    $('ob-as-row').hidden = $('autostart-row').hidden;
    if (obStep === 1) onboardPoll();
    if (obStep === 2) checkFirewall();
  }
  function onboardPoll() {
    if ($('onboard').hidden || obStep !== 1 || !state.status) return;
    const p = state.status.clients[0];
    const el = $('ob-phone');
    el.className = 'ob-status' + (p ? ' ok' : '');
    el.innerHTML = p ? `✓&nbsp; ${esc(p.device)} is connected over ${esc(p.via)}` : '<span class="spin"></span>Waiting for your phone…';
    if (p) $('ob-next').textContent = 'Next';
  }
  async function checkFirewall() {
    const el = $('ob-fw');
    el.className = 'ob-status'; el.innerHTML = '<span class="spin"></span>Checking…';
    $('ob-fw-fix').hidden = true; $('ob-fw-hint').hidden = true;
    const wifiPhone = state.status && state.status.clients.some((c) => c.via === 'Wi-Fi');
    fwState = await api('firewall').catch(() => null);
    if (wifiPhone || (fwState && fwState.ok)) {
      el.className = 'ob-status ok';
      el.textContent = wifiPhone ? '✓  A phone is already connected over Wi-Fi. All good.' : '✓  Phones on your Wi-Fi can reach PhoneDesk.';
    } else {
      el.className = 'ob-status bad';
      el.textContent = fwState && fwState.block ? 'Windows Firewall is blocking PhoneDesk on Wi-Fi.' : 'PhoneDesk isn\'t allowed through Windows Firewall yet.';
      $('ob-fw-fix').hidden = false; $('ob-fw-hint').hidden = false;
    }
  }
  $('ob-fw-fix').addEventListener('click', async () => {
    $('ob-fw').innerHTML = '<span class="spin"></span>Waiting for Windows…';
    await api('firewall/fix', {}).catch(() => null);
    checkFirewall();
  });
  async function finishOnboarding() {
    const patch = { onboarded: true, weather: $('ob-wx').checked, weatherCity: $('ob-wx-city').value.trim(), notifications: $('ob-nt').checked };
    await saveConfig(patch);
    if (!$('ob-as-row').hidden) await api('autostart', { enabled: $('ob-as').checked }).then(loadAutostart).catch(() => {});
    $('onboard').hidden = true;
    toast('You\'re all set');
  }
  $('ob-next').addEventListener('click', () => { if (obStep === 3) finishOnboarding(); else { obStep++; renderOnboarding(); } });
  $('ob-back').addEventListener('click', () => { obStep = Math.max(0, obStep - 1); renderOnboarding(); });
  $('ob-skip').addEventListener('click', async () => { await saveConfig({ onboarded: true }); $('onboard').hidden = true; });
  $('cn-onboard').addEventListener('click', openOnboarding);

  /* ------------------------------------------------------------ boot */
  go((location.hash.slice(1) || 'overview'));
  connect();
  refresh();
  loadConfig().then(() => {
    renderUpdateSettings();
    if (!state.config.onboarded) openOnboarding();
  }).catch(() => toast('Couldn\'t load settings'));
  loadSpotify();
  api('update').then((u) => { state.update = u; renderUpdate(); }).catch(() => {});
  api('weather').then((w) => { state.weather = w && w.city ? w : null; renderWeatherNow(); }).catch(() => {});
  loadActivity();
  loadAutostart();
  setInterval(() => { if (!document.hidden) refresh(); }, 3000);
  setInterval(() => { if (!document.hidden) loadActivity(); }, 6000);
  window.addEventListener('beforeunload', () => { if (scDirty) saveShortcuts(); });
})();
