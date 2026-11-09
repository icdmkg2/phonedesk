'use strict';
// Addon system tests: manifests, packages, the install flow with a fake GitHub, permissions, and the
// isolated runtime (a real child process with Node's permission model).   node test/addons.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PHONEDESK_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-addons-'));
const addons = require('../server/addons');
const { zip } = require('../server/zip');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(40); } throw new Error('timed out'); }

let broadcasts = [], changes = 0, keys = [], volume = null;
addons.init({
  version: '1.9.0',
  broadcast: (m) => broadcasts.push(m),
  media: () => ({ active: true, title: 'Song' }),
  volume: () => ({ level: 0.5, muted: false }),
  stats: () => ({ cpu: 7 }),
  sendKeys: (k) => keys.push(k),
  mediaCommand: () => {},
  setVolume: (v) => { volume = v; },
  changed: () => { changes++; },
  getConfig: () => ({}),
});

const manifest = (o) => Object.assign({ id: 'demo', name: 'Demo', version: '1.0.0', description: 'A demo.', author: 'Tester', permissions: [], screen: { title: 'Demo', entry: 'screen/index.html' } }, o);
const pkg = (m, extra) => zip([{ name: 'addon.json', data: JSON.stringify(m) }, { name: 'screen/index.html', data: '<p>hi</p>' }].concat(extra || []));

let files = {}; // url -> Buffer
global.fetch = async (url) => {
  url = String(url);
  if (url === 'https://raw.githubusercontent.com/icdmkg2/phonedesk/main/registry/index.json') return { ok: true, status: 200, json: async () => files.registry };
  const b = files[url];
  if (!b) return { ok: false, status: 404 };
  return { ok: true, status: 200, url, headers: { get: () => String(b.length) }, arrayBuffer: async () => b };
};

async function run(name, fn) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); process.exitCode = 1; }
}
const throwsMsg = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('did not throw'); };
const rejectsMsg = async (p, re) => { try { await p; } catch (e) { assert.match(e.message, re); return; } assert.fail('did not reject'); };

(async () => {
  /* ---------------------------------------------------------------- manifest */
  await run('a good manifest is accepted and cleaned', () => {
    const m = addons.validateManifest(manifest({ permissions: ['media', 'network:api.example.com'], settings: [{ key: 'url', label: 'URL', type: 'text' }], extra: 'ignored' }));
    assert.strictEqual(m.id, 'demo');
    assert.deepStrictEqual(m.permissions, ['media', 'network:api.example.com']);
    assert.strictEqual(m.extra, undefined);
    assert.strictEqual(m.screen.icon, 'bolt');
  });
  await run('bad manifests say what is wrong', () => {
    throwsMsg(() => addons.validateManifest(manifest({ id: 'Bad Id' })), /"id"/);
    throwsMsg(() => addons.validateManifest(manifest({ version: '1' })), /"version"/);
    throwsMsg(() => addons.validateManifest(manifest({ permissions: ['root'] })), /unknown permission: root/);
    throwsMsg(() => addons.validateManifest(manifest({ permissions: ['network:not a host'] })), /unknown permission/);
    throwsMsg(() => addons.validateManifest(manifest({ screen: { entry: '../x.html' } })), /valid file path/);
    throwsMsg(() => addons.validateManifest(manifest({ screen: undefined })), /needs a "screen", a "server"/);
    throwsMsg(() => addons.validateManifest(manifest({ actions: [{ id: 'a' }] })), /need a "server"/);
    throwsMsg(() => addons.validateManifest(manifest({ screen: { entry: 'screen/missing.html' } }), [{ name: 'addon.json' }]), /not in the package/);
  });
  await run('network permissions match hosts', () => {
    const p = ['network:api.example.com', 'network:*.home.test'];
    assert.ok(addons.hostAllowed(p, 'api.example.com'));
    assert.ok(addons.hostAllowed(p, 'x.home.test'));
    assert.ok(!addons.hostAllowed(p, 'home.test'));
    assert.ok(!addons.hostAllowed(p, 'evilapi.example.com'));
    assert.ok(!addons.hostAllowed(['media'], 'api.example.com'));
    const lan = ['network:lan'];
    ['192.168.1.20', '10.0.0.5', '172.16.0.1', '172.31.255.1', 'homeassistant.local', 'localhost'].forEach((h) => assert.ok(addons.hostAllowed(lan, h), h));
    ['8.8.8.8', '172.32.0.1', '192.169.1.1', 'example.com', 'local.example.com'].forEach((h) => assert.ok(!addons.hostAllowed(lan, h), h));
    assert.ok(addons.permissionInfo('network:lan'));
  });
  await run('version compare', () => {
    assert.strictEqual(addons.cmpVer('1.10.0', '1.9.0'), 1);
    assert.strictEqual(addons.cmpVer('1.0.0', '1.0.0'), 0);
  });

  /* ---------------------------------------------------------------- registry entries */
  const entry = (o) => Object.assign({ id: 'demo', name: 'Demo', version: '1.0.0', author: 'Tester', description: 'A demo.', download: 'https://github.com/x/y/releases/download/v1/demo.zip', sha256: 'a'.repeat(64), permissions: [] }, o);
  await run('registry entries only point to GitHub, over https, at a zip', () => {
    addons.validateRegistryEntry(entry());
    throwsMsg(() => addons.validateRegistryEntry(entry({ download: 'https://evil.example/demo.zip' })), /GitHub/);
    throwsMsg(() => addons.validateRegistryEntry(entry({ download: 'http://github.com/x/demo.zip' })), /GitHub/);
    throwsMsg(() => addons.validateRegistryEntry(entry({ download: 'https://github.com/x/demo.exe' })), /\.zip/);
    throwsMsg(() => addons.validateRegistryEntry(entry({ sha256: 'zz' })), /sha256/);
  });

  /* ---------------------------------------------------------------- packages and install */
  const url = 'https://github.com/x/y/releases/download/v1/demo.zip';
  await run('a link install shows the permissions and a warning, and installs only when all are approved', async () => {
    files[url] = pkg(manifest({ permissions: ['media', 'keys'] }));
    const p = await addons.prepare({ url });
    assert.strictEqual(p.manifest.id, 'demo');
    assert.deepStrictEqual(p.permissions.map((x) => x.id), ['media', 'keys']);
    assert.ok(p.warnings.length);
    assert.throws(() => addons.confirm(p.token, ['media']), /approve all/);
    const d = addons.confirm(p.token, ['keys', 'media']);
    assert.strictEqual(d.id, 'demo');
    assert.ok(fs.existsSync(path.join(process.env.PHONEDESK_DATA, 'addons', 'installed', 'demo', 'screen', 'index.html')));
    assert.deepStrictEqual(addons.phoneScreens().map((s) => s.id), ['demo']);
    assert.deepStrictEqual(addons.screenIds(), ['addon:demo']);
  });
  await run('links outside GitHub are refused', async () => {
    await rejectsMsg(addons.prepare({ url: 'https://evil.example/a.zip' }), /GitHub/);
    await rejectsMsg(addons.prepare({ url: 'http://github.com/a.zip' }), /GitHub/);
  });
  await run('a package with an unsafe file name is refused', async () => {
    files[url] = zip([{ name: 'addon.json', data: JSON.stringify(manifest()) }, { name: '../evil.txt', data: 'x' }]);
    await rejectsMsg(addons.prepare({ url }), /unsafe file name/);
  });
  await run('a package without addon.json, or with a screen file that is missing, is refused', async () => {
    files[url] = zip([{ name: 'readme.txt', data: 'x' }]);
    await rejectsMsg(addons.prepare({ url }), /addon\.json is missing/);
    files[url] = zip([{ name: 'addon.json', data: JSON.stringify(manifest()) }]);
    await rejectsMsg(addons.prepare({ url }), /not in the package/);
  });
  await run('a package zipped inside one folder is accepted', async () => {
    files[url] = zip([{ name: 'demo/addon.json', data: JSON.stringify(manifest({ version: '1.0.1' })) }, { name: 'demo/screen/index.html', data: '<p>x</p>' }]);
    const p = await addons.prepare({ url });
    assert.strictEqual(p.upgradeFrom, '1.0.0');
  });
  await run('an older version does not replace a newer one', async () => {
    files[url] = pkg(manifest({ version: '0.9.0' }));
    await rejectsMsg(addons.prepare({ url }), /already installed/);
  });
  await run('an addon that needs a newer PhoneDesk is refused', async () => {
    files[url] = pkg(manifest({ id: 'future', phonedesk: '9.0.0' }));
    await rejectsMsg(addons.prepare({ url }), /needs PhoneDesk 9\.0\.0/);
  });
  await run('registry installs check the checksum and the listed permissions', async () => {
    const good = pkg(manifest({ id: 'reg', permissions: ['media'] }));
    const e = entry({ id: 'reg', permissions: ['media'], sha256: sha(good), download: 'https://github.com/x/y/releases/download/v1/reg.zip' });
    files['https://github.com/x/y/releases/download/v1/reg.zip'] = good;
    files.registry = { addons: [e] };
    const p = await addons.prepare({ registryId: 'reg' });
    assert.strictEqual(p.source, 'registry');
    // wrong checksum
    files.registry = { addons: [Object.assign({}, e, { sha256: 'b'.repeat(64) })] };
    await addons.loadRegistry(true);
    await rejectsMsg(addons.prepare({ registryId: 'reg' }), /checksum/);
    // the package asks for more than the listing says
    files.registry = { addons: [Object.assign({}, e, { permissions: [] })] };
    await addons.loadRegistry(true);
    await rejectsMsg(addons.prepare({ registryId: 'reg' }), /did not list/);
    // not in the registry
    await rejectsMsg(addons.prepare({ registryId: 'nope' }), /not in the registry/);
  });
  await run('screen files are served only from inside an enabled addon', () => {
    assert.ok(addons.screenFile('demo', 'screen/index.html'));
    assert.strictEqual(addons.screenFile('demo', '../addons.json'), null);
    assert.strictEqual(addons.screenFile('demo', decodeURIComponent('..%2faddons.json')), null);
    assert.strictEqual(addons.screenFile('demo', 'screen\\..\\x'), null);
    assert.strictEqual(addons.screenFile('nope', 'screen/index.html'), null);
    addons.setEnabled('demo', false);
    assert.strictEqual(addons.screenFile('demo', 'screen/index.html'), null);
    assert.deepStrictEqual(addons.phoneScreens(), []);
    addons.setEnabled('demo', true);
  });
  await run('permissions are checked on every call', async () => {
    await assert.rejects(addons.rpc('demo', ['media'], 'stats.get', []), /"stats" permission/);
    assert.deepStrictEqual(await addons.rpc('demo', ['stats'], 'stats.get', []), { cpu: 7 });
    await assert.rejects(addons.rpc('demo', [], 'run.exec', ['node']), /"run" permission/);
    await assert.rejects(addons.rpc('demo', ['keys'], 'keys.send', ['ctrl+;rm']), /bad key/);
    await addons.rpc('demo', ['keys'], 'keys.send', ['ctrl+shift+m']);
    assert.deepStrictEqual(keys, ['ctrl+shift+m']);
    await assert.rejects(addons.rpc('demo', ['network:api.example.com'], 'http.request', [{ url: 'https://other.example.com/' }]), /network:other\.example\.com/);
    await assert.rejects(addons.rpc('demo', ['network:api.example.com'], 'http.request', [{ url: 'file:///etc/passwd' }]), /only http/);
  });
  await run('remove deletes the addon and its folder', () => {
    addons.remove('demo');
    assert.strictEqual(addons.describe('demo'), null);
    assert.ok(!fs.existsSync(path.join(process.env.PHONEDESK_DATA, 'addons', 'installed', 'demo')));
  });

  /* ---------------------------------------------------------------- the runtime */
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-dev-'));
  fs.mkdirSync(path.join(dev, 'screen'));
  fs.writeFileSync(path.join(dev, 'screen', 'index.html'), '<p>x</p>');
  fs.writeFileSync(path.join(dev, 'addon.json'), JSON.stringify(manifest({ id: 'rt', permissions: ['stats', 'keys'], server: 'server.js', actions: [{ id: 'go', label: 'Go' }], settings: [{ key: 'greeting', label: 'Greeting', type: 'text', default: 'hi' }, { key: 'token', label: 'Token', type: 'password' }] })));
  fs.writeFileSync(path.join(dev, 'server.js'), `
    const fs = require('fs'), path = require('path');
    module.exports = (pd) => {
      pd.screen.on((m) => pd.screen.send({ echo: m, greeting: pd.settings.get('greeting') }));
      pd.action('go', () => pd.keys.send('win+d'));
      pd.on('stats', (s) => pd.screen.send({ stats: s }));
      pd.storage.set('n', (pd.storage.get('n', 0)) + 1);
      const probe = (name, fn) => { try { fn(); pd.screen.send({ probe: name, result: 'ALLOWED' }); } catch (e) { pd.screen.send({ probe: name, result: 'blocked', why: String(e.message).slice(0, 80) }); } };
      pd.screen.on((m) => {
        if (m !== 'probe') return;
        probe('child_process', () => require('child_process').execSync('echo hi'));
        probe('net', () => require('net'));
        probe('fetch', () => { if (typeof fetch === 'function') throw new Error('fetch exists'); });
        probe('read-outside', () => fs.readFileSync(process.execPath.replace(/[^\\\\/]*$/, '') + 'README'));
        probe('write-outside', () => fs.writeFileSync(path.join(__dirname, '..', 'evil.txt'), 'x'));
        probe('write-own-folder', () => { throw new Error('skipped'); });
        pd.http.get('https://other.example.com/').then(() => pd.screen.send({ probe: 'http', result: 'ALLOWED' }), (e) => pd.screen.send({ probe: 'http', result: 'blocked', why: e.message }));
      });
    };
  `);
  await run('a local addon starts in its own process and talks to the phone and back', async () => {
    const d = addons.installLocal(dev);
    assert.strictEqual(d.source, 'dev');
    await until(() => addons.describe('rt').running);
    broadcasts = [];
    addons.fromPhone('rt', 'ping');
    const b = await until(() => broadcasts.find((m) => m.t === 'addon' && m.d && m.d.echo === 'ping'));
    assert.strictEqual(b.id, 'rt');
    assert.strictEqual(b.d.greeting, 'hi'); // the default setting
  });
  await run('events and actions reach the addon, and its calls are checked', async () => {
    broadcasts = []; keys = [];
    addons.emit('stats', { cpu: 42 });
    await until(() => broadcasts.find((m) => m.d && m.d.stats && m.d.stats.cpu === 42));
    addons.runAction('rt:go');
    await until(() => keys.includes('win+d'));
    assert.deepStrictEqual(addons.actionList().map((a) => a.value), ['rt:go']);
    assert.throws(() => addons.runAction('rt:nope'), /not available/);
  });
  await run('settings are saved, passwords are hidden, and the addon is told', async () => {
    broadcasts = [];
    const d = addons.setSettings('rt', { greeting: 'hello', token: 'secret' });
    assert.strictEqual(d.settings.find((s) => s.key === 'greeting').value, 'hello');
    const t = d.settings.find((s) => s.key === 'token');
    assert.strictEqual(t.value, ''); assert.strictEqual(t.isSet, true);
    assert.ok(!JSON.stringify(d).includes('secret'));
    addons.setSettings('rt', { greeting: 'hello', token: '' }); // empty keeps the old password
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(process.env.PHONEDESK_DATA, 'addons', 'data', 'rt', 'settings.json'), 'utf8')).token, 'secret');
    addons.fromPhone('rt', 'x');
    const b = await until(() => broadcasts.find((m) => m.d && m.d.echo === 'x'));
    assert.strictEqual(b.d.greeting, 'hello');
  });
  await run('the addon cannot start programs, leave its folders or open connections', async () => {
    broadcasts = [];
    addons.fromPhone('rt', 'probe');
    await until(() => broadcasts.filter((m) => m.d && m.d.probe).length >= 6);
    const got = {};
    broadcasts.filter((m) => m.d && m.d.probe).forEach((m) => { got[m.d.probe] = m.d; });
    assert.strictEqual(got.child_process.result, 'blocked', JSON.stringify(got.child_process));
    assert.strictEqual(got.net.result, 'blocked', JSON.stringify(got.net));
    assert.strictEqual(got.fetch.result, 'ALLOWED'); // that probe throws if fetch exists, so ALLOWED means it was removed
    assert.strictEqual(got['read-outside'].result, 'blocked', JSON.stringify(got['read-outside']));
    assert.strictEqual(got['write-outside'].result, 'blocked', JSON.stringify(got['write-outside']));
    const http = await until(() => broadcasts.find((m) => m.d && m.d.probe === 'http'));
    assert.strictEqual(http.d.result, 'blocked');
    assert.ok(!fs.existsSync(path.join(process.env.PHONEDESK_DATA, 'addons', 'installed', 'evil.txt')));
  });
  await run('the addon keeps its own storage between runs', async () => {
    addons.setEnabled('rt', false);
    await sleep(1300);
    assert.strictEqual(addons.describe('rt').running, false);
    const store = JSON.parse(fs.readFileSync(path.join(process.env.PHONEDESK_DATA, 'addons', 'data', 'rt', 'storage.json'), 'utf8'));
    assert.strictEqual(store.n, 1);
    addons.setEnabled('rt', true);
    await until(() => addons.describe('rt').running);
    await sleep(600);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(process.env.PHONEDESK_DATA, 'addons', 'data', 'rt', 'storage.json'), 'utf8')).n, 2);
  });

  addons.stopAll();
  await sleep(1300);
  fs.rmSync(process.env.PHONEDESK_DATA, { recursive: true, force: true });
  fs.rmSync(dev, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})();
