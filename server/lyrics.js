'use strict';
// Synced lyrics from LRCLIB (https://lrclib.net), a free, open lyrics database. No account or key.
// Only the artist, title, album and length are sent.
const log = require('./log');
const spicy = require('./spicylyrics');

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
  // [offset:+500] moves every line 0.5 s earlier (the LRC convention); a few files on LRCLIB carry one.
  const off = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(String(text || ''));
  const shift = off ? +off[1] / 1000 : 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const st of stamps) lines.push({ t: Math.max(0, +st[1] * 60 + +st[2] - shift), text: words });
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

const LRCLIB = { provider: 'LRCLIB', source: 'lrclib' };
function toResult(r) {
  if (!r) return null;
  if (r.instrumental) return { synced: false, instrumental: true, lines: [], credit: LRCLIB };
  if (r.syncedLyrics) return { synced: true, lines: parseLrc(r.syncedLyrics), credit: LRCLIB };
  if (r.plainLyrics) return { synced: false, lines: r.plainLyrics.split(/\r?\n/).map((text) => ({ t: -1, text: text.trim() })), credit: LRCLIB };
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
  if (close.length && (!duration || diff(close[0]) <= 12)) {
    const x = close[0];
    // A different cut of the song (a music video with an intro or outro, a radio edit...): its line timings would be
    // off by seconds, so use only its words, which the phone then paces over the song (estimated timing).
    if (x.syncedLyrics && duration && diff(x) > 6) {
      const words = x.plainLyrics || parseLrc(x.syncedLyrics).map((l) => l.text).join('\n');
      return Object.assign({}, x, { syncedLyrics: null, plainLyrics: words });
    }
    return x;
  }
  return null;
}

// ---------------------------------------------------------------- LRCLIB: picking the right copy
// LRCLIB keeps many copies of a popular song (one per album it appeared on, plus uploads from videos), timed by
// different people: most agree to a few tenths of a second, a few are late or early by seconds, some are another cut
// of the song, and some have only plain words. The first copy is not a good choice. So: collect every copy, keep the
// timed ones that fit this recording, and take the one most of the others agree with.
const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function lineTimes(x) {
  if (x._times) return x._times;
  const lines = parseLrc(x.syncedLyrics), m = new Map(), seen = new Map();
  for (const l of lines) {
    const k = norm(l.text); if (!k) continue;
    const n = (seen.get(k) || 0) + 1; seen.set(k, n);
    m.set(k + '#' + n, l.t);
  }
  x._lines = lines; x._times = m;
  return m;
}
function agree(a, b) { // do two copies put their shared lines at the same moments? (median gap under 0.6 s)
  const A = lineTimes(a), B = lineTimes(b), gaps = [];
  for (const [k, t] of A) { const u = B.get(k); if (u != null) gaps.push(Math.abs(t - u)); }
  if (gaps.length < 4) return false;
  gaps.sort((x, y) => x - y);
  return gaps[gaps.length >> 1] <= 0.6;
}
/** The best timed copy for a recording of `duration` seconds (0 = unknown), or null. Exported for tests. */
function bestSynced(list, duration, album) {
  const diff = (x) => (duration > 0 && x.duration > 0 ? Math.abs(x.duration - duration) : 0);
  let pool = (list || []).filter((x) => x && x.syncedLyrics && !x.instrumental);
  pool.forEach((x) => lineTimes(x));
  // a copy that cannot be this recording: hardly any lines, or lines that run past the end of the song
  pool = pool.filter((x) => x._lines.length >= 3 && !(duration > 0 && x._lines[x._lines.length - 1].t > duration + 2));
  if (!pool.length) return null;
  if (duration > 0) {
    // the same length as the one playing (LRCLIB rounds to whole seconds); else within 3 s; else within 6 s
    for (const tol of [1.2, 3, 6]) { const near = pool.filter((x) => diff(x) <= tol); if (near.length) { pool = near; break; } if (tol === 6) pool = []; }
    if (!pool.length) return null;
  }
  const want = norm(album);
  let best = null, bestScore = -Infinity;
  for (const x of pool) {
    let score = 0;
    for (const y of pool) if (y !== x && agree(x, y)) score += 1; // copies that time the song the same way
    if (want && norm(x.albumName) === want) score += 0.6;          // the album that is playing
    if (duration > 0) score += diff(x) <= 1 ? 0.3 : 0;             // the same length to the second
    score -= diff(x) * 0.05;
    if (score > bestScore) { bestScore = score; best = x; }
  }
  return best;
}

const ARTIST_SPLIT = /\s*(?:,|;|&|\bx\b|\bfeat\.?|\bft\.?|\bwith\b|\band\b)\s*/i;
/** The first of several artists ("Calvin Harris, Dua Lipa" -> "Calvin Harris"), or the same text. */
function firstArtist(artist) { return String(artist || '').split(ARTIST_SPLIT)[0].trim() || String(artist || '').trim(); }

async function candidates(artist, title, album, duration) {
  const base = { artist_name: artist, track_name: title };
  const calls = [getJson('https://lrclib.net/api/search?' + new URLSearchParams(base)).then((l) => l || [])];
  if (duration > 0) { // LRCLIB's exact match (needs the length) is one more copy to weigh, with the album when known
    const q = new URLSearchParams(base); if (album) q.set('album_name', album); q.set('duration', String(Math.round(duration)));
    calls.push(getJson('https://lrclib.net/api/get?' + q).then((x) => (x ? [x] : [])));
  }
  const out = [], seen = new Set();
  for (const l of await Promise.all(calls)) for (const x of l) if (x && !seen.has(x.id) && (x.syncedLyrics || x.plainLyrics || x.instrumental)) { seen.add(x.id); out.push(x); }
  return out;
}

async function lookup(artist, title, album, duration) {
  let list = await candidates(artist, title, album, duration);
  const first = firstArtist(artist);
  if (!list.length && first && first !== artist) list = await candidates(first, title, album, duration); // "A, B" -> "A"
  if (!list.length) list = (await getJson('https://lrclib.net/api/search?' + new URLSearchParams({ q: artist + ' ' + title }))) || [];
  const synced = bestSynced(list, duration, album);
  if (synced) return toResult(synced);
  // nothing timed fits this recording: plain words (or another cut's words) with estimated timing, else an instrumental
  return toResult(pick(list, duration));
}

// Only a title (YouTube Music in Chrome gives no artist): LRCLIB's search by the title, picked by the song's length,
// which must be known and close, or a song of the same name by someone else would come up.
const titleCache = new Map();
function byTitle(title, duration) {
  if (!(duration > 0)) return Promise.resolve(null);
  const key = title.toLowerCase() + '|' + Math.round(duration / 3);
  if (titleCache.has(key)) return titleCache.get(key);
  const p = (async () => {
    const list = (await getJson('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: title }))) || [];
    const close = list.filter((x) => x && x.duration > 0 && Math.abs(x.duration - duration) <= 3 && (x.syncedLyrics || x.plainLyrics));
    const found = pick(close, duration);
    const r = toResult(found);
    if (r && found.artistName) r.artist = String(found.artistName).slice(0, 120);
    return r;
  })().catch((e) => { log.warn('lyrics lookup failed: ' + e.message); titleCache.delete(key); return null; });
  titleCache.set(key, p);
  if (titleCache.size > 200) titleCache.delete(titleCache.keys().next().value);
  return p;
}

// Spicy Lyrics finds a song by artist and title; a streaming service's spelling often differs from its catalogue, so a
// few spellings are tried in turn (kept to three: each is a request): the full artist, then the first of several
// artists, with the cleaned title and then the title as the player gave it.
async function spicyFirst(media, artist, title, key) {
  const raw = String(media.title || '').trim(), first = firstArtist(artist);
  const tries = [[artist, title], [first, title], [artist, raw], [first, raw]]
    .filter(([a, t], i, l) => a && t && l.findIndex(([a2, t2]) => a2 === a && t2 === t) === i).slice(0, 3);
  for (const [a, t] of tries) {
    const r = await spicy.find({ title: t, artist: a, album: clean(media.album), duration: media.duration || 0 }, key);
    if (r) return r;
  }
  return null;
}

module.exports = {
  byTitle, // for tests
  parseLrc, pick, bestSynced, firstArtist, lookup, // for tests
  /** Resolves to { synced, lines:[{t,text,...}], credit } or null. Never throws. `cfg` is the PhoneDesk config. */
  find(media, cfg) {
    let artist = clean(media.artist);
    let title = clean(media.title);
    if (!artist) {
      const m = title.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
      if (m) { artist = m[1].trim(); title = m[2].trim(); }
    }
    if (!title) return Promise.resolve(null);
    if (!artist) { // a browser that gives only the song's title: LRCLIB names the artist, then Spicy Lyrics is tried first
      return byTitle(title, media.duration || 0).then(async (r) => {
        if (r && r.artist && cfg && cfg.spicyKey) {
          try { const sp = await spicyFirst(media, r.artist, title, cfg.spicyKey); if (sp) return Object.assign(sp, { artist: r.artist }); } catch (e) { log.warn('Spicy Lyrics: ' + e.message); }
        }
        return r;
      });
    }
    // the length is part of the key: the song and its music video are different cuts with different timings
    const key = (artist + '|' + title).toLowerCase() + '|' + Math.round((media.duration || 0) / 3) + ((cfg && cfg.spicyKey) ? '|s' : '');
    if (cache.has(key)) return cache.get(key);
    let transient = false, retryMs = 0;
    const run = async () => {
      // 1) Spicy Lyrics, first for every song; 2) LRCLIB when it has nothing or can't be asked right now
      if (cfg && cfg.spicyKey) {
        try {
          const r = await spicyFirst(media, artist, title, cfg.spicyKey);
          if (r) return r;
        } catch (e) {
          transient = !e.auth; // a wrong key won't fix itself; an outage or a rate limit will
          retryMs = transient ? Math.min(300000, Math.max(30000, spicy.pausedFor() + 2000)) : 0;
          log.warn('Spicy Lyrics: ' + e.message);
        }
      }
      const r = await lookup(artist, title, clean(media.album), media.duration || 0);
      if (r && transient) r.retryMs = retryMs; // the server asks Spicy Lyrics again then and swaps the lyrics in
      return r;
    };
    const p = run().catch((e) => { log.warn('lyrics lookup failed: ' + e.message); cache.delete(key); return null; })
      .then((r) => { if (transient) cache.delete(key); return r; });
    cache.set(key, p);
    if (cache.size > MAX) cache.delete(cache.keys().next().value);
    return p;
  },
};
