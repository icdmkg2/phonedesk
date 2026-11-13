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
  // Addon screens are 'addon:<id>'; their names come from the installed addons.
  function addonInfo(s) { const id = String(s).slice(6); return ((state.addons && state.addons.installed) || []).find((a) => a.id === id); }
  function screenName(s) { return SCREEN_NAMES[s] || (String(s).startsWith('page:') ? (pageInfo(s) ? pageInfo(s).name : s.slice(5)) : null) || (String(s).startsWith('addon:') ? (addonInfo(s) ? (addonInfo(s).screen ? addonInfo(s).screen.title : addonInfo(s).name) : s.slice(6)) : s); }
  function screenDesc(s) { return SCREEN_DESC[s] || (String(s).startsWith('page:') ? 'your page' : null) || (String(s).startsWith('addon:') ? 'addon' + (addonInfo(s) ? ' · ' + addonInfo(s).name : '') : ''); }
  function pageInfo(s) { return ((state.config && state.config.pages) || []).find((p) => 'page:' + p.id === s); }
  function pageScreenIds() { return ((state.config && state.config.pages) || []).map((p) => 'page:' + p.id); }
  function addonScreenIds() { return ((state.addons && state.addons.installed) || []).filter((a) => a.screen && a.enabled).map((a) => 'addon:' + a.id); }
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
    if (view === 'addons') loadAddons();
    if (view === 'layouts') openLayouts();
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
      else if (m.t === 'clients') { refresh(); loadActivity(); }
      else if (m.t === 'mixer') { state.mixer = m.d || []; if (state.previewScreen === 'mixer' || (selectedPhone() || {}).screen === 'mixer') renderMirrors(); }
      else if (m.t === 'lyrics') { state.lyrics = m.d; renderMirrors(); }
      else if (m.t === 'weather') { state.weather = m.d; renderMirrors(); renderWeatherNow(); }
      else if (m.t === 'update') { state.update = m.d; renderUpdate(); }
      else if (m.t === 'addons') loadAddons();
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
    onboardPoll(); // the setup's "Waiting for your phone" step, now that the new client list is here
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
    if (String(screen).startsWith('page:')) return `<div class="${cls}" style="${style}"><div class="mini-empty">${esc(screenName(screen))}<br><small>${(pageInfo(screen) || { widgets: [] }).widgets.length} widgets</small></div></div>`;
    if (String(screen).startsWith('addon:')) return `<div class="${cls}" style="${style}"><div class="mini-empty">${esc(screenName(screen))}<br><small>An addon screen</small></div></div>`;
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
      : `Your phone is connected and showing ${screenName(p.screen) || 'PhoneDesk'}.`);

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
    setText($('ov-screen'), screenName(p.screen) || '–');
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
    switchMenu.innerHTML = list.map((s) => `<button data-s="${s}">${screenName(s)}</button>`).join('');
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
    // the window's backdrop and the Now playing card are a blur of the cover (Liquid Glass)
    const wall = m.active && m.art ? 'url("' + m.art.replace(/"/g, '%22') + '")' : '';
    if (document.body.dataset.wall !== wall) { document.body.dataset.wall = wall; document.body.style.setProperty('--art', wall || 'none'); document.body.classList.toggle('has-art', !!wall); }
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

  // a meter is a bar and, in the overview, a ring: both read the same value
  function ring(id, v) { const el = $(id); el.style.width = v + '%'; el.parentNode.style.setProperty('--p', Math.max(0, Math.min(100, v))); }
  function renderPc() {
    const s = state.stats;
    if (!s) return;
    const mem = Math.round((s.memUsed / s.memTotal) * 100);
    setText($('pc-name'), s.host || 'This PC');
    setText($('pc-cpu'), s.cpu + '%');
    setText($('pc-mem'), mem + '%');
    ring('pc-cpu-m', s.cpu);
    ring('pc-mem-m', mem);
    const g = s.gpu;
    $('pc-gpu-box').hidden = !g || g.load < 0;
    if (g && g.load >= 0) {
      setText($('pc-gpu'), g.load + '%');
      setText($('pc-gpu-t'), g.temp > 0 ? '· ' + g.temp + '°C' + (g.hotspot > 0 ? ' (hotspot ' + g.hotspot + '°C)' : '') : '');
      ring('pc-gpu-m', g.load);
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
    if (document.activeElement !== $('ed-group')) $('ed-group').value = k.group || '';
    $('ed-groups').innerHTML = [...new Set(draft.map((d) => d.group).filter(Boolean))].map((g) => `<option value="${esc(g)}">`).join('');
    $$('#ed-live button').forEach((b) => b.classList.toggle('on', b.dataset.v === (k.live || '')));
    $$('#ed-type button').forEach((b) => b.classList.toggle('on', b.dataset.v === k.type));
    const isKeys = k.type === 'keys', isAddon = k.type === 'addon';
    $('ed-keys-field').hidden = !isKeys;
    $('ed-value-field').hidden = isKeys || isAddon;
    $('ed-addon-field').hidden = !isAddon;
    if (isAddon) {
      const acts = (state.addons && state.addons.actions) || [];
      $('ed-addon').innerHTML = '<option value="">Choose an action…</option>' + acts.map((a) => `<option value="${esc(a.value)}"${a.value === k.value ? ' selected' : ''}>${esc(a.addon)}: ${esc(a.label)}</option>`).join('');
      setText($('ed-addon-hint'), acts.length ? 'Actions come from the addons you installed.' : 'No addon adds actions yet. Install one in Addons.');
    }
    if (!isKeys && !isAddon) {
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
    draft.push({ id: Math.random().toString(36).slice(2, 10), label: 'New button', type: 'keys', value: '', icon: 'bolt', color: COLORS[draft.length % COLORS.length], group: (cur() || {}).group || '', live: '' });
    sel = draft.length - 1;
    scheduleSave();
    renderShortcuts();
    $('ed-label').focus();
    $('ed-label').select();
  }
  $('sc-add').addEventListener('click', addShortcut);
  $('ed-label').addEventListener('input', (e) => { cur().label = e.target.value; scheduleSave(); renderShortcuts(); });
  $('ed-group').addEventListener('input', (e) => { cur().group = e.target.value.slice(0, 20); scheduleSave(); });
  $('ed-live').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { cur().live = b.dataset.v; scheduleSave(); renderEditor(); } });
  $('ed-addon').addEventListener('change', (e) => { cur().value = e.target.value; scheduleSave(); });
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
  // Schedule rows: from, to, screen. Saved as the person edits them.
  function renderSchedule() {
    const c = state.config, box = $('ds-sched'); if (!c || !box) return;
    if (box.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return;
    const rules = c.schedule || [], screens = c.screens || [];
    $('ds-sched-add').disabled = rules.length >= 6;
    box.innerHTML = rules.length ? rules.map((r, i) => `<div class="sched-row" data-i="${i}">
      <input type="time" data-f="from" value="${esc(r.from)}" aria-label="From"><span class="muted">to</span><input type="time" data-f="to" value="${esc(r.to)}" aria-label="To">
      <select data-f="screen" aria-label="What to do"><optgroup label="Show a screen">${[...new Set([...screens, r.screen].filter((s) => s !== 'night' && s !== 'dim'))].map((s) => `<option value="${esc(s)}"${s === r.screen ? ' selected' : ''}>${esc(screenName(s))}</option>`).join('')}</optgroup><optgroup label="Or"><option value="night"${r.screen === 'night' ? ' selected' : ''}>Night mode (dark, red clock)</option><option value="dim"${r.screen === 'dim' ? ' selected' : ''}>Dim the screen</option></optgroup></select>
      <button class="btn sm ghost" data-rm="${i}" aria-label="Remove this time">Remove</button></div>`).join('') : '<p class="small muted">No times set.</p>';
  }
  $('ds-sched').addEventListener('change', (e) => {
    const row = e.target.closest('.sched-row'), f = e.target.dataset.f; if (!row || !f) return;
    const rules = clone(state.config.schedule || []); rules[+row.dataset.i][f] = e.target.value;
    if (!/^\d\d:\d\d$/.test(rules[+row.dataset.i].from) || !/^\d\d:\d\d$/.test(rules[+row.dataset.i].to) || rules[+row.dataset.i].from === rules[+row.dataset.i].to) return toast('Pick two different times');
    saveConfig({ schedule: rules }).then(renderSchedule);
  });
  $('ds-sched').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const rules = clone(state.config.schedule || []); rules.splice(+b.dataset.rm, 1); saveConfig({ schedule: rules }).then(renderSchedule);
  });
  $('ds-sched-add').addEventListener('click', () => {
    const rules = clone(state.config.schedule || []);
    rules.push({ from: '22:00', to: '07:00', screen: (state.config.screens || []).includes('clock') ? 'clock' : (state.config.screens || [])[0] });
    saveConfig({ schedule: rules }).then(renderSchedule);
  });

  // Notes and to-dos for the Notes widget
  function renderNotes() {
    const c = state.config, box = $('ds-notes'); if (!c || !box) return;
    if (box.contains(document.activeElement) && document.activeElement.type === 'text') return;
    box.innerHTML = (c.notes || []).length ? c.notes.map((n, i) => `<div class="note-row" data-i="${i}"><input type="checkbox" ${n.done ? 'checked' : ''} aria-label="Done"><input type="text" value="${esc(n.text)}" maxlength="200" aria-label="Note"><button class="btn sm ghost" data-rm="${i}" aria-label="Remove this note">Remove</button></div>`).join('') : '<p class="small muted">No notes yet.</p>';
    if (document.activeElement !== $('ds-photos')) $('ds-photos').value = c.photosDir || '';
    $('ds-dbltap').checked = !!c.doubleTapPlay;
  }
  $('ds-notes').addEventListener('change', (e) => {
    const row = e.target.closest('.note-row'); if (!row) return;
    const notes = clone(state.config.notes || []), n = notes[+row.dataset.i]; if (!n) return;
    if (e.target.type === 'checkbox') n.done = e.target.checked; else n.text = e.target.value;
    saveConfig({ notes: notes.filter((x) => x.text.trim()) });
  });
  $('ds-notes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const notes = clone(state.config.notes || []); notes.splice(+b.dataset.rm, 1); saveConfig({ notes });
  });
  function addNote() {
    const t = $('ds-note-new').value.trim(); if (!t) return;
    if ((state.config.notes || []).length >= 50) return toast('50 notes is the most');
    saveConfig({ notes: [...(state.config.notes || []), { text: t, done: false }] }).then(() => { $('ds-note-new').value = ''; $('ds-note-new').focus(); });
  }
  $('ds-note-add').addEventListener('click', addNote);
  $('ds-note-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote(); });
  $('ds-photos').addEventListener('change', async (e) => {
    await saveConfig({ photosDir: e.target.value.trim() });
    const r = await api('photos').catch(() => null);
    setText($('ds-photos-n'), !r || !r.dir ? '' : r.count ? r.count + ' pictures found' : 'No pictures (JPG, PNG, WebP or GIF) in that folder');
  });
  $('ds-dbltap').addEventListener('change', (e) => saveConfig({ doubleTapPlay: e.target.checked }));

  function renderDisplay() {
    const c = state.config;
    if (!c) return;
    renderSchedule();
    renderNotes();
    $$('#ds-nstyle .theme').forEach((b) => { const on = b.dataset.v === (c.nowStyle || 'immersive'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $$('#ds-lystyle .theme').forEach((b) => { const on = b.dataset.v === (c.lyricsMode || 'scroll'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    if (document.activeElement !== $('ds-lyoffset')) { $('ds-lyoffset').value = c.lyricsOffset || 0; setText($('ds-lyoffset-n'), ((c.lyricsOffset || 0) > 0 ? '+' : '') + (c.lyricsOffset || 0) + ' ms'); }
    $$('#ds-lylines button').forEach((b) => { const on = b.dataset.v === (c.lyricsLines || 'off'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $$('#ds-lyfont button').forEach((b) => { const on = b.dataset.v === (c.lyricsFont || 'serif'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $$('#ds-themes .theme').forEach((b) => { b.classList.toggle('on', b.dataset.v === c.theme); b.setAttribute('aria-pressed', String(b.dataset.v === c.theme)); });
    $$('#ds-looks .theme').forEach((b) => { const on = b.dataset.v === (c.look || 'classic'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
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
    const order = c.screens.concat(ALL_SCREENS.concat(addonScreenIds(), pageScreenIds()).filter((s) => !c.screens.includes(s)));
    $('ds-screens').innerHTML = order.map((s) => {
      const on = c.screens.includes(s);
      return `<li class="${on ? '' : 'off'}" draggable="true" data-s="${s}"><span class="grip" aria-hidden="true">⋮⋮</span><span class="name">${screenName(s)}</span><span class="desc">${screenDesc(s)}</span>` +
        (on && ['media', 'clock', 'stats', 'shortcuts'].includes(s) ? `<button class="btn sm ghost" data-customize="${s}" title="Turn this screen into a page of widgets you can rearrange">Customize</button>` : '') + `<span class="switch"><input type="checkbox" ${on ? 'checked' : ''} ${on && c.screens.length === 1 ? 'disabled' : ''} aria-label="Show ${screenName(s)}"><span></span></span></li>`;
    }).join('');
    $$('#ds-cface .theme').forEach((b) => { const on = b.dataset.v === (c.clockFace || 'digital'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $('ds-fc').checked = c.clockForecast !== false;
    $('ds-cal-badge').textContent = c.calendarUrl ? 'On' : 'Off';
    $('ds-cal-badge').className = 'badge' + (c.calendarUrl ? ' usb' : '');
    $('ds-cal-clear').hidden = !c.calendarUrl;
    if (document.activeElement !== $('ds-cal')) $('ds-cal').value = c.calendarUrl || '';
    $$('#ds-night button').forEach((b) => b.classList.toggle('on', b.dataset.v === (c.nightMode || 'off')));
    $('ds-night-times').hidden = c.nightMode !== 'schedule';
    if (document.activeElement !== $('ds-night-from')) $('ds-night-from').value = c.nightFrom || '22:00';
    if (document.activeElement !== $('ds-night-to')) $('ds-night-to').value = c.nightTo || '07:00';
    setText($('ds-night-hint'), c.nightMode === 'sensor' ? 'Uses the light sensor through the PhoneDesk phone app. In a browser it falls back to the schedule.' : '');
    $('ds-night-red').checked = c.nightRed !== false;
    $('ds-night-clock').checked = c.nightClock !== false;
    $('ds-burn').checked = c.burnIn !== false;
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
    setText($('ds-prev-label'), state.previewScreen === 'offline' ? 'When the PC is off' : screenName(state.previewScreen));
  }
  $('ds-cface').addEventListener('click', (e) => { const b = e.target.closest('.theme'); if (b) saveConfig({ clockFace: b.dataset.v }); });
  $('ds-fc').addEventListener('change', (e) => saveConfig({ clockForecast: e.target.checked }));
  $('ds-cal-save').addEventListener('click', async () => {
    const url = $('ds-cal').value.trim();
    setText($('ds-cal-state'), 'Checking…');
    const r = await api('calendar/check', { url }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) return setText($('ds-cal-state'), r.error || 'That address did not work.');
    await saveConfig({ calendarUrl: url });
    setText($('ds-cal-state'), r.count ? `Works. ${r.count} event${r.count === 1 ? '' : 's'} in the next 7 days.` : 'Works. Nothing in the next 7 days.');
  });
  $('ds-cal-clear').addEventListener('click', async () => { await saveConfig({ calendarUrl: '' }); setText($('ds-cal-state'), 'Removed.'); });
  $('ds-night').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) saveConfig({ nightMode: b.dataset.v }); });
  $('ds-night-from').addEventListener('change', (e) => saveConfig({ nightFrom: e.target.value }));
  $('ds-night-to').addEventListener('change', (e) => saveConfig({ nightTo: e.target.value }));
  $('ds-night-red').addEventListener('change', (e) => saveConfig({ nightRed: e.target.checked }));
  $('ds-night-clock').addEventListener('change', (e) => saveConfig({ nightClock: e.target.checked }));
  $('ds-burn').addEventListener('change', (e) => saveConfig({ burnIn: e.target.checked }));
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
  $('ds-looks').addEventListener('click', (e) => { const b = e.target.closest('.theme'); if (b) saveConfig({ look: b.dataset.v }); });
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
    const phtml = ph.length ? ph.map((c) => `<div class="phone-row"><span class="dot ok"></span><div class="pr-main"><b>${esc(c.device)}</b><small>Showing ${esc(screenName(c.screen) || 'PhoneDesk')}</small></div><span class="badge${c.via === 'USB' ? ' usb' : ''}">${esc(c.via)}</span><span class="pr-stat">${c.rtt != null ? c.rtt + ' ms' : '–'}</span><span class="pr-stat">${c.battery ? c.battery.level + '%' + (c.battery.charging ? ' ⚡' : '') : '–'}</span><button class="btn sm" data-identify="${c.id}">Identify</button></div>`).join('')
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
    renderSpicy();
    setText($('cn-bridge-info'), s.bridge.ready ? 'Running' + (s.bridge.restarts ? ` · restarted ${s.bridge.restarts}×` : '') : 'Starting…');
  }
  $('cn-phones').addEventListener('click', (e) => {
    const b = e.target.closest('[data-identify]');
    if (b) api(`phones/${b.dataset.identify}/identify`, {}).catch((er) => toast(er.message));
  });
  // Spicy Lyrics key
  function renderSpicy() {
    const c = state.config || {}, s = state.status;
    const on = !!c.spicyKey;
    $('sl-badge').textContent = on ? 'On' : 'Off';
    $('sl-badge').className = 'badge' + (on ? ' usb' : '');
    $('sl-clear').hidden = !on;
    if (document.activeElement !== $('sl-key')) $('sl-key').value = c.spicyKey || '';
    const cr = s && s.lyrics && s.lyrics.credit;
    let html = '';
    if (cr) {
      const link = (p) => p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name);
      html = 'Current lyrics: ' + esc(cr.provider) + (s.lyrics.wordSynced ? ' (word by word)' : '') + (cr.uploader ? ' · uploaded by ' + link(cr.uploader) : '') + (cr.maker ? ' · made by ' + link(cr.maker) : '');
    }
    if ($('sl-credit').innerHTML !== html) $('sl-credit').innerHTML = html;
  }
  $('sl-save').addEventListener('click', async () => {
    const key = $('sl-key').value.trim();
    setText($('sl-state'), 'Checking…');
    const r = await api('spicy/check', { key }).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) { await saveConfig({ spicyKey: key }); setText($('sl-state'), 'Key works. New songs will use it.'); }
    else setText($('sl-state'), r.error || 'That key was not accepted.');
    renderSpicy();
  });
  $('sl-clear').addEventListener('click', async () => { await saveConfig({ spicyKey: '' }); setText($('sl-state'), 'Removed.'); renderSpicy(); });

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
  const DEFAULT_REPO = 'icdmkg2/phonedesk';
  function renderUpdate() {
    const u = state.update || {};
    const badge = $('up-badge'), text = $('up-text');
    $('up-install').hidden = u.state !== 'ready';
    $('up-download').hidden = u.state !== 'available';
    $('up-check').disabled = u.state === 'source' || u.state === 'checking' || u.state === 'downloading';
    const ver = state.status ? 'v' + state.status.version : '';
    const map = {
      source: ['Dev', 'Running from source code, so it updates with git instead.'],
      off: ['Off', 'No release source set. Add a GitHub repository below to get updates.'],
      idle: [ver, 'Updates are checked a minute after start and every 6 hours.'],
      checking: ['Checking', 'Looking for a newer version…'],
      latest: [ver, 'You have the latest version.'],
      available: ['New version', `PhoneDesk ${u.version || ''} is available. Download it when you are ready; it installs after you press Install.`],
      downloading: ['Downloading', `Downloading PhoneDesk ${u.version || ''}…`],
      ready: ['Update ready', `PhoneDesk ${u.version} is downloaded and checked. Installing takes a few seconds; PhoneDesk restarts by itself.`],
      installing: ['Installing', 'Installing the update. PhoneDesk will restart.'],
      error: ['Problem', 'Couldn\'t update: ' + (u.error || 'unknown error')],
    };
    const [b, t] = map[u.state] || [ver, ''];
    setText(badge, b);
    badge.className = 'badge' + (u.state === 'ready' || u.state === 'available' ? ' usb' : u.state === 'error' ? ' warn' : '');
    setText(text, t);
    // Patch notes live on GitHub Releases (one per version, from CHANGELOG.md).
    const repo = /^[\w.-]+\/[\w.-]+$/.test((state.config && state.config.updateRepo) || '') ? state.config.updateRepo : DEFAULT_REPO;
    const pend = u.state === 'ready' || u.state === 'downloading' || u.state === 'available';
    const shown = pend ? u.version : state.status && state.status.version;
    $('up-notes').href = u.url && shown === u.version ? u.url : `https://github.com/${repo}/releases/tag/v${shown || ''}`;
    setText($('up-notes'), pend ? `What's new in ${u.version}` : `What's new in ${shown ? 'v' + shown : 'this version'}`);
    $('up-all').href = `https://github.com/${repo}/releases`;
    // An update shows as a badge on the Updates item and a pill in the sidebar, not only inside the page.
    const nav = $('nav-updates'), pill = $('up-pill');
    const avail = u.state === 'ready' || u.state === 'available' || u.state === 'downloading' || u.state === 'installing';
    const bad = u.state === 'error';
    nav.hidden = !(avail || bad);
    setText(nav, bad ? '!' : 'New');
    nav.className = 'count ' + (bad ? 'bad' : 'new');
    pill.hidden = !(avail || bad);
    renderUpdateNotes(u, pend);
    pill.classList.toggle('err', bad);
    setText($('up-pill-text'), bad ? 'Update problem' : u.state === 'downloading' ? `Downloading ${u.version || 'update'}…` : u.state === 'installing' ? 'Installing…' : u.version ? 'v' + String(u.version).replace(/^v/, '') + ' available' : 'Update available');
  }
  // The release notes of the waiting version, shown here so there is no need to open GitHub to decide.
  function renderUpdateNotes(u, pend) {
    const card = $('up-notes-card'), body = $('up-notes-body');
    const text = pend && u.notes ? String(u.notes).split(/\n-{3,}\n/)[0] : '';
    card.hidden = !text;
    if (!text) { body.textContent = ''; return; }
    setText($('up-notes-title'), `What's new in ${u.version}`);
    const key = u.version + '|' + text.length;
    if (body.dataset.key === key) return;
    body.dataset.key = key; body.textContent = '';
    let list = null;
    text.split('\n').forEach((raw) => {
      const line = raw.trim(); if (!line) { list = null; return; }
      const h = /^#{1,4}\s+(.*)$/.exec(line), li = /^[-*]\s+(.*)$/.exec(line);
      if (li) { if (!list) { list = document.createElement('ul'); body.appendChild(list); } const el = document.createElement('li'); el.textContent = li[1].replace(/\*\*|\*|`/g, ''); list.appendChild(el); return; }
      list = null;
      const el = document.createElement(h ? 'h4' : 'p'); el.textContent = (h ? h[1] : line).replace(/\*\*|\*|`/g, ''); body.appendChild(el);
    });
  }
  $('up-download').addEventListener('click', async () => { state.update = Object.assign({}, state.update, { state: 'downloading' }); renderUpdate(); state.update = await api('update/download', {}).catch((e) => ({ state: 'error', error: e.message })); renderUpdate(); });
  $('up-autodl').addEventListener('change', (e) => saveConfig({ autoDownload: e.target.checked }));
  $('up-check').addEventListener('click', async () => { state.update = await api('update/check', {}).catch((e) => ({ state: 'error', error: e.message })); renderUpdate(); });
  $('up-install').addEventListener('click', async () => { await api('update/install', {}).catch((e) => toast(e.message)); });
  $('up-auto').addEventListener('change', (e) => saveConfig({ autoUpdate: e.target.checked }));
  $('up-repo').addEventListener('change', (e) => saveConfig({ updateRepo: e.target.value.trim() }).then(async () => {
    state.update = await api('update/check', {}).catch(() => state.update); renderUpdate();
  }));
  function renderUpdateSettings() {
    const c = state.config;
    $('up-auto').checked = c.autoUpdate !== false;
    $('up-autodl').checked = c.autoDownload !== false;
    if (document.activeElement !== $('up-repo')) $('up-repo').value = c.updateRepo || '';
    renderUpdate();
  }

  /* ------------------------------------------------------------ What's new */
  // After an update, the new version's notes (from the CHANGELOG.md that ships with the app) show once.
  async function whatsNew(force) {
    const w = await api('whatsnew').catch(() => null);
    if (!w || !w.html || (!force && !w.show)) { if (force) window.open(`https://github.com/icdmkg2/phonedesk/releases`, '_blank'); return; }
    setText($('wn-ver'), w.version);
    setText($('wn-date'), w.date ? 'Released ' + w.date : '');
    $('wn-body').innerHTML = w.html; // rendered and escaped by the server from our own changelog
    $('wn-gh').href = w.url;
    $('whatsnew').hidden = false;
  }
  function closeWhatsNew() { $('whatsnew').hidden = true; api('whatsnew/seen', {}).catch(() => {}); }
  $('wn-ok').addEventListener('click', closeWhatsNew);
  $('wn-x').addEventListener('click', closeWhatsNew);
  $('whatsnew').addEventListener('click', (e) => { if (e.target === $('whatsnew')) closeWhatsNew(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('whatsnew').hidden) closeWhatsNew(); });
  $('st-ver').addEventListener('click', () => whatsNew(true));
  setTimeout(() => { if ($('onboard').hidden) whatsNew(false); }, 900);

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
    const patch = { onboarded: true, seenVersion: state.status ? state.status.version : '', weather: $('ob-wx').checked, weatherCity: $('ob-wx-city').value.trim(), notifications: $('ob-nt').checked };
    await saveConfig(patch);
    if (!$('ob-as-row').hidden) await api('autostart', { enabled: $('ob-as').checked }).then(loadAutostart).catch(() => {});
    $('onboard').hidden = true;
    toast('You\'re all set');
  }
  $('ob-next').addEventListener('click', () => { if (obStep === 3) finishOnboarding(); else { obStep++; renderOnboarding(); } });
  $('ob-back').addEventListener('click', () => { obStep = Math.max(0, obStep - 1); renderOnboarding(); });
  $('ob-skip').addEventListener('click', async () => { await saveConfig({ onboarded: true }); $('onboard').hidden = true; });
  $('cn-onboard').addEventListener('click', openOnboarding);


  /* ------------------------------------------------------------ addons */
  state.addons = null;
  async function loadAddons(refresh) {
    try { state.addons = await api(refresh ? 'addons/refresh' : 'addons', refresh ? {} : undefined); } catch (e) { if (refresh) toast('Couldn\'t check: ' + e.message); return; }
    renderAddons();
    renderDisplay();
    if (cur()) renderEditor();
  }
  function permChip(p) { return `<span class="ad-perm${p.level === 'high' ? ' high' : ''}" title="${esc(p.label)}">${esc(p.label.length > 44 ? p.label.slice(0, 42) + '…' : p.label)}</span>`; }
  function renderAddons() {
    const a = state.addons;
    if (!a) return;
    const inst = a.installed, byId = Object.fromEntries(inst.map((x) => [x.id, x]));
    setText($('ad-count'), inst.length ? inst.length + (inst.length === 1 ? ' addon' : ' addons') : 'None');
    const updates = inst.filter((x) => x.update).length;
    $('nav-addons').hidden = !updates; setText($('nav-addons'), String(updates));
    $('ad-installed').innerHTML = inst.length ? inst.map((x) => {
      const status = !x.hasServer ? '' : x.running ? '<span class="ad-state ok">Running</span>' : x.enabled ? `<span class="ad-state bad">${esc(x.error || 'Starting…')}</span>` : '';
      return `<div class="ad" data-id="${esc(x.id)}"><div class="ad-main">
        <div class="ad-title"><b>${esc(x.name)}</b><small>v${esc(x.version)} · ${esc(x.author)}${x.source === 'dev' ? ' · loaded from a folder' : x.source === 'link' ? ' · from a link' : x.source === 'file' ? ' · from a file' : ''}</small></div>
        <div class="ad-desc">${esc(x.description)}</div>
        <div class="ad-perms">${x.permissions.length ? x.permissions.map(permChip).join('') : '<span class="ad-perm">Needs no permissions</span>'}</div>
        ${status}
        ${x.update ? `<div class="ad-state ok">Version ${esc(x.update.version)} is available${x.update.needsApproval ? ' and asks for new permissions' : ''}.</div>` : ''}
      </div><div class="ad-actions">
        ${x.update ? `<button class="btn sm primary" data-ad="update" data-id="${esc(x.id)}">Update</button>` : ''}
        ${x.settings.length ? `<button class="btn sm" data-ad="settings" data-id="${esc(x.id)}">Settings</button>` : ''}
        ${x.hasServer || x.screen ? `<button class="btn sm ghost" data-ad="log" data-id="${esc(x.id)}">Log</button>` : ''}
        <span class="switch"><input type="checkbox" data-ad="toggle" data-id="${esc(x.id)}" ${x.enabled ? 'checked' : ''} aria-label="Turn ${esc(x.name)} on or off"><span></span></span>
        <button class="btn sm ghost" data-ad="remove" data-id="${esc(x.id)}">Remove</button>
      </div></div>`;
    }).join('') : '<div class="small muted" style="padding:6px 0">Nothing installed yet. Pick one from the marketplace below.</div>';
    $('ad-auto').checked = !state.config || state.config.autoUpdateAddons !== false;
    setText($('ad-reg-msg'), a.registry.error || (a.registry.entries.length ? '' : 'The marketplace is empty for now.'));
    $('ad-registry').innerHTML = a.registry.entries.map((e) => {
      const have = byId[e.id];
      const newer = have && have.update;
      const incompatible = cmpVer(a.version, e.phonedesk) < 0;
      const action = incompatible ? `<span class="ad-state">Needs PhoneDesk ${esc(e.phonedesk)}</span>` : have ? (newer ? `<button class="btn sm primary" data-ad="update" data-id="${esc(e.id)}">Update</button>` : '<span class="ad-state ok">Installed</span>') : `<button class="btn sm primary" data-ad="install" data-id="${esc(e.id)}">Install</button>`;
      const perms = e.permissionInfo || [];
      return `<div class="ad"><div class="ad-main"><div class="ad-title"><b>${esc(e.name)}</b><small>v${esc(e.version)} · ${esc(e.author)}${e.firstParty ? ' · official' : ''}</small></div>
        <div class="ad-desc">${esc(e.description)}</div>
        <div class="ad-perms">${perms.length ? perms.map(permChip).join('') : '<span class="ad-perm">Needs no permissions</span>'}${e.tags.map((t) => `<span class="ad-perm">${esc(t)}</span>`).join('')}</div>
      </div><div class="ad-actions">${e.homepage ? `<a class="btn sm ghost" href="${esc(e.homepage)}" target="_blank" rel="noopener">Details</a>` : ''}${action}</div></div>`;
    }).join('');
  }
  function cmpVer(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
    return 0;
  }

  // One dialog for all of it: asking for a link, the install prompt with its permissions, settings, removing.
  let adDone = null;
  function adOpen(o) {
    setText($('ad-d-kicker'), o.kicker || 'Addon'); setText($('ad-d-title'), o.title || '');
    $('ad-d-body').innerHTML = o.body || '';
    setText($('ad-d-msg'), '');
    $('ad-d-ok').textContent = o.ok || 'OK'; $('ad-d-ok').disabled = false; $('ad-d-ok').hidden = !o.ok;
    $('ad-d-ok').className = 'btn ' + (o.danger ? 'danger' : 'primary');
    $('ad-d-cancel').textContent = o.cancel || 'Cancel';
    adDone = o.onOk || null;
    $('ad-dialog').hidden = false;
    const f = $('ad-d-body').querySelector('input,select'); if (f) f.focus(); else $('ad-d-ok').focus();
  }
  function adClose() { $('ad-dialog').hidden = true; adDone = null; }
  $('ad-d-x').addEventListener('click', adClose);
  $('ad-d-cancel').addEventListener('click', adClose);
  $('ad-dialog').addEventListener('click', (e) => { if (e.target === $('ad-dialog')) adClose(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('ad-dialog').hidden) adClose(); });
  $('ad-d-ok').addEventListener('click', async () => {
    if (!adDone) return adClose();
    $('ad-d-ok').disabled = true; setText($('ad-d-msg'), '');
    try { const r = await adDone(); if (r !== false) adClose(); else $('ad-d-ok').disabled = false; }
    catch (e) { setText($('ad-d-msg'), e.message); $('ad-d-ok').disabled = false; }
  });

  async function adInstall(body) {
    adOpen({ kicker: 'Install', title: 'Checking…', body: '<p class="small muted">Downloading and checking the addon…</p>', ok: '', cancel: 'Cancel' });
    let p;
    try { p = await api('addons/prepare', body); } catch (e) { adOpen({ kicker: 'Couldn\'t install', title: 'That didn\'t work', body: `<div class="ad-warn">${esc(e.message)}</div>`, cancel: 'Close' }); return; }
    adShowPrepared(p);
  }
  // A .zip from this PC: sent to PhoneDesk, checked like a download, then the same install prompt.
  async function adInstallFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { adOpen({ kicker: 'Couldn\'t install', title: 'That isn\'t a .zip', body: '<div class="ad-warn">An addon is a .zip file with an addon.json inside.</div>', cancel: 'Close' }); return; }
    adOpen({ kicker: 'Install', title: 'Checking…', body: `<p class="small muted">Checking ${esc(file.name)}…</p>`, ok: '', cancel: 'Cancel' });
    let p;
    try {
      const res = await fetch('/api/addons/prepare-file', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || res.statusText);
      p = j;
    } catch (e) { adOpen({ kicker: 'Couldn\'t install', title: 'That didn\'t work', body: `<div class="ad-warn">${esc(e.message)}</div>`, cancel: 'Close' }); return; }
    adShowPrepared(p);
  }
  function adShowPrepared(p) {
    const m = p.manifest;
    adOpen({
      kicker: p.upgradeFrom ? 'Update ' + p.upgradeFrom + ' → ' + m.version : 'Install', title: m.name,
      body: `<div class="small muted">v${esc(m.version)} · ${esc(m.author)}${p.reviewed ? ' · official' : ''}</div><p>${esc(m.description)}</p>
        ${p.warnings.map((w) => `<div class="ad-warn">${esc(w)}</div>`).join('')}
        <div><b style="font-size:13px">${p.permissions.length ? 'This addon will be allowed to:' : 'This addon asks for no permissions.'}</b></div>
        ${p.permissions.length ? `<ul class="perm-list">${p.permissions.map((x) => `<li class="${x.level === 'high' ? 'high' : ''}"><div><b>${x.level === 'high' ? 'Powerful' : x.level === 'medium' ? 'Moderate' : 'Basic'}</b>${esc(x.label)}${p.added.includes(x.id) ? ' <span class="badge warn">New</span>' : ''}${x.detail ? `<div class="small muted">${esc(x.detail)}</div>` : ''}</div></li>`).join('')}</ul>` : ''}
        <p class="small muted">${m.screen ? 'It adds a screen to the phone. ' : ''}${m.server ? 'It runs code on this PC, limited to its own folder and the permissions above.' : 'It runs only on the phone, with no access to your PC.'}</p>`,
      ok: p.upgradeFrom ? 'Update' : 'Install', cancel: 'Cancel',
      onOk: async () => { await api('addons/confirm', { token: p.token, permissions: m.permissions }); await loadAddons(); toast(m.name + (p.upgradeFrom ? ' updated' : ' installed')); },
    });
  }
  function adInstallDialog() {
    adOpen({
      kicker: 'Install', title: 'Install an addon',
      body: `<p class="small muted">Pick an addon's .zip from this PC, or paste a link to one on GitHub. Addons that are not in the marketplace have not been reviewed.</p>
        <label class="ad-drop" id="ad-drop"><input type="file" id="ad-file" accept=".zip,application/zip" hidden><b>Choose a .zip</b><span class="small muted">or drop it here</span></label>
        <div class="small muted" style="text-align:center">or</div>
        <label class="field">Link<input type="text" id="ad-url" placeholder="https://github.com/…/releases/download/…/addon.zip" autocomplete="off" spellcheck="false"></label>`,
      ok: 'Continue with the link', cancel: 'Cancel',
      onOk: async () => { const url = $('ad-url').value.trim(); if (!url) { setText($('ad-d-msg'), 'Choose a .zip or paste a link.'); return false; } setTimeout(() => adInstall({ url }), 0); },
    });
    const drop = $('ad-drop');
    $('ad-file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) setTimeout(() => adInstallFile(f), 0); });
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) setTimeout(() => adInstallFile(f), 0); });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('ad-file').click(); } });
    drop.tabIndex = 0;
  }
  $('ad-link').addEventListener('click', adInstallDialog);
  // a .zip dropped anywhere on the Addons page
  const adPage = $('v-addons');
  adPage.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  adPage.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (!f || $('ad-dialog').hidden === false) return; e.preventDefault(); adInstallFile(f); });
  $('ad-refresh').addEventListener('click', async () => { $('ad-refresh').disabled = true; await loadAddons(true); $('ad-refresh').disabled = false; toast('Checked for updates'); });
  $('ad-auto').addEventListener('change', (e) => saveConfig({ autoUpdateAddons: e.target.checked }));

  // The addon's log and health: what it printed, how many messages it sent, how fast its code answers.
  async function adLog(x) {
    const d = await api('addons/log?id=' + encodeURIComponent(x.id)).catch((e) => { toast(e.message); return null; });
    if (!d) return;
    const fmt = (t) => new Date(t).toLocaleTimeString();
    const stat = (k, v, warn) => `<div class="ad-stat${warn ? ' warn' : ''}"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
    const stats = d.hasServer ? [
      stat('PC-side code', d.running ? 'running' : (d.error || 'not running'), !d.running),
      stat('Answers in', d.lagMs == null ? 'not measured yet' : d.lagMs + ' ms' + (d.lagMaxMs > 1000 ? ' (slowest ' + d.lagMaxMs + ' ms)' : ''), d.lagMaxMs > 1000),
      stat('Messages to its screen, last minute', String(d.sentLastMinute)), stat('Dropped for sending too fast', String(d.droppedTotal), d.droppedTotal > 0),
      stat('Requests to PhoneDesk', d.rpcTotal + (d.rpcFailed ? ` (${d.rpcFailed} failed)` : ''), d.rpcFailed > 0), stat('Restarts in 5 minutes', String(d.restarts), d.restarts > 0),
    ].join('') : '<p class="small muted">This addon has no PC-side code, so there is nothing to measure here. If its screen feels slow, the page itself is doing too much work on the phone.</p>';
    const lines = d.logs.length ? d.logs.map((l) => `${fmt(l.t)}  ${l.level.toUpperCase().padEnd(5)} ${l.text}`).join('\n') : 'Nothing logged yet.';
    adOpen({
      kicker: x.name, title: 'Log and health',
      body: `<div class="ad-stats">${stats}</div>${d.slowRpc.length ? `<p class="small muted">Slow requests: ${d.slowRpc.map((s) => esc(s.method) + ' ' + s.ms + ' ms').join(', ')}</p>` : ''}<pre class="ad-log" tabindex="0">${esc(lines)}</pre>`,
      ok: 'Copy', cancel: 'Close',
      onOk: async () => { try { await navigator.clipboard.writeText(`${d.name} ${d.version}\n` + lines); toast('Copied'); } catch (e) { toast('Couldn\'t copy'); } return false; },
    });
  }

  function adSettings(x) {
    const field = (s) => {
      const id = 'ad-s-' + s.key, hint = s.hint ? `<span class="hint">${esc(s.hint)}</span>` : '';
      if (s.type === 'boolean') return `<label class="field"><span><input type="checkbox" id="${id}" ${s.value ? 'checked' : ''}> ${esc(s.label)}</span>${hint}</label>`;
      if (s.type === 'select') return `<label class="field">${esc(s.label)}<select id="${id}">${s.options.map((o) => `<option${o === s.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>${hint}</label>`;
      if (s.type === 'password') return `<label class="field">${esc(s.label)}<input type="password" id="${id}" placeholder="${s.isSet ? 'Saved. Type to replace.' : esc(s.placeholder || '')}" autocomplete="new-password">${hint}</label>`;
      return `<label class="field">${esc(s.label)}<input type="${s.type === 'number' ? 'number' : 'text'}" id="${id}" value="${esc(s.value)}" placeholder="${esc(s.placeholder || '')}" autocomplete="off" spellcheck="false">${hint}</label>`;
    };
    adOpen({
      kicker: x.name, title: 'Settings', body: x.settings.map(field).join(''), ok: 'Save', cancel: 'Cancel',
      onOk: async () => {
        const values = {};
        x.settings.forEach((s) => { const el = $('ad-s-' + s.key); values[s.key] = s.type === 'boolean' ? el.checked : s.type === 'number' ? Number(el.value) : el.value; });
        await api('addons/settings', { id: x.id, values });
        await loadAddons(); toast('Saved');
      },
    });
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ad]');
    if (!b || b.type === 'checkbox') return;
    const id = b.dataset.id, x = ((state.addons && state.addons.installed) || []).find((a) => a.id === id);
    if (b.dataset.ad === 'install' || b.dataset.ad === 'update') adInstall({ registryId: id });
    else if (b.dataset.ad === 'settings' && x) adSettings(x);
    else if (b.dataset.ad === 'log' && x) adLog(x);
    else if (b.dataset.ad === 'remove' && x) adOpen({
      kicker: 'Remove', title: x.name,
      body: `<p>Remove this addon from the phone and this PC?</p><label class="field"><span><input type="checkbox" id="ad-keep"> Keep its saved data</span></label>`,
      ok: 'Remove', danger: true, cancel: 'Cancel',
      onOk: async () => { await api('addons/remove', { id, keepData: $('ad-keep').checked }); await loadAddons(); toast(x.name + ' removed'); },
    });
  });
  document.addEventListener('change', async (e) => {
    const b = e.target.closest('[data-ad="toggle"]');
    if (!b) return;
    try { await api('addons/enable', { id: b.dataset.id, enabled: b.checked }); await loadAddons(); } catch (err) { toast(err.message); b.checked = !b.checked; }
  });


  /* ------------------------------------------------------------ layouts (pages made of widgets) */
  const LY = { W: 960, H: 444, pad: 8, gap: 8, cols: 12, rows: 6 };
  const ly = { sel: '', wsel: '', draft: [], cat: null, timer: null, scale: 1, drag: null, base: [], undo: [], redo: [], open: {}, pending: false };
  const lyCell = () => ({ cw: (LY.W - 2 * LY.pad - LY.gap * (LY.cols - 1)) / LY.cols, ch: (LY.H - 2 * LY.pad - LY.gap * (LY.rows - 1)) / LY.rows });
  function lyPage() { return ly.draft.find((p) => p.id === ly.sel) || null; }
  function lyWidget() { const p = lyPage(); return p ? p.widgets.find((w) => w.id === ly.wsel) || null : null; }
  function lyType(type) {
    if (!ly.cat) return null;
    return ly.cat.types.find((t) => t.type === type) || ly.cat.addonWidgets.find((t) => t.type === type) || null;
  }
  const lyOverlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  function lyFree(p, w, h) {
    for (let y = 0; y + h <= LY.rows; y++) for (let x = 0; x + w <= LY.cols; x++) if (!p.widgets.some((o) => lyOverlap({ x, y, w, h }, o))) return { x, y };
    return null;
  }
  // Undo and redo: one step for each burst of edits (a drag, some typing). Adding or deleting a page starts a fresh history.
  function lyHistReset() { ly.base = clone(ly.draft); ly.undo = []; ly.redo = []; ly.open = {}; ly.draft.forEach((p) => { ly.open[p.id] = clone(p); }); lyHistButtons(); }
  function lyHistButtons() {
    const p = lyPage();
    $('ly-undo').disabled = !ly.undo.length; $('ly-redo').disabled = !ly.redo.length;
    $('ly-reset').disabled = !p || !ly.open[p.id] || JSON.stringify(ly.open[p.id].widgets) === JSON.stringify(p.widgets);
  }
  async function lyJump(stack, other) {
    if (!stack.length) return;
    other.push(clone(ly.draft));
    ly.draft = stack.pop(); ly.base = clone(ly.draft);
    if (!lyWidget()) ly.wsel = '';
    clearTimeout(ly.timer); ly.pending = false;
    try { state.config = await api('config', { pages: ly.draft }); ly.draft = clone(state.config.pages); ly.base = clone(ly.draft); setText($('ly-state'), 'Saved'); renderDisplay(); } catch (e) { setText($('ly-state'), 'Couldn\'t save: ' + e.message); }
    renderLayouts(true);
  }
  const lyUndo = () => lyJump(ly.undo, ly.redo), lyRedo = () => lyJump(ly.redo, ly.undo);
  $('ly-undo').addEventListener('click', lyUndo);
  $('ly-redo').addEventListener('click', lyRedo);
  $('ly-reset').addEventListener('click', () => {
    const p = lyPage(); if (!p || !ly.open[p.id]) return;
    ly.undo.push(clone(ly.draft)); ly.redo = [];
    p.widgets = clone(ly.open[p.id].widgets); ly.wsel = '';
    ly.pending = true; renderLayouts(true); lySave();
  });
  function lyDuplicate() {
    const p = lyPage(), w = lyWidget(); if (!p || !w) return;
    if (p.widgets.length >= ly.cat.limits.widgets) return toast(`${ly.cat.limits.widgets} widgets is the most on a page`);
    const spot = lyFree(p, w.w, w.h);
    if (!spot) return toast('No room for a copy. Make some space first.');
    const nw = Object.assign(clone(w), { id: 'w' + Math.random().toString(36).slice(2, 10), x: spot.x, y: spot.y });
    p.widgets.push(nw); ly.wsel = nw.id; renderLayouts(true); lySave();
  }
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Ctrl+D while the Layouts page is open (not while typing in a field)
  document.addEventListener('keydown', (e) => {
    if (!$('v-layouts').classList.contains('on') || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.target.closest && e.target.closest('input[type=text], input[type=number], textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); lyUndo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); lyRedo(); }
    else if (k === 'd') { e.preventDefault(); lyDuplicate(); }
  });
  async function openLayouts() {
    if (!state.config) { try { await loadConfig(); } catch (e) { return; } }
    try { ly.cat = await api('widgets'); } catch (e) { toast('Couldn\'t load widgets: ' + e.message); return; }
    ly.draft = clone((state.config && state.config.pages) || []);
    if (!ly.draft.some((p) => p.id === ly.sel)) { ly.sel = ly.draft.length ? ly.draft[0].id : ''; ly.wsel = ''; }
    lyHistReset();
    renderLayouts();
  }
  function lySave() {
    if (!ly.pending) { ly.pending = true; ly.undo.push(ly.base); if (ly.undo.length > 50) ly.undo.shift(); ly.redo = []; }
    setText($('ly-state'), 'Saving…');
    clearTimeout(ly.timer);
    ly.timer = setTimeout(async () => {
      try {
        state.config = await api('config', { pages: ly.draft });
        // the server may have tidied the pages (kept inside the grid, moved overlaps); follow it unless a drag is going on
        if (!ly.drag) { ly.draft = clone(state.config.pages); renderLayouts(true); }
        ly.pending = false; ly.base = clone(state.config.pages);
        setText($('ly-state'), 'Saved'); renderDisplay(); lyHistButtons();
      } catch (e) { setText($('ly-state'), 'Couldn\'t save: ' + e.message); }
    }, 350);
  }
  function renderLayouts(keepFrame) {
    const has = ly.draft.length > 0, p = lyPage();
    $('ly-main').hidden = !has || !p; $('ly-none').hidden = has;
    setText($('ly-count'), has ? ly.draft.length + (ly.draft.length === 1 ? ' page' : ' pages') : 'None');
    const onPhone = ((state.config || {}).screens || []);
    $('ly-list').innerHTML = ly.draft.map((x) => `<button class="ly-item" data-pg="${esc(x.id)}" aria-current="${x.id === ly.sel}"><b>${esc(x.name)}</b><small>${x.widgets.length} widget${x.widgets.length === 1 ? '' : 's'}${onPhone.includes('page:' + x.id) ? ' · on the phone' : ' · hidden'}</small></button>`).join('');
    if (!p) return;
    if (document.activeElement !== $('ly-name')) $('ly-name').value = p.name;
    $('ly-onphone').checked = onPhone.includes('page:' + p.id);
    $('ly-bg').value = p.bg || ''; $('ly-radius').value = p.radius || ''; $('ly-accent').value = p.accent || '#5b8cff'; $('ly-accent-clear').hidden = !p.accent;
    const fr = $('ly-frame'), want = '/phone/?preview=' + p.id;
    if (fr.getAttribute('data-src') !== want) { fr.setAttribute('data-src', want); fr.src = want; }
    lyFit(); renderLyOverlay(); renderLyPalette(); renderLyOpts(); lyHistButtons();
  }
  function lyFit() {
    const st = $('ly-stage'), w = st.clientWidth || 600;
    ly.scale = w / LY.W;
    $('ly-canvas').style.transform = `scale(${ly.scale})`;
    st.style.height = Math.round(LY.H * ly.scale) + 'px';
  }
  window.addEventListener('resize', () => { if ($('v-layouts').classList.contains('on')) lyFit(); });
  function lyBox(w) {
    const { cw, ch } = lyCell();
    return { left: LY.pad + w.x * (cw + LY.gap), top: LY.pad + w.y * (ch + LY.gap), width: w.w * cw + (w.w - 1) * LY.gap, height: w.h * ch + (w.h - 1) * LY.gap };
  }
  function lyPlace(el, w) { const b = lyBox(w); el.style.left = b.left + 'px'; el.style.top = b.top + 'px'; el.style.width = b.width + 'px'; el.style.height = b.height + 'px'; }
  function renderLyOverlay() {
    const p = lyPage(); if (!p) return;
    $('ly-over').innerHTML = p.widgets.map((w) => {
      const t = lyType(w.type), name = t ? t.name : 'Missing widget';
      return `<div class="lay-w${w.id === ly.wsel ? ' on' : ''}" tabindex="0" role="button" data-id="${esc(w.id)}" aria-label="${esc(name)}, ${w.w} by ${w.h}, column ${w.x + 1}, row ${w.y + 1}"><span class="lay-tag">${esc(name)}</span><i class="lay-h" data-h="1"></i></div>`;
    }).join('');
    p.widgets.forEach((w) => lyPlace($('ly-over').querySelector(`[data-id="${w.id}"]`), w));
  }
  function renderLyPalette() {
    if (!ly.cat) return;
    const btn = (t) => `<button class="btn sm" data-add="${esc(t.type)}" title="${esc(t.desc || '')}">+ ${esc(t.name)}</button>`;
    $('ly-palette').innerHTML = ly.cat.types.map(btn).join('') + (ly.cat.addonWidgets.length ? '<div class="group">From addons</div>' + ly.cat.addonWidgets.map((t) => btn(Object.assign({}, t, { name: t.name + ' · ' + t.addon }))).join('') : '');
  }
  function lyField(f, v) {
    const id = 'ly-o-' + f.key;
    if (f.type === 'boolean') return `<label class="field"><span><input type="checkbox" id="${id}" data-opt="${f.key}" ${v ? 'checked' : ''}> ${esc(f.label)}</span></label>`;
    if (f.type === 'select') return `<label class="field">${esc(f.label)}<select id="${id}" data-opt="${f.key}">${(f.options || []).map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    if (f.type === 'number') return `<label class="field">${esc(f.label)}<input type="number" id="${id}" data-opt="${f.key}" value="${esc(v)}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}></label>`;
    return `<label class="field">${esc(f.label)}<input type="text" id="${id}" data-opt="${f.key}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" autocomplete="off"></label>`;
  }
  function renderLyOpts() {
    const w = lyWidget(), box = $('ly-opts');
    if (!w) { box.innerHTML = '<h3>Widget</h3><p class="small muted">Select a widget on the page to change its size and options, or add one from the left.</p>'; return; }
    const t = lyType(w.type), min = t ? { w: t.minW || 1, h: t.minH || 1 } : { w: 1, h: 1 };
    box.innerHTML = `<div class="card-head"><h3>${esc(t ? t.name : 'Missing widget')}</h3><span class="row"><button class="btn sm ghost" id="ly-dup" title="Duplicate (Ctrl+D)">Duplicate</button><button class="btn sm ghost" id="ly-rm">Remove</button></span></div>
      <p class="small muted">${esc(t ? t.desc || '' : 'This widget comes from an addon that is turned off or removed. It shows nothing on the phone until the addon is back.')}</p>
      <div class="ly-opts-grid"><div class="ly-size"><label>Width<input type="number" id="ly-w" min="${min.w}" max="${LY.cols}" value="${w.w}"></label><label>Height<input type="number" id="ly-h" min="${min.h}" max="${LY.rows}" value="${w.h}"></label></div>
      ${((t && t.opts) || []).map((f) => lyField(f, w.opts && w.opts[f.key] !== undefined ? w.opts[f.key] : f.default)).join('')}
      ${w.type.startsWith('addon:') ? '' : lyTapField(w) + lyTapField(w, 'hold', 'When held')}
      <label class="field">Style<select id="ly-look"><option value="">Card</option><option value="outline"${w.look === 'outline' ? ' selected' : ''}>Outline only</option><option value="clear"${w.look === 'clear' ? ' selected' : ''}>No card</option></select></label></div>`;
  }
  // "When tapped": open a screen, press a shortcut button, or control the music
  function lyTapField(w, key, label) {
    key = key || 'tap'; label = label || 'When tapped';
    const c = state.config || {}, cur = w[key] || '';
    const opt = (v, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    return `<label class="field">${esc(label)}<select id="ly-${key}"><option value="">Nothing</option>
      <optgroup label="Open a screen">${(c.screens || []).map((s) => opt('screen:' + s, screenName(s))).join('')}</optgroup>
      <optgroup label="Press a shortcut">${(c.shortcuts || []).map((s) => opt('shortcut:' + s.id, s.label)).join('')}</optgroup>
      <optgroup label="Music">${opt('media:toggle', 'Play or pause')}${opt('media:next', 'Next song')}${opt('media:prev', 'Previous song')}</optgroup></select></label>`;
  }
  function lySelect(id) { ly.wsel = id || ''; renderLyOverlay(); renderLyOpts(); }
  // Where a widget may go. If the asked spot overlaps another widget it snaps to the nearest free one: a move
  // slides to the closest free cell (up to 2 cells away), a resize shrinks to the largest size that fits.
  function lyApply(w, next, resize) {
    const p = lyPage(), t = lyType(w.type), minW = (t && t.minW) || 1, minH = (t && t.minH) || 1;
    const n = { x: next.x, y: next.y, w: Math.max(minW, Math.min(LY.cols, next.w)), h: Math.max(minH, Math.min(LY.rows, next.h)) };
    n.x = Math.max(0, Math.min(LY.cols - n.w, n.x)); n.y = Math.max(0, Math.min(LY.rows - n.h, n.y));
    const free = (r) => !p.widgets.some((o) => o.id !== w.id && lyOverlap(r, o));
    if (free(n)) return { n, ok: true };
    if (resize) {
      let best = null;
      for (let ww = n.w; ww >= minW; ww--) for (let hh = n.h; hh >= minH; hh--) {
        const r = { x: n.x, y: n.y, w: ww, h: hh };
        if (free(r) && (!best || ww * hh > best.w * best.h)) best = r;
      }
      return best ? { n: best, ok: true } : { n, ok: false };
    }
    let best = null, bd = 1e9;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const r = { x: n.x + dx, y: n.y + dy, w: n.w, h: n.h };
      if (r.x < 0 || r.y < 0 || r.x + r.w > LY.cols || r.y + r.h > LY.rows || !free(r)) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < bd) { bd = d; best = r; }
    }
    return best ? { n: best, ok: true } : { n, ok: false };
  }
  function lyCommit(w, n) { Object.assign(w, n); renderLyOverlay(); renderLyOpts(); lySave(); }

  // dragging: move from the box, resize from the corner; the box snaps to cells and turns red where it would overlap
  $('ly-over').addEventListener('pointerdown', (e) => {
    const box = e.target.closest('.lay-w');
    if (!box) { lySelect(''); return; }
    const w = lyPage().widgets.find((x) => x.id === box.dataset.id); if (!w) return;
    if (ly.wsel !== w.id) { ly.wsel = w.id; renderLyOpts(); $('ly-over').querySelectorAll('.lay-w').forEach((b) => b.classList.toggle('on', b === box)); }
    ly.drag = { id: w.id, resize: !!e.target.closest('.lay-h'), sx: e.clientX, sy: e.clientY, orig: { x: w.x, y: w.y, w: w.w, h: w.h }, next: null, ok: true, box };
    box.setPointerCapture(e.pointerId); box.classList.add('drag'); e.preventDefault();
  });
  $('ly-over').addEventListener('pointermove', (e) => {
    const d = ly.drag; if (!d) return;
    const { cw, ch } = lyCell();
    const dx = Math.round(((e.clientX - d.sx) / ly.scale) / (cw + LY.gap)), dy = Math.round(((e.clientY - d.sy) / ly.scale) / (ch + LY.gap));
    const w = lyPage().widgets.find((x) => x.id === d.id);
    const r = lyApply(w, d.resize ? { x: d.orig.x, y: d.orig.y, w: d.orig.w + dx, h: d.orig.h + dy } : { x: d.orig.x + dx, y: d.orig.y + dy, w: d.orig.w, h: d.orig.h }, d.resize);
    d.next = r.n; d.ok = r.ok; lyPlace(d.box, r.n); d.box.classList.toggle('bad', !r.ok);
  });
  function lyEnd(e) {
    const d = ly.drag; if (!d) return;
    ly.drag = null; d.box.classList.remove('drag', 'bad');
    const w = lyPage().widgets.find((x) => x.id === d.id);
    if (d.next && d.ok && (d.next.x !== w.x || d.next.y !== w.y || d.next.w !== w.w || d.next.h !== w.h)) lyCommit(w, d.next);
    else { renderLyOverlay(); if (d.next && !d.ok) toast('That would overlap another widget'); }
  }
  $('ly-over').addEventListener('pointerup', lyEnd);
  $('ly-over').addEventListener('pointercancel', lyEnd);
  // the keyboard: arrows move the selected widget, Shift + arrows resize it, Delete removes it
  $('ly-over').addEventListener('keydown', (e) => {
    const w = lyWidget(), box = e.target.closest('.lay-w');
    if (!w || !box || box.dataset.id !== w.id) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); lyRemove(); return; }
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const r = lyApply(w, e.shiftKey ? { x: w.x, y: w.y, w: w.w + d[0], h: w.h + d[1] } : { x: w.x + d[0], y: w.y + d[1], w: w.w, h: w.h }, e.shiftKey);
    if (r.ok) { lyCommit(w, r.n); const nb = $('ly-over').querySelector(`[data-id="${w.id}"]`); if (nb) nb.focus(); } else toast('That would overlap another widget');
  });
  function lyRemove() {
    const p = lyPage(); if (!p || !ly.wsel) return;
    p.widgets = p.widgets.filter((x) => x.id !== ly.wsel); ly.wsel = '';
    renderLyOverlay(); renderLyOpts(); renderLayouts(true); lySave();
  }
  $('ly-opts').addEventListener('click', (e) => { if (e.target.closest('#ly-rm')) lyRemove(); else if (e.target.closest('#ly-dup')) lyDuplicate(); });
  $('ly-opts').addEventListener('change', (e) => {
    const w = lyWidget(); if (!w) return;
    if (e.target.id === 'ly-w' || e.target.id === 'ly-h') {
      const r = lyApply(w, { x: w.x, y: w.y, w: +$('ly-w').value, h: +$('ly-h').value }, true);
      if (r.ok) lyCommit(w, r.n); else { toast('That would overlap another widget'); renderLyOpts(); }
      return;
    }
    if (e.target.id === 'ly-tap' || e.target.id === 'ly-hold' || e.target.id === 'ly-look') {
      const k = e.target.id.slice(3);
      if (e.target.value) w[k] = e.target.value; else delete w[k];
      lySave(); return;
    }
    const key = e.target.dataset.opt; if (!key) return;
    w.opts = w.opts || {};
    w.opts[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    lySave();
  });
  $('ly-opts').addEventListener('input', (e) => {
    const w = lyWidget(); if (!w || !e.target.dataset.opt || e.target.type !== 'text') return;
    w.opts = w.opts || {}; w.opts[e.target.dataset.opt] = e.target.value; lySave();
  });
  $('ly-palette').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]'), p = lyPage(); if (!b || !p) return;
    const t = lyType(b.dataset.add); if (!t) return;
    if (p.widgets.length >= ly.cat.limits.widgets) return toast(`${ly.cat.limits.widgets} widgets is the most on a page`);
    let w = t.defW || 3, h = t.defH || 2, spot = lyFree(p, w, h);
    if (!spot) { w = t.minW || 1; h = t.minH || 1; spot = lyFree(p, w, h); }
    if (!spot) return toast('No room on this page. Make some space first.');
    const nw = { id: 'w' + Math.random().toString(36).slice(2, 10), type: t.type, x: spot.x, y: spot.y, w, h, opts: {} };
    (t.opts || []).forEach((f) => { nw.opts[f.key] = f.default; });
    p.widgets.push(nw); ly.wsel = nw.id;
    renderLayouts(true); lySave();
  });
  $('ly-list').addEventListener('click', (e) => { const b = e.target.closest('[data-pg]'); if (b) { ly.sel = b.dataset.pg; ly.wsel = ''; renderLayouts(); } });
  $('ly-radius').addEventListener('change', (e) => { const p = lyPage(); if (!p) return; if (e.target.value) p.radius = e.target.value; else delete p.radius; lySave(); });
  $('ly-bg').addEventListener('change', (e) => { const p = lyPage(); if (!p) return; if (e.target.value) p.bg = e.target.value; else delete p.bg; lySave(); });
  $('ly-accent').addEventListener('input', (e) => { const p = lyPage(); if (!p) return; p.accent = e.target.value; $('ly-accent-clear').hidden = false; lySave(); });
  $('ly-accent-clear').addEventListener('click', () => { const p = lyPage(); if (!p) return; delete p.accent; $('ly-accent-clear').hidden = true; lySave(); });
  $('ly-name').addEventListener('input', (e) => { const p = lyPage(); if (!p) return; p.name = e.target.value.slice(0, 24); renderLayouts(true); lySave(); });
  $('ly-onphone').addEventListener('change', async (e) => {
    const p = lyPage(); if (!p) return;
    const key = 'page:' + p.id, cur = state.config.screens || [];
    const screens = e.target.checked ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter((x) => x !== key);
    if (!screens.length) { e.target.checked = true; return toast('Keep at least one screen on the phone'); }
    try { state.config = await api('config', { screens }); renderLayouts(true); renderDisplay(); } catch (err) { toast(err.message); }
  });
  $('ly-del').addEventListener('click', () => {
    const p = lyPage(); if (!p) return;
    adOpen({
      kicker: 'Delete', title: p.name, body: '<p>Delete this page and its layout?</p>', ok: 'Delete', danger: true, cancel: 'Cancel',
      onOk: async () => {
        ly.draft = ly.draft.filter((x) => x.id !== p.id);
        state.config = await api('config', { pages: ly.draft });
        ly.draft = clone(state.config.pages); ly.sel = ly.draft.length ? ly.draft[0].id : ''; ly.wsel = ''; lyHistReset();
        renderLayouts(); renderDisplay(); toast('Page deleted');
      },
    });
  });
  // Customize a built-in screen: it becomes a page with the same widgets, in the same place in the swipe row
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-customize]');
    if (!b) return;
    const screen = b.dataset.customize, name = SCREEN_NAMES[screen];
    adOpen({
      kicker: 'Customize', title: name,
      body: `<p>Turn <b>${esc(name)}</b> into a page of widgets that you can move, resize and mix with other widgets. It takes the same place in the swipe row.</p>
        <p class="small muted">${screen === 'media' ? 'The lyrics sheet that pulls up over Now playing is not part of the widget version. ' : ''}${screen === 'shortcuts' ? 'Shortcut buttons appear in one grid, without the group tabs. ' : ''}The original screen stays available: turn it back on in Phone display whenever you like.</p>`,
      ok: 'Customize', cancel: 'Cancel',
      onOk: async () => {
        const r = await api('pages/from-screen', { screen });
        state.config = r.config; ly.draft = clone(r.config.pages); ly.sel = r.page.id; ly.wsel = ''; lyHistReset();
        renderDisplay(); go('layouts'); toast(name + ' is now a page you can edit');
      },
    });
  });

  function lyNewPage() {
    if (!ly.cat) return;
    adOpen({
      kicker: 'New page', title: 'Start from',
      body: `<fieldset class="ly-tpl">${ly.cat.templates.map((t, i) => `<label><input type="radio" name="ly-tpl" value="${esc(t.key)}" ${i === 0 ? 'checked' : ''}><span><b>${esc(t.name)}</b><span class="d">${esc(t.desc)}</span></span></label>`).join('')}</fieldset>
        <label class="field">Name<input type="text" id="ly-newname" maxlength="24" placeholder="My page" autocomplete="off"></label>`,
      ok: 'Create', cancel: 'Cancel',
      onOk: async () => {
        const tpl = document.querySelector('input[name="ly-tpl"]:checked').value;
        const r = await api('pages/new', { template: tpl, name: $('ly-newname').value.trim() });
        state.config = r.config; ly.draft = clone(r.config.pages); ly.sel = r.page.id; ly.wsel = ''; lyHistReset();
        renderLayouts(); renderDisplay(); toast('Page created. It is on the phone now.');
      },
    });
  }
  $('ly-new').addEventListener('click', lyNewPage);
  $('ly-new2').addEventListener('click', lyNewPage);

  /* ------------------------------------------------------------ boot */
  go((location.hash.slice(1) || 'overview'));
  connect();
  refresh();
  loadConfig().then(() => {
    renderUpdateSettings();
    if (!state.config.onboarded) openOnboarding();
  }).catch(() => toast('Couldn\'t load settings'));
  loadSpotify();
  loadAddons();
  api('update').then((u) => { state.update = u; renderUpdate(); }).catch(() => {});
  api('weather').then((w) => { state.weather = w && w.city ? w : null; renderWeatherNow(); }).catch(() => {});
  loadActivity();
  loadAutostart();
  setInterval(() => { if (!document.hidden) refresh(); }, 3000);
  setInterval(() => { if (!document.hidden) loadActivity(); }, 6000);
  window.addEventListener('beforeunload', () => { if (scDirty) saveShortcuts(); });
})();
