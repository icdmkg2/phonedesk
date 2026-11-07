'use strict';
// PC notifications on the phone. Windows keeps every toast notification in a small SQLite database
// in the user's profile; PhoneDesk reads new rows from it (read-only) every 2 seconds.
// Nothing leaves your network: notifications only go to your own phone.
const path = require('path');
const log = require('./log');

const DB = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');

let db = null;
let stmt = null;
let lastId = 0;
let timer = null;

function open() {
  // node:sqlite ships with Node 22.5+. Loaded lazily so older Node versions just skip this feature.
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB, { readOnly: true });
  stmt = db.prepare(`SELECT n.Id AS id, h.PrimaryId AS app, n.Payload AS payload
                     FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId
                     WHERE n.Type = 'toast' AND n.Id > ? ORDER BY n.Id LIMIT 20`);
  if (!lastId) lastId = Number(db.prepare('SELECT IFNULL(MAX(Id), 0) AS m FROM Notification').get().m);
}

function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&').trim();
}

/** A readable app name from Windows' app id when we don't have a better one. */
function prettyId(id) {
  let s = String(id || '');
  s = s.split('!')[0].split('\\').pop().replace(/\.exe$/i, '');
  s = s.replace(/_[a-z0-9]{10,}$/i, '');          // store publisher hash
  s = s.split('.').pop();                          // Publisher.AppName -> AppName
  s = s.replace(/Desktop$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return s.trim() || 'Notification';
}

function poll(onNotify) {
  try {
    if (!db) open();
    for (const r of stmt.all(lastId)) {
      lastId = Math.max(lastId, Number(r.id));
      const xml = Buffer.from(r.payload || []).toString('utf8');
      const texts = [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decode(m[1])).filter(Boolean);
      if (!texts.length) continue;
      onNotify({ id: Number(r.id), app: r.app, appName: prettyId(r.app), title: texts[0].slice(0, 120), body: texts.slice(1).join('\n').slice(0, 300), ts: Date.now() });
    }
  } catch (e) {
    // The database can be briefly busy; reopen next time. Log only occasionally.
    if (db) { try { db.close(); } catch {} }
    db = null;
    if (!poll.warned) { poll.warned = true; log.warn('notifications: ' + e.message); }
  }
}

module.exports = {
  prettyId,
  start(isEnabled, onNotify) {
    clearInterval(timer);
    timer = setInterval(() => { if (isEnabled()) poll(onNotify); else if (db) { try { db.close(); } catch {} db = null; lastId = 0; } }, 2000);
    timer.unref();
  },
};
