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
    .replace(/\s*[([]\s*(feat|ft|with)\.?[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|live|single version|radio edit|mono|stereo|remix|bonus track|deluxe)\b.*$/i, '')
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

// The best candidate: synced lyrics whose length matches the song, else plain text from a close match.
function pick(list, duration) {
  const items = (list || []).filter((x) => x && (x.syncedLyrics || x.plainLyrics || x.instrumental));
  const diff = (x) => (duration > 0 && x.duration > 0 ? Math.abs(x.duration - duration) : 0);
  const byDiff = (a, b) => diff(a) - diff(b);
  const synced = items.filter((x) => x.syncedLyrics).sort(byDiff);
  if (synced.length && (!duration || diff(synced[0]) <= 6)) return synced[0];
  const close = items.sort(byDiff);
  if (close.length && (!duration || diff(close[0]) <= 12)) return close[0];
  return null;
}

async function lookup(artist, title, album, duration) {
  const base = { artist_name: artist, track_name: title };
  const withAlbum = new URLSearchParams(base);
  if (album) withAlbum.set('album_name', album);
  if (duration > 0) withAlbum.set('duration', String(Math.round(duration)));
  // 1) exact match with album and length, 2) without the album, 3) searches
  let r = toResult(await getJson('https://lrclib.net/api/get?' + withAlbum));
  if (r && r.lines.length) return r;
  if (album) {
    const q = new URLSearchParams(base);
    if (duration > 0) q.set('duration', String(Math.round(duration)));
    r = toResult(await getJson('https://lrclib.net/api/get?' + q));
    if (r && r.lines.length) return r;
  }
  let found = pick(await getJson('https://lrclib.net/api/search?' + new URLSearchParams(base)), duration);
  if (!found) found = pick(await getJson('https://lrclib.net/api/search?' + new URLSearchParams({ q: artist + ' ' + title })), duration);
  return toResult(found);
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
