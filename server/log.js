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
  /**
   * kind: 'phone' | 'shortcut' | 'problem' | 'info'
   * opt.group: events of the same group that come again within opt.window ms (10 min) are merged into one line,
   * written by opt.merged(count, msg), and moved to the top, so a phone that keeps reconnecting is one line.
   */
  event(kind, msg, opt) {
    const now = Date.now();
    msg = String(msg);
    write(kind === 'problem' ? 'warn' : 'info', msg);
    if (opt && opt.group) {
      for (let i = activity.length - 1; i >= Math.max(0, activity.length - 20); i--) {
        const a = activity[i];
        if (a.group !== opt.group || now - a.ts > (opt.window || 10 * 60 * 1000)) continue;
        activity.splice(i, 1);
        a.n = (a.n || 1) + 1; a.ts = now; a.kind = kind;
        a.msg = opt.merged ? String(opt.merged(a.n, msg)) : msg + ' (' + a.n + ' times)';
        activity.push(a);
        return;
      }
    }
    activity.push({ ts: now, kind, msg, group: opt && opt.group ? opt.group : undefined, n: 1 });
    if (activity.length > 100) activity.shift();
  },
  activity: () => activity.slice(),
};
