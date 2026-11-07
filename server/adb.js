'use strict';
// USB mode: `adb reverse` maps the phone's localhost:PORT to the PC, so the phone talks to the PC
// over the cable. Lower latency than Wi-Fi, works with no network, and localhost is a "secure
// context" so the phone's screen wake-lock works too.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const log = require('./log');

const { TOOLS } = require('./paths');
const CANDIDATES = [
  path.join(TOOLS, 'platform-tools', 'adb.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
  'C:\\platform-tools\\adb.exe',
].filter(Boolean);

let adbPath = null;
let timer = null;
let busy = false;
let installing = false;
let lastError = '';
let hasPhone = () => false;      // set by the server: is PhoneDesk already open on this phone? (wifiIp or USB)
let phoneUrl = () => 'http://phonedesk.local/phone';
let onBattery = () => {};       // set by the server: battery read from a USB phone
const devices = new Map(); // serial -> { serial, state, model, reversed, opened }

function run(args, timeout = 8000) {
  return new Promise((resolve) => {
    if (!adbPath) return resolve({ ok: false, out: '', err: 'adb not found' });
    execFile(adbPath, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}

function findAdb() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  // Fall back to PATH.
  return new Promise((resolve) => {
    execFile('where', ['adb'], { windowsHide: true, timeout: 3000 }, (err, out) => {
      const first = !err && String(out).split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith('adb.exe'));
      resolve(first ? first.trim() : null);
    });
  });
}

async function locate() {
  if (adbPath && fs.existsSync(adbPath)) return adbPath;
  adbPath = await findAdb();
  return adbPath;
}

function friendly(model) {
  if (/^SM[- ]A115/i.test(model)) return 'Samsung Galaxy A11';
  return model.replace(/^SM[- ]/i, 'Samsung SM-');
}

async function scan(port, forceOpen) {
  if (busy) return;
  busy = true;
  try {
    if (!(await locate())) { devices.clear(); return; }
    for (const ip of knownWifi) tryWifi(ip); // not awaited: runs alongside, rate-limited
    const r = await run(['devices', '-l']);
    if (!r.ok) { lastError = r.err.trim(); return; }
    lastError = '';
    const seen = new Set();
    for (const line of r.out.split(/\r?\n/).slice(1)) {
      const m = line.trim().match(/^(\S+)\s+(device|unauthorized|offline|no permissions)\b(.*)$/);
      if (!m) continue;
      const [, serial, st, rest] = m;
      // Wireless debugging lists one phone twice (ip:port and an mDNS name). Keep the ip:port one.
      if (/_adb-tls-connect/.test(serial) && /^\s*\d+\.\d+\.\d+\.\d+:\d+\s+device/m.test(r.out)) continue;
      seen.add(serial);
      const model = friendly(((rest.match(/model:(\S+)/) || [])[1] || serial).replace(/_/g, ' '));
      // A serial like 10.0.0.5:5555 is a phone linked over Wi-Fi (network ADB), not a cable.
      const wifiIp = (serial.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/) || [])[1] || null;
      let d = devices.get(serial);
      if (!d) {
        d = { serial, state: st, model, reversed: false, opened: false, lastPoll: 0, wifiIp };
        devices.set(serial, d);
        log.event('phone', wifiIp ? `${model} linked over Wi-Fi` : `${model} plugged in by USB`);
        if (st === 'unauthorized') log.event('problem', `Accept the "Allow debugging" prompt on ${model}`);
      }
      d.state = st;
      d.model = model;
      if (st !== 'device') { d.reversed = false; continue; }

      if (wifiIp) {
        // Over Wi-Fi the phone reaches the PC by name; no port mapping needed.
        d.reversed = true;
      } else {
        // Re-check the reverse mapping each scan: it vanishes when the phone reboots or adb restarts.
        const list = await run(['-s', serial, 'reverse', '--list']);
        const has = list.ok && list.out.includes(`tcp:${port}`);
        if (!has) {
          const rr = await run(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
          d.reversed = rr.ok;
          if (rr.ok) log.info(`USB link ready on ${model}`);
          else log.warn(`adb reverse failed on ${model}: ${rr.err.trim()}`);
        } else {
          d.reversed = true;
        }
      }
      if (d.reversed && !d.opened && !forceOpen && hasPhone(wifiIp)) d.opened = true; // already showing PhoneDesk
      if (d.reversed && (!d.opened || forceOpen)) {
        d.opened = true;
        // Open PhoneDesk on the phone (also after the phone restarts). The browser reuses the tab.
        // The PhoneDesk phone app does its own thing: just bring it up. Otherwise open the page in the browser.
        const pk = await run(['-s', serial, 'shell', 'pm', 'list', 'packages', 'com.phonedesk.display']);
        if (pk.ok && pk.out.includes('com.phonedesk.display')) {
          await run(['-s', serial, 'shell', 'am', 'start', '-n', 'com.phonedesk.display/.MainActivity']);
        } else {
          await run(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', wifiIp ? phoneUrl() : `http://localhost:${port}/phone`]);
        }
      }
      // Every ~30s: read the battery and (re)apply "screen always on". Re-applying covers a phone
      // reboot. stayon true = the screen never sleeps by itself while PhoneDesk manages the phone.
      if (d.reversed && Date.now() - (d.lastPoll || 0) > 30000) {
        d.lastPoll = Date.now();
        await run(['-s', serial, 'shell', 'svc', 'power', 'stayon', 'true']);
        const b = await run(['-s', serial, 'shell', 'dumpsys', 'battery']);
        const level = +((b.out.match(/^\s*level:\s*(\d+)/m) || [])[1]);
        const scale = +((b.out.match(/^\s*scale:\s*(\d+)/m) || [])[1]) || 100;
        const status = +((b.out.match(/^\s*status:\s*(\d+)/m) || [])[1]);
        if (Number.isFinite(level)) {
          // status 2 = charging, 5 = full (still on power)
          d.battery = { level: level / scale, charging: status === 2 || status === 5 };
          const cables = [...devices.values()].filter((x) => !x.wifiIp).length;
          onBattery(d.battery, { wifiIp, onlyCable: !wifiIp && cables === 1 });
        }
      }
    }
    for (const serial of [...devices.keys()]) {
      if (!seen.has(serial)) {
        const gone = devices.get(serial);
        log.event('phone', gone.wifiIp ? `${gone.model} Wi-Fi link lost` : `${gone.model} unplugged`);
        devices.delete(serial);
      }
    }
  } catch (e) {
    lastError = e.message;
  } finally {
    busy = false;
  }
}

// Phones on Wi-Fi with "ADB over network" (LineageOS) or adb tcpip turned on: link to them so the
// PC can read their battery, keep the screen awake and reopen PhoneDesk after a restart.
// Tried quietly at most once a minute per phone; if network ADB is off, it simply fails.
const wifiTried = new Map();
const knownWifi = new Set(); // phones linked over Wi-Fi before: keep retrying them (e.g. after a phone restart)
async function tryWifi(ip) {
  if (!ip || !(await locate())) return;
  if ([...devices.values()].some((d) => d.wifiIp === ip && d.state === 'device')) return;
  if (Date.now() - (wifiTried.get(ip) || 0) < 60000) return;
  wifiTried.set(ip, Date.now());
  const r = await run(['connect', ip + ':5555'], 5000);
  if (/connected to/i.test(r.out) && !/failed|unable|cannot/i.test(r.out)) {
    if (!knownWifi.has(ip)) log.info(`network ADB link to ${ip}`);
    knownWifi.add(ip);
  }
}

module.exports = {
  onlineCheck(fn) { hasPhone = fn; },
  onBattery(fn) { onBattery = fn; },
  setPhoneUrl(fn) { phoneUrl = fn; },
  tryWifi,
  setAuto(on, port, initialDelay) {
    clearInterval(timer);
    timer = null;
    if (!on) return;
    // On server start, give an already-open phone page a few seconds to reconnect before we
    // decide it needs to be opened.
    setTimeout(() => scan(port), initialDelay || 0);
    timer = setInterval(() => scan(port), 4000);
    timer.unref();
  },
  stopAuto() { clearInterval(timer); timer = null; },
  async connectAll(port) {
    // Wait for any in-flight scan, then run one that also re-opens the page on the phone.
    for (let i = 0; i < 40 && busy; i++) await new Promise((r) => setTimeout(r, 100));
    await scan(port, true);
    return this.status();
  },
  status() {
    return {
      found: !!adbPath,
      path: adbPath,
      installing,
      error: lastError,
      devices: [...devices.values()].map(({ serial, state, model, reversed, wifiIp }) => ({ serial, state, model, reversed, via: wifiIp ? 'Wi-Fi' : 'USB' })),
    };
  },
  async install() {
    if (installing) return this.status();
    installing = true;
    const zip = path.join(TOOLS, 'platform-tools.zip');
    try {
      fs.mkdirSync(TOOLS, { recursive: true });
      log.info('downloading Android platform-tools (adb) from dl.google.com ...');
      const res = await fetch('https://dl.google.com/android/repository/platform-tools-latest-windows.zip');
      if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      await new Promise((resolve, reject) => {
        const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${TOOLS}' -Force`], { windowsHide: true });
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('unzip failed'))));
        p.on('error', reject);
      });
      fs.unlinkSync(zip);
      adbPath = null;
      await locate();
      log.info(adbPath ? 'adb installed: ' + adbPath : 'adb install finished but adb.exe was not found');
    } catch (e) {
      lastError = e.message;
      log.error('adb install failed: ' + e.message);
    } finally {
      installing = false;
    }
    return this.status();
  },
};
