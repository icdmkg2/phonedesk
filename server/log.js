'use strict';
// Tiny logger with an in-memory ring buffer so the dashboard can show recent logs.
const MAX = 300;
const buf = [];
const activity = []; // notable events only: phones, shortcuts, problems
function write(level, msg) {
  const line = { ts: Date.now(), level, msg: String(msg) };
  buf.push(line);
  if (buf.length > MAX) buf.shift();
  const t = new Date(line.ts).toLocaleTimeString();
  (level === 'error' ? console.error : console.log)(`${t} ${level.toUpperCase().padEnd(5)} ${line.msg}`);
}
module.exports = {
  info: (m) => write('info', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),
  recent: () => buf.slice(),
  /** kind: 'phone' | 'shortcut' | 'problem' | 'info' */
  event(kind, msg) {
    activity.push({ ts: Date.now(), kind, msg: String(msg) });
    if (activity.length > 100) activity.shift();
    write(kind === 'problem' ? 'warn' : 'info', msg);
  },
  activity: () => activity.slice(),
};
