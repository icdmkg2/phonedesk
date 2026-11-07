(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ICONS = ['bolt', 'mic', 'desktop', 'lock', 'camera', 'music', 'play', 'chart', 'folder', 'globe', 'game', 'code', 'chat', 'power', 'vol', 'next'];
  const SCREEN_NAMES = { media: 'Now playing', clock: 'Clock', stats: 'PC stats', shortcuts: 'Shortcuts' };
  const ALL_SCREENS = Object.keys(SCREEN_NAMES);

  let config = null;
  let status = null;
  let selectedUrl = localStorage.getItem('pd.url') || '';
  let lastQr = '';

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('on'), 1600);
  }

  async function api(path, body) {
    const res = await fetch('/api/' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  /* ---------------------------------------------------------------- tabs */
  function showTab(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === 't-' + name));
    if (name === 'logs') loadLogs();
    history.replaceState(null, '', '#' + name);
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
  if (location.hash.length > 1) showTab(location.hash.slice(1));

  /* ---------------------------------------------------------------- status */
  function pill(id, cls) { const el = $(id); el.className = 'pill ' + cls; }

  async function refresh() {
    try {
      status = await api('status');
      pill('h-server', 'ok');
    } catch (e) {
      pill('h-server', 'bad'); pill('h-bridge', ''); return;
    }
    $('ver').textContent = 'v' + status.version;
    pill('h-bridge', status.bridge.ready ? 'ok' : status.bridge.running ? 'warn' : 'bad');
    $('bridge-info').textContent = status.bridge.ready ? 'Running' + (status.bridge.restarts ? ` · restarted ${status.bridge.restarts}×` : '') : 'Starting…';
    $('h-phones-n').textContent = status.clients.length;
    $('h-phones-w').textContent = status.clients.length === 1 ? 'phone' : 'phones';
    pill('h-phones', status.clients.length ? 'ok' : '');
    renderUrls();
    renderUsb();
    renderPhones();
  }

  function renderUrls() {
    const box = $('urls');
    const urls = status.urls;
    if (!urls.length) {
      box.innerHTML = '<div class="muted small">No network found. Connect the PC to Wi-Fi or Ethernet, or use USB.</div>';
      return;
    }
    if (!urls.some((u) => u.url === selectedUrl)) selectedUrl = urls[0].url;
    const html = urls.map((u) => `<div class="url${u.url === selectedUrl ? ' on' : ''}" data-url="${u.url}" title="Click to show this one as the QR code"><span>${u.url}</span><small>${esc(u.name)}</small><button class="btn ghost sm" data-copy="${u.url}">Copy</button></div>`).join('');
    if (box.innerHTML !== html) box.innerHTML = html;
    const qrText = selectedUrl + '/phone';
    if (qrText !== lastQr) { lastQr = qrText; $('qr').src = '/api/qr?text=' + encodeURIComponent(qrText); }
  }
  $('urls').addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      e.stopPropagation();
      navigator.clipboard.writeText(copy.dataset.copy + '/phone').then(() => toast('Copied'), () => toast(copy.dataset.copy + '/phone'));
      return;
    }
    const row = e.target.closest('[data-url]');
    if (row) { selectedUrl = row.dataset.url; localStorage.setItem('pd.url', selectedUrl); renderUrls(); }
  });

  function renderUsb() {
    const a = status.adb;
    const box = $('usb');
    $('usb-install').hidden = a.found || a.installing;
    $('usb-connect').disabled = !a.found;
    let html = '';
    if (a.installing) html = '<div class="dev warn"><i></i>Downloading ADB…</div>';
    else if (!a.found) html = '<div class="dev"><i></i>ADB isn\'t installed. Download it to use USB.</div>';
    else if (!a.devices.length) html = '<div class="dev"><i></i>No phone plugged in</div>';
    else html = a.devices.map((d) => {
      const st = d.state === 'device' ? (d.reversed ? ['ok', 'Linked'] : ['warn', 'Linking…'])
        : d.state === 'unauthorized' ? ['warn', 'Accept the prompt on the phone'] : ['', d.state];
      return `<div class="dev ${st[0]}"><i></i>${esc(d.model)}<small>${st[1]}</small></div>`;
    }).join('');
    if (a.error && a.found) html += `<div class="muted small">${esc(a.error)}</div>`;
    if (box.innerHTML !== html) box.innerHTML = html;
  }
  $('usb-connect').addEventListener('click', async () => {
    $('usb-connect').disabled = true;
    try { const r = await api('adb/connect', {}); toast(r.devices.some((d) => d.reversed) ? 'Opened PhoneDesk on the phone' : 'No linked phone found'); }
    catch (e) { toast(e.message); }
    refresh();
  });
  $('usb-install').addEventListener('click', async () => {
    $('usb-install').hidden = true;
    toast('Downloading ADB from Google…');
    const p = api('adb/install', {});
    setTimeout(refresh, 300);
    try { const r = await p; toast(r.found ? 'ADB ready' : 'ADB download failed, see Logs'); } catch (e) { toast(e.message); }
    refresh();
  });

  function renderPhones() {
    const ul = $('phones');
    const list = status.clients;
    const html = list.length ? list.map((c) => `<li><span class="via">${c.via}</span>${esc(c.device)}<small>${esc(SCREEN_NAMES[c.screen] || '')} · ${ago(c.since)}</small></li>`).join('')
      : '<li class="none">No phones connected yet</li>';
    if (ul.innerHTML !== html) ul.innerHTML = html;
  }
  $('reload-phones').addEventListener('click', async () => { await api('phones/reload', {}); toast('Reloading phones'); });

  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min';
    return Math.round(s / 3600) + ' h';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---------------------------------------------------------------- live media via websocket */
  let ws, media = { active: false }, volDragging = false, offset = 0;
  function connectWs() {
    ws = new WebSocket(`ws://${location.host}/ws?role=dashboard`);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'hello') offset = m.d.serverTime - Date.now();
      if (m.t === 'media') { media = m.d; renderMedia(); }
      if (m.t === 'volume' && !volDragging) { $('np-vol').value = Math.round(m.d.level * 100); $('np-vol-n').textContent = m.d.muted ? 'M' : Math.round(m.d.level * 100); }
      if (m.t === 'clients') refresh();
    };
    ws.onclose = () => { pill('h-server', 'bad'); setTimeout(connectWs, 1500); };
    ws.onopen = () => refresh();
  }
  const PLAY = '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/>';
  const PAUSE = '<rect x="6" y="5" width="4.2" height="14" rx="1.2" fill="currentColor"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" fill="currentColor"/>';
  function renderMedia() {
    $('np-title').textContent = media.active ? media.title || 'Unknown title' : 'Nothing playing';
    $('np-artist').textContent = media.active ? media.artist || media.album || '' : 'Start music or a video on this PC';
    $('np-app').textContent = media.active ? media.app || '' : '';
    const art = $('np-art');
    if (media.art) { if (art.getAttribute('src') !== media.art) art.src = media.art; } else art.removeAttribute('src');
    $('np-play').innerHTML = media.active && media.status === 'Playing' ? PAUSE : PLAY;
    tickBar();
  }
  function tickBar() {
    let pos = media.position || 0;
    if (media.status === 'Playing' && media.updated) pos += (Date.now() + offset - media.updated) / 1000;
    $('np-fill').style.width = media.active && media.duration ? Math.min(100, (pos / media.duration) * 100) + '%' : '0';
  }
  setInterval(tickBar, 1000);
  document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'cmd', a: b.dataset.cmd }))));
  const vol = $('np-vol');
  vol.addEventListener('input', () => { volDragging = true; $('np-vol-n').textContent = vol.value; ws.send(JSON.stringify({ t: 'volume', v: vol.value / 100 })); });
  vol.addEventListener('change', () => { setTimeout(() => { volDragging = false; }, 500); });

  /* ---------------------------------------------------------------- shortcuts editor */
  let draft = [];
  function markDirty(d = true) { $('sc-save').disabled = !d; }

  function renderShortcuts() {
    const list = $('sc-list');
    list.innerHTML = '';
    if (!draft.length) list.innerHTML = '<div class="muted">No buttons yet. Click <b>Add button</b>.</div>';
    draft.forEach((sc, i) => {
      const row = document.createElement('div');
      row.className = 'sc-row';
      row.draggable = true;
      row.dataset.i = i;
      row.innerHTML = `
        <span class="grip" title="Drag to reorder">⋮⋮</span>
        <input type="text" class="lbl" maxlength="40" placeholder="Label">
        <select class="type"><option value="keys">Press keys</option><option value="url">Open link</option><option value="app">Start app</option></select>
        <input type="text" class="val" maxlength="500">
        <select class="icon">${ICONS.map((ic) => `<option>${ic}</option>`).join('')}</select>
        <input type="color" class="color">
        <button class="x" title="Delete">✕</button>`;
      const q = (s) => row.querySelector(s);
      q('.lbl').value = sc.label;
      q('.type').value = sc.type;
      q('.val').value = sc.value;
      q('.val').placeholder = sc.type === 'keys' ? 'ctrl+shift+m' : sc.type === 'url' ? 'https://… or spotify:' : 'C:\\Path\\to\\app.exe';
      q('.icon').value = ICONS.includes(sc.icon) ? sc.icon : 'bolt';
      q('.color').value = sc.color;
      q('.lbl').oninput = (e) => { sc.label = e.target.value; markDirty(); };
      q('.val').oninput = (e) => { sc.value = e.target.value; markDirty(); };
      q('.type').onchange = (e) => { sc.type = e.target.value; markDirty(); renderShortcuts(); };
      q('.icon').onchange = (e) => { sc.icon = e.target.value; markDirty(); };
      q('.color').oninput = (e) => { sc.color = e.target.value; markDirty(); };
      q('.x').onclick = () => { draft.splice(i, 1); markDirty(); renderShortcuts(); };
      row.addEventListener('dragstart', (e) => { row.classList.add('dragging'); e.dataTransfer.setData('text/plain', String(i)); });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('over'); });
      row.addEventListener('dragleave', () => row.classList.remove('over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault(); row.classList.remove('over');
        const from = +e.dataTransfer.getData('text/plain');
        if (from === i) return;
        const [it] = draft.splice(from, 1);
        draft.splice(i, 0, it);
        markDirty(); renderShortcuts();
      });
      // Typing in inputs shouldn't start a row drag.
      row.querySelectorAll('input, select').forEach((inp) => {
        inp.addEventListener('focus', () => { row.draggable = false; });
        inp.addEventListener('blur', () => { row.draggable = true; });
      });
      list.appendChild(row);
    });
  }
  $('sc-add').addEventListener('click', () => {
    if (draft.length >= 24) return toast('24 buttons max');
    draft.push({ id: Math.random().toString(36).slice(2, 10), label: 'New button', type: 'keys', value: '', icon: 'bolt', color: '#3b6cf6' });
    markDirty(); renderShortcuts();
    const rows = $('sc-list').querySelectorAll('.lbl');
    rows[rows.length - 1].focus();
    rows[rows.length - 1].select();
  });
  $('sc-save').addEventListener('click', async () => {
    try {
      config = await api('config', { shortcuts: draft });
      draft = JSON.parse(JSON.stringify(config.shortcuts));
      renderShortcuts(); markDirty(false); toast('Saved. Phones updated.');
    } catch (e) { toast('Save failed: ' + e.message); }
  });
  window.addEventListener('beforeunload', (e) => { if (!$('sc-save').disabled) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------------------------------------------------------------- settings */
  async function save(patch, msg) {
    try { config = await api('config', patch); renderSettings(); toast(msg || 'Saved'); }
    catch (e) { toast('Save failed: ' + e.message); }
  }
  function seg(id, value) { document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === value)); }
  function renderSettings() {
    seg('set-theme', config.theme);
    seg('set-clock', config.clock24 ? '24' : '12');
    seg('set-accent-mode', config.accent === 'auto' ? 'auto' : 'fixed');
    $('set-accent').disabled = config.accent === 'auto';
    if (config.accent !== 'auto') $('set-accent').value = config.accent;
    const dim = $('set-dim');
    if (![...dim.options].some((o) => +o.value === config.dimAfter)) dim.add(new Option(config.dimAfter + ' seconds', config.dimAfter));
    dim.value = String(config.dimAfter);
    $('set-usb').checked = config.autoUsb;
    $('set-port').value = config.port;
    const order = config.screens.concat(ALL_SCREENS.filter((s) => !config.screens.includes(s)));
    $('set-screens').innerHTML = order.map((s) => {
      const on = config.screens.includes(s), idx = config.screens.indexOf(s);
      return `<li class="${on ? '' : 'off'}" data-s="${s}">
        <input type="checkbox" ${on ? 'checked' : ''} ${on && config.screens.length === 1 ? 'disabled' : ''} aria-label="Show ${SCREEN_NAMES[s]}">
        <span>${SCREEN_NAMES[s]}</span>
        <button data-mv="-1" ${!on || idx === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button data-mv="1" ${!on || idx === config.screens.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></li>`;
    }).join('');
  }
  $('set-theme').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) save({ theme: b.dataset.v }); });
  $('set-clock').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) save({ clock24: b.dataset.v === '24' }); });
  $('set-accent-mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) save({ accent: b.dataset.v === 'auto' ? 'auto' : $('set-accent').value }); });
  $('set-accent').addEventListener('change', (e) => save({ accent: e.target.value }));
  $('set-dim').addEventListener('change', (e) => save({ dimAfter: +e.target.value }));
  $('set-usb').addEventListener('change', (e) => save({ autoUsb: e.target.checked }));
  $('set-port').addEventListener('change', (e) => save({ port: +e.target.value }, 'Saved. Restart PhoneDesk to use the new port.'));
  $('set-screens').addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    const s = li.dataset.s, list = config.screens.slice();
    if (e.target.matches('input')) {
      if (e.target.checked) list.push(s); else list.splice(list.indexOf(s), 1);
      return save({ screens: list });
    }
    const mv = e.target.closest('[data-mv]');
    if (mv) {
      const i = list.indexOf(s), j = i + +mv.dataset.mv;
      [list[i], list[j]] = [list[j], list[i]];
      save({ screens: list });
    }
  });
  $('bridge-restart').addEventListener('click', async () => { await api('bridge/restart', {}); toast('Restarting media bridge'); setTimeout(refresh, 2500); });

  /* ---------------------------------------------------------------- logs */
  async function loadLogs() {
    const lines = await api('logs').catch(() => []);
    const pre = $('logs');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.innerHTML = lines.map((l) => `<span class="${l.level}">${new Date(l.ts).toLocaleTimeString()}  ${esc(l.msg)}</span>`).join('\n') || 'No logs yet.';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }
  $('logs-refresh').addEventListener('click', loadLogs);

  /* ---------------------------------------------------------------- boot */
  (async function boot() {
    try {
      config = await api('config');
      draft = JSON.parse(JSON.stringify(config.shortcuts));
      renderShortcuts(); renderSettings();
    } catch (e) { toast('Could not load settings'); }
    connectWs();
    refresh();
    setInterval(() => {
      if (document.hidden) return;
      refresh();
      if ($('t-logs').classList.contains('on')) loadLogs();
    }, 3000);
  })();
})();
