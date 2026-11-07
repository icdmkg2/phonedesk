'use strict';
// CPU / RAM / uptime. CPU% from os.cpus() deltas: cheap, no external tools.
const os = require('os');

let prev = snapshot();
let last = sampleMem(0);

function snapshot() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

function sampleMem(cpu) {
  const total = os.totalmem();
  return {
    cpu,
    memUsed: total - os.freemem(),
    memTotal: total,
    uptime: Math.round(os.uptime()),
    host: os.hostname(),
    cores: os.cpus().length,
  };
}

function sample() {
  const now = snapshot();
  const di = now.idle - prev.idle, dt = now.total - prev.total;
  prev = now;
  last = sampleMem(dt > 0 ? Math.round((1 - di / dt) * 100) : 0);
  return last;
}

module.exports = {
  latest: () => last,
  start(onSample, shouldRun) {
    setInterval(() => { if (shouldRun()) onSample(sample()); }, 2000).unref();
  },
};
