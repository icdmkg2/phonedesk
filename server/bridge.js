'use strict';
// Supervises the PowerShell media/volume bridge. If it dies or hangs it is restarted with backoff;
// the server itself keeps running and phones just see "nothing playing" for a moment.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');
const log = require('./log');

class Bridge extends EventEmitter {
  constructor(script) {
    super();
    this.script = script;
    this.proc = null;
    this.ready = false;
    this.stopped = true;
    this.restarts = 0;
    this.backoff = 1000;
    this.lastLine = 0;
    this.startedAt = 0;
  }

  start() {
    this.stopped = false;
    this._spawn();
    // Heartbeat + watchdog: the bridge answers "ping" with "pong". If it goes silent (e.g. a wedged
    // WinRT call), kill it and let the exit handler start a fresh one.
    this.hb = setInterval(() => {
      if (!this.proc) return;
      if (this.ready && Date.now() - this.lastLine > 40000) {
        log.warn('media bridge stopped responding, restarting');
        this._kill();
        return;
      }
      this.send('ping');
    }, 10000);
    this.hb.unref();
  }

  _spawn() {
    if (this.stopped) return;
    this.ready = false;
    this.startedAt = Date.now();
    this.lastLine = Date.now();
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = p;
    p.stdin.on('error', () => {});
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      this.lastLine = Date.now();
      if (!line.startsWith('{')) return;
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.t === 'pong') return;
      if (m.t === 'ready') this.ready = true;
      this.emit('message', m);
    });
    let errBuf = '';
    p.stderr.on('data', (d) => { errBuf = (errBuf + d).slice(-2000); });
    p.on('error', (e) => log.error('could not start media bridge: ' + e.message));
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.ready = false;
      if (this.stopped) return;
      const err = errBuf.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
      // If it ran fine for a while, reset backoff; otherwise grow it (cap 30s).
      this.backoff = Date.now() - this.startedAt > 60000 ? 1000 : Math.min(this.backoff * 2, 30000);
      log.warn(`media bridge exited (code ${code})${err ? ': ' + err : ''}; restarting in ${this.backoff / 1000}s`);
      log.event('problem', 'Media bridge stopped and was restarted');
      this.emit('message', { t: 'media', active: false });
      this.restarts++;
      setTimeout(() => this._spawn(), this.backoff);
    });
  }

  send(line) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    try { this.proc.stdin.write(String(line).replace(/[\r\n]/g, ' ') + '\n'); return true; } catch { return false; }
  }

  _kill() {
    if (!this.proc) return;
    try { spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {}); } catch {}
  }

  restart() {
    this.backoff = 500;
    if (this.proc) this._kill(); else this._spawn();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.hb);
    if (this.proc) { try { this.proc.stdin.end(); } catch {} this._kill(); }
  }

  status() {
    return { running: !!this.proc, ready: this.ready, restarts: this.restarts };
  }
}

module.exports = Bridge;
