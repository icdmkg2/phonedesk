'use strict';
// "Save diagnostics": one zip with what's needed to understand a problem, for a bug report.
// Logs, settings with every secret removed, versions and system facts. No keys, tokens, calendar or
// Spotify credentials, and no notification texts beyond what the log already has.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DATA } = require('./paths');

/* ---------------------------------------------------------------- a minimal zip writer (deflate) */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
/** files: [{ name, data: Buffer|string }] -> Buffer (a .zip) */
function zip(files) {
  const now = dosTime(new Date());
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(now.time, 10); lh.writeUInt16LE(now.date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(now.time, 12); ch.writeUInt16LE(now.date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ---------------------------------------------------------------- what goes in */
const SECRET = /key|token|secret|password|calendarurl/i;
/** Settings with secrets replaced by "(set)" / "(empty)". */
function redact(cfg) {
  const out = {};
  for (const [k, v] of Object.entries(cfg || {})) {
    if (SECRET.test(k)) out[k] = v ? '(set)' : '(empty)';
    else if (k === 'shortcuts') out[k] = (v || []).map((s) => ({ label: s.label, type: s.type, icon: s.icon })); // not the commands/URLs
    else out[k] = v;
  }
  return out;
}

// The tail of a log file (the tray app writes the server's output to logs\server.log when installed).
function tail(file, max = 512 * 1024) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(max, st.size), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf;
  } catch { return null; }
}

function lines(list) { return list.map((l) => `${new Date(l.ts).toISOString()} ${String(l.level || l.kind).toUpperCase().padEnd(7)} ${l.msg}`).join('\n') + '\n'; }

/** ctx: { version, config, phones, bridge, update, log } -> { name, data } */
function build(ctx) {
  const cpus = os.cpus();
  const info = {
    phonedesk: ctx.version,
    createdAt: new Date().toISOString(),
    os: { platform: process.platform, release: os.release(), version: os.version ? os.version() : '', arch: os.arch() },
    node: process.version,
    installed: !!process.env.PHONEDESK_EXE,
    cpu: { model: cpus[0] ? cpus[0].model : '', threads: cpus.length },
    memoryGB: +(os.totalmem() / 1073741824).toFixed(1),
    uptimeHours: +(os.uptime() / 3600).toFixed(1),
    serverUptimeMinutes: +(process.uptime() / 60).toFixed(1),
    phones: (ctx.phones || []).map((p) => ({ device: p.device, via: p.via, screen: p.screen, latency: p.latency, app: p.app })),
    bridge: ctx.bridge || null,
    update: ctx.update ? { state: ctx.update.state, version: ctx.update.version, error: ctx.update.error } : null,
  };
  const files = [
    { name: 'info.json', data: JSON.stringify(info, null, 2) },
    { name: 'settings.json', data: JSON.stringify(redact(ctx.config), null, 2) },
    { name: 'log.txt', data: lines(ctx.log.recent()) },
    { name: 'activity.txt', data: lines(ctx.log.activity()) },
    { name: 'README.txt', data: 'PhoneDesk diagnostics. Attach this zip to a bug report at https://github.com/icdmkg2/phonedesk/issues\n' +
      'Secrets (keys, tokens, the calendar address) and shortcut commands are not included.\n' },
  ];
  for (const f of ['server.log', 'server.old.log']) {
    const b = tail(path.join(DATA, 'logs', f));
    if (b) files.push({ name: 'logs/' + f, data: b });
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return { name: `PhoneDesk-diagnostics-${ctx.version}-${stamp}.zip`, data: zip(files) };
}

module.exports = { build, zip, redact, crc32 };
