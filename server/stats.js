'use strict';
// CPU (total and per core) / RAM / uptime from os.cpus() deltas: cheap, no external tools.
// Network speeds come from byte totals the Windows media bridge reports (see setNet).
// Keeps the last hour as one point every 10 s, for the history graph.
const os = require('os');

const HIST_STEP = 10 * 1000;
const HIST_MAX = 360; // one hour

let net = null;          // { rx, tx } bytes per second
let netPrev = null;      // { rx, tx, at } last byte totals
let gpuLoad = () => -1;
let extras = { cpuTemp: -1, procs: [], procsMem: [], disks: [] }; // from the bridge (temperature, busiest apps) and from statfs (disks)
const history = [];      // { t, cpu, mem, gpu, rx, tx }
let acc = null;          // running sums for the current history step
let prev = snapshot();
let last = sampleMem(0, []);

function snapshot() {
  return os.cpus().map((c) => {
    let total = 0;
    for (const k in c.times) total += c.times[k];
    return { idle: c.times.idle, total };
  });
}

function sampleMem(cpu, cores) {
  const total = os.totalmem();
  return {
    cpu,
    coresLoad: cores,
    memUsed: total - os.freemem(),
    memTotal: total,
    uptime: Math.round(os.uptime()),
    host: os.hostname(),
    cores: os.cpus().length,
    net,
    cpuTemp: extras.cpuTemp,
    procs: extras.procs,
    procsMem: extras.procsMem,
    disks: extras.disks,
  };
}

function sample() {
  const now = snapshot();
  let di = 0, dt = 0;
  const cores = now.map((c, i) => {
    const p = prev[i] || c;
    const ci = c.idle - p.idle, ct = c.total - p.total;
    di += ci; dt += ct;
    return ct > 0 ? Math.max(0, Math.min(100, Math.round((1 - ci / ct) * 100))) : 0;
  });
  prev = now;
  last = sampleMem(dt > 0 ? Math.round((1 - di / dt) * 100) : 0, cores);
  addHistory(last);
  return last;
}

function addHistory(s) {
  const now = Date.now();
  const mem = s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
  const g = gpuLoad();
  if (!acc) acc = { start: now, n: 0, cpu: 0, mem: 0, gpu: 0, gn: 0, rx: 0, tx: 0 };
  acc.n++; acc.cpu += s.cpu; acc.mem += mem;
  if (g >= 0) { acc.gpu += g; acc.gn++; }
  if (s.net) { acc.rx += s.net.rx; acc.tx += s.net.tx; }
  if (now - acc.start < HIST_STEP) return;
  const n = acc.n;
  const point = {
    t: now,
    cpu: Math.round(acc.cpu / n),
    mem: Math.round(acc.mem / n),
    gpu: acc.gn ? Math.round(acc.gpu / acc.gn) : -1,
    rx: Math.round(acc.rx / n),
    tx: Math.round(acc.tx / n),
  };
  acc = null;
  history.push(point);
  while (history.length > HIST_MAX) history.shift();
  onPoint(point);
}

let onPoint = () => {};

// Disk space: every drive letter that exists (C: to Z:) on Windows, the root elsewhere. Every 30 s is plenty.
const fs = require('fs');
function readDisks() {
  if (typeof fs.statfsSync !== 'function') return;
  const roots = process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => l + ':\\') : ['/'];
  const out = [];
  for (const r of roots) {
    try {
      if (process.platform === 'win32' && !fs.existsSync(r)) continue;
      const st = fs.statfsSync(r), total = st.blocks * st.bsize, free = st.bavail * st.bsize;
      if (total > 1e9) out.push({ name: process.platform === 'win32' ? r.slice(0, 2) : r, used: total - free, total });
    } catch {}
    if (out.length >= 8) break;
  }
  extras.disks = out;
}
try { readDisks(); } catch {}
setInterval(() => { try { readDisks(); } catch {} }, 30000).unref();

module.exports = {
  latest: () => last,
  /** CPU temperature (°C, -1 when unknown) and the busiest apps [{ name, cpu, mem }] from the bridge. */
  setExtras(x) {
    if (!x) return;
    if (Number.isFinite(+x.cpuTemp)) extras.cpuTemp = Math.round(+x.cpuTemp);
    const clean = (l) => l.slice(0, 8).map((p) => ({ name: String((p && p.name) || '').slice(0, 40), cpu: Math.max(0, Math.min(100, Math.round(+(p && p.cpu) || 0))), mem: Math.max(0, +(p && p.mem) || 0) }));
    if (Array.isArray(x.procs)) extras.procs = clean(x.procs);
    if (Array.isArray(x.procsMem)) extras.procsMem = clean(x.procsMem);
  },
  history: () => history.slice(),
  /** Byte totals of all network adapters (from the bridge); turned into speeds here. */
  setNet(rx, tx) {
    const at = Date.now();
    if (!(rx >= 0 && tx >= 0)) return;
    if (netPrev && at > netPrev.at && rx >= netPrev.rx && tx >= netPrev.tx) {
      const s = (at - netPrev.at) / 1000;
      net = { rx: Math.round((rx - netPrev.rx) / s), tx: Math.round((tx - netPrev.tx) / s) };
    }
    netPrev = { rx, tx, at };
  },
  /** onSample(sample) every 2 s while someone watches; onHistory(point) every 10 s (always, so the hour is complete). */
  start(onSample, shouldRun, getGpuLoad, onHistory) {
    if (getGpuLoad) gpuLoad = getGpuLoad;
    if (onHistory) onPoint = onHistory;
    setInterval(() => { const s = sample(); if (shouldRun()) onSample(s); }, 2000).unref();
  },
};
