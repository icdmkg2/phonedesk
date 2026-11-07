'use strict';
// USB mode: `adb reverse` maps the phone's localhost:PORT to the PC, so the phone talks to the PC
// over the cable. Lower latency than Wi-Fi, works with no network, and localhost is a "secure
// context" so the phone's screen wake-lock works too.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const log = require('./log');

const TOOLS = path.join(__dirname, '..', 'tools');
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
let hasUsbPhone = () => false; // set by the server: is a phone already connected over USB?
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
    const r = await run(['devices', '-l']);
    if (!r.ok) { lastError = r.err.trim(); return; }
    lastError = '';
    const seen = new Set();
    for (const line of r.out.split(/\r?\n/).slice(1)) {
      const m = line.trim().match(/^(\S+)\s+(device|unauthorized|offline|no permissions)\b(.*)$/);
      if (!m) continue;
      const [, serial, st, rest] = m;
      seen.add(serial);
      const model = friendly(((rest.match(/model:(\S+)/) || [])[1] || serial).replace(/_/g, ' '));
      let d = devices.get(serial);
      if (!d) {
        d = { serial, state: st, model, reversed: false, opened: false };
        devices.set(serial, d);
        log.info(`USB device found: ${model} (${st})`);
        if (st === 'unauthorized') log.warn(`Accept the "Allow USB debugging" prompt on ${model}`);
      }
      d.state = st;
      d.model = model;
      if (st !== 'device') { d.reversed = false; continue; }

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
      if (d.reversed && !d.opened && !forceOpen && hasUsbPhone()) d.opened = true; // already showing PhoneDesk
      if (d.reversed && (!d.opened || forceOpen)) {
        d.opened = true;
        // Open PhoneDesk on the phone. Chrome reuses the tab if it's already there.
        await run(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `http://localhost:${port}/phone`]);
        // Keep the screen on while plugged in (USB + AC). Harmless if it fails.
        await run(['-s', serial, 'shell', 'svc', 'power', 'stayon', 'usb']);
      }
    }
    for (const serial of [...devices.keys()]) {
      if (!seen.has(serial)) {
        log.info(`USB device removed: ${devices.get(serial).model}`);
        devices.delete(serial);
      }
    }
  } catch (e) {
    lastError = e.message;
  } finally {
    busy = false;
  }
}

module.exports = {
  onlineCheck(fn) { hasUsbPhone = fn; },
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
      devices: [...devices.values()].map(({ serial, state, model, reversed }) => ({ serial, state, model, reversed })),
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
