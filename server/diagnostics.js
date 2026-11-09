'use strict';
// "Save diagnostics": one zip with what's needed to understand a problem, for a bug report.
// Logs, settings with every secret removed, versions and system facts. No keys, tokens, calendar or
// Spotify credentials, and no notification texts beyond what the log already has.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DATA } = require('./paths');

const { zip, crc32 } = require('./zip');

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
