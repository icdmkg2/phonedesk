'use strict';
// Synced lyrics from LRCLIB (https://lrclib.net), a free, open lyrics database. No account or key.
// Only the artist, title, album and length are sent.
const log = require('./log');

const cache = new Map();
const MAX = 100;

function clean(s) {
  return String(s || '')
    .replace(/\s*-\s*YouTube( Music)?$/i, '')
    .replace(/[([](official|lyrics?|audio|video|music video|visualizer|hd|4k|explicit|clean|remaster(ed)?( \d{4})?|live)[^)\]]*[)\]]/gi, '')
    .replace(/\s+(ft\.?|feat\.?)\s.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const st of stamps) lines.push({ t: +st[1] * 60 + +st[2], text: words });
  }
  return lines.sort((a, b) => a.t - b.t);
}

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'PhoneDesk (https://github.com/)' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

function toResult(r) {
  if (!r) return null;
  if (r.instrumental) return { synced: false, instrumental: true, lines: [] };
  if (r.syncedLyrics) return { synced: true, lines: parseLrc(r.syncedLyrics) };
  if (r.plainLyrics) return { synced: false, lines: r.plainLyrics.split(/\r?\n/).map((text) => ({ t: -1, text: text.trim() })) };
  return null;
}

async function lookup(artist, title, album, duration) {
  const q = new URLSearchParams({ artist_name: artist, track_name: title });
  if (album) q.set('album_name', album);
  if (duration > 0) q.set('duration', String(Math.round(duration)));
  let r = toResult(await getJson('https://lrclib.net/api/get?' + q));
  if (r && r.lines.length) return r;
  // Looser search: the first result with synced lyrics and a close length.
  const list = await getJson('https://lrclib.net/api/search?' + new URLSearchParams({ artist_name: artist, track_name: title }));
  const best = (list || []).find((x) => x.syncedLyrics && (!duration || Math.abs(x.duration - duration) < 8)) || (list || [])[0];
  return toResult(best);
}

module.exports = {
  /** Resolves to { synced, lines:[{t,text}] } or null. Never throws. */
  find(media) {
    let artist = clean(media.artist);
    let title = clean(media.title);
    if (!artist) {
      const m = title.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
      if (m) { artist = m[1].trim(); title = m[2].trim(); }
    }
    if (!artist || !title) return Promise.resolve(null);
    const key = (artist + '|' + title).toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const p = lookup(artist, title, clean(media.album), media.duration || 0)
      .catch((e) => { log.warn('lyrics lookup failed: ' + e.message); cache.delete(key); return null; });
    cache.set(key, p);
    if (cache.size > MAX) cache.delete(cache.keys().next().value);
    return p;
  },
};
