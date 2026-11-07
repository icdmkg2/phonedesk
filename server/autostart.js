'use strict';
// "Start with Windows" for the installed app: the HKCU Run key, the same one the tray menu uses.
// Only available when running under the tray app (it passes its own path in PHONEDESK_EXE).
const { execFile } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const exe = process.env.PHONEDESK_EXE || '';

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 5000 }, (err, out) => resolve({ ok: !err, out: String(out || '') }));
  });
}

module.exports = {
  async get() {
    if (!exe) return { available: false, enabled: false };
    const r = await reg(['query', KEY, '/v', 'PhoneDesk']);
    return { available: true, enabled: r.ok };
  },
  async set(on) {
    if (!exe) return;
    if (on) await reg(['add', KEY, '/v', 'PhoneDesk', '/t', 'REG_SZ', '/d', `"${exe}" --background`, '/f']);
    else await reg(['delete', KEY, '/v', 'PhoneDesk', '/f']);
  },
};
