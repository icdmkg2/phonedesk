'use strict';
// Auto-update from GitHub Releases. Looks at <repo>'s latest release for a PhoneDesk-Setup-*.exe,
// downloads it, checks its SHA-256 (GitHub's asset digest, or a .sha256 file next to it), then on
// "install" runs it silently; the setup closes PhoneDesk, updates it and starts it again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DATA } = require('./paths');
const log = require('./log');

const DIR = path.join(DATA, 'updates');
const installed = !!process.env.PHONEDESK_EXE; // running from source can't update itself
let status = { state: installed ? 'idle' : 'source', current: null };
let timer = null;
let onChange = () => {};

function set(patch) { status = Object.assign({}, status, patch); onChange(status); return status; }

function newer(a, b) { // is version a newer than b?
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function get(url, json) {
  const res = await fetch(url, { headers: { 'User-Agent': 'PhoneDesk-updater', Accept: json ? 'application/vnd.github+json' : '*/*' } });
  if (!res.ok) throw new Error(`${url.split('?')[0]}: HTTP ${res.status}`);
  return json ? res.json() : Buffer.from(await res.arrayBuffer());
}

async function check(cfg, current) {
  status.current = current;
  if (!installed) return set({ state: 'source' });
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.updateRepo || '')) return set({ state: 'off' });
  if (status.state === 'downloading' || status.state === 'installing') return status;
  set({ state: 'checking', error: '' });
  try {
    const rel = await get(`https://api.github.com/repos/${cfg.updateRepo}/releases/latest`, true);
    const version = String(rel.tag_name || '').replace(/^v/i, '');
    if (!version || !newer(version, current)) return set({ state: 'latest', checkedAt: Date.now(), version: current });
    const asset = (rel.assets || []).find((a) => /^PhoneDesk-Setup-.*\.exe$/i.test(a.name));
    if (!asset) throw new Error(`release ${version} has no PhoneDesk-Setup .exe`);
    let sha = (asset.digest || '').replace(/^sha256:/i, '');
    if (!sha) {
      const shaAsset = (rel.assets || []).find((a) => a.name === asset.name + '.sha256');
      if (shaAsset) sha = (await get(shaAsset.browser_download_url)).toString('utf8').trim().split(/\s+/)[0];
    }
    if (!/^[a-f0-9]{64}$/i.test(sha)) throw new Error('the release has no SHA-256 checksum, so it was not downloaded');
    const file = path.join(DIR, asset.name);
    if (!(fs.existsSync(file) && hash(fs.readFileSync(file)) === sha.toLowerCase())) {
      set({ state: 'downloading', version, url: rel.html_url || '', notes: String(rel.body || '').slice(0, 2000) });
      const buf = await get(asset.browser_download_url);
      if (hash(buf) !== sha.toLowerCase()) throw new Error('the download did not match its checksum');
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(file, buf);
    }
    set({ state: 'ready', version, file, url: rel.html_url || '', notes: String(rel.body || '').slice(0, 2000), checkedAt: Date.now() });
    log.event('info', `PhoneDesk ${version} is ready to install`);
  } catch (e) {
    set({ state: 'error', error: e.message, checkedAt: Date.now() });
    log.warn('update check: ' + e.message);
  }
  return status;
}

function hash(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

module.exports = {
  status: () => status,
  check,
  start(getConfig, current, cb) {
    onChange = cb;
    status.current = current;
    clearInterval(timer);
    setTimeout(() => { if (getConfig().autoUpdate) check(getConfig(), current); }, 60 * 1000).unref();
    timer = setInterval(() => { if (getConfig().autoUpdate) check(getConfig(), current); }, 6 * 3600 * 1000);
    timer.unref();
  },
  install() {
    if (status.state !== 'ready' || !status.file || !fs.existsSync(status.file)) throw new Error('No update is ready');
    set({ state: 'installing' });
    log.event('info', `Installing PhoneDesk ${status.version}`);
    // Detached and outside our job, so it survives PhoneDesk closing during the update.
    const child = spawn(status.file, ['/silent', '/launch'], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => { log.warn('update install: ' + e.message); set({ state: 'error', error: 'Couldn\'t start the installer: ' + e.message }); });
    child.unref();
    // If PhoneDesk is still here a couple of minutes later, the installer did not run: don't stay on "Installing".
    setTimeout(() => {
      if (status.state === 'installing') set({ state: 'error', error: 'The installer did not restart PhoneDesk. Try again, or download the setup from the release page.' });
    }, 3 * 60 * 1000).unref();
  },
};
