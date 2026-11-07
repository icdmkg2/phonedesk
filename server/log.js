'use strict';
// Tiny logger with an in-memory ring buffer so the dashboard can show recent logs.
const MAX = 300;
const buf = [];
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
};
