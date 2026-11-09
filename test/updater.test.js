'use strict';
// Tests for server/updater.js with a fake GitHub (no network, nothing installed):
//   node test/updater.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PHONEDESK_EXE = 'x';                                        // pretend to be the installed app
process.env.PHONEDESK_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-upd-'));
const updater = require('../server/updater');

const SETUP = Buffer.from('pretend this is PhoneDesk-Setup.exe');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const cfg = { updateRepo: 'icdmkg2/phonedesk' };

let release = null, downloads = [];
global.fetch = async (url) => {
  url = String(url);
  if (url.includes('/releases/latest')) {
    if (release === 403) return { ok: false, status: 403 };
    return { ok: true, status: 200, json: async () => release };
  }
  downloads.push(url);
  if (url.endsWith('.sha256')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(sha(SETUP) + '  PhoneDesk-Setup-9.9.9.exe\n') };
  return { ok: true, status: 200, arrayBuffer: async () => SETUP };
};
const rel = (version, assets) => ({ tag_name: 'v' + version, html_url: 'https://example.test/r', body: 'notes', assets });
const exe = (extra) => Object.assign({ name: 'PhoneDesk-Setup-9.9.9.exe', browser_download_url: 'https://example.test/setup.exe' }, extra);

async function run(name, fn) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

(async () => {
  await run('check always returns a status (never undefined)', async () => {
    release = rel('1.0.0', []);
    const r = await updater.check(cfg, '1.8.1');
    assert.strictEqual(r && r.state, 'latest');
    assert.strictEqual(r.version, '1.8.1');
  });

  await run('a repository that is off returns "off"', async () => {
    const r = await updater.check({ updateRepo: '' }, '1.8.1');
    assert.strictEqual(r && r.state, 'off');
  });

  await run('GitHub errors become an error status with the reason', async () => {
    release = 403;
    const r = await updater.check(cfg, '1.8.1');
    assert.strictEqual(r.state, 'error');
    assert.match(r.error, /HTTP 403/);
  });

  await run('a newer release with no setup file is an error', async () => {
    release = rel('9.9.9', [{ name: 'notes.txt', browser_download_url: 'https://example.test/n' }]);
    const r = await updater.check(cfg, '1.8.1');
    assert.strictEqual(r.state, 'error');
    assert.match(r.error, /no PhoneDesk-Setup/);
  });

  await run('a release without a checksum is not downloaded', async () => {
    release = rel('9.9.9', [exe()]);
    downloads = [];
    const r = await updater.check(cfg, '1.8.1');
    assert.strictEqual(r.state, 'error');
    assert.match(r.error, /SHA-256/);
    assert.deepStrictEqual(downloads, []);
  });

  await run('a download that does not match its checksum is rejected', async () => {
    release = rel('9.9.9', [exe({ digest: 'sha256:' + 'a'.repeat(64) })]);
    const r = await updater.check(cfg, '1.8.1');
    assert.strictEqual(r.state, 'error');
    assert.match(r.error, /did not match/);
  });

  await run('a newer release with GitHub\'s digest downloads and is ready', async () => {
    release = rel('9.9.9', [exe({ digest: 'sha256:' + sha(SETUP) })]);
    const r = await updater.check(cfg, '1.8.1');
    assert.strictEqual(r.state, 'ready');
    assert.strictEqual(r.version, '9.9.9');
    assert.ok(fs.existsSync(r.file) && sha(fs.readFileSync(r.file)) === sha(SETUP));
  });

  await run('checking again uses the file already downloaded', async () => {
    downloads = [];
    const r = await updater.check(cfg, '1.8.1');
    assert.strictEqual(r.state, 'ready');
    assert.deepStrictEqual(downloads, []);
  });

  await run('the checksum can come from a .sha256 file next to the setup', async () => {
    fs.rmSync(path.join(process.env.PHONEDESK_DATA, 'updates'), { recursive: true, force: true });
    release = rel('9.9.9', [exe(), { name: 'PhoneDesk-Setup-9.9.9.exe.sha256', browser_download_url: 'https://example.test/setup.exe.sha256' }]);
    const r = await updater.check(cfg, '1.8.1');
    assert.strictEqual(r.state, 'ready');
  });

  await run('the same or an older version is "latest"', async () => {
    release = rel('1.8.1', [exe({ digest: 'sha256:' + sha(SETUP) })]);
    assert.strictEqual((await updater.check(cfg, '1.8.1')).state, 'latest');
    release = rel('1.7.3', []);
    assert.strictEqual((await updater.check(cfg, '1.8.1')).state, 'latest');
  });

  await run('1.10.0 counts as newer than 1.9.0', async () => {
    release = rel('1.10.0', [exe({ digest: 'sha256:' + sha(SETUP) })]);
    assert.strictEqual((await updater.check(cfg, '1.9.0')).state, 'ready');
  });

  await run('install refuses when nothing is ready', async () => {
    release = rel('1.0.0', []);
    await updater.check(cfg, '1.8.1');
    assert.throws(() => updater.install(), /No update is ready/);
  });

  fs.rmSync(process.env.PHONEDESK_DATA, { recursive: true, force: true });
})();
