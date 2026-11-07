'use strict';
// Album art for tracks whose app doesn't provide a picture (YouTube in a browser, some players).
// Looks the song up in Apple's free iTunes Search API. Only the artist/title text is sent. A result
// is used only if its artist really appears in the track info, so we never show the wrong cover.
const log = require('./log');

const cache = new Map(); // key -> Promise<Buffer|null>
const MAX = 200;

function clean(s) {
  return String(s || '')
    .replace(/\s*-\s*YouTube( Music)?$/i, '')
    .replace(/[([](official|lyrics?|audio|video|music video|visualizer|hd|4k|explicit|clean|remaster(ed)?|live)[^)\]]*[)\]]/gi, '')
    .replace(/\s+(ft\.?|feat\.?)\s.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Work out artist + title, including "Artist - Song" style video titles. */
function parse(media) {
  let artist = clean(media.artist);
  let title = clean(media.title);
  if (!artist) {
    const m = title.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
    if (m) { artist = m[1].trim(); title = m[2].trim(); }
  }
  return { artist, title };
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'PhoneDesk' } });
    if (!res.ok) return null;
    return await res.json();
  } finally { clearTimeout(t); }
}

async function fetchBuf(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 500 ? buf : null;
  } finally { clearTimeout(t); }
}

async function lookup(artist, title) {
  const term = encodeURIComponent((artist + ' ' + title).slice(0, 120));
  const data = await fetchJson(`https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${term}`);
  const results = (data && data.results) || [];
  const a = norm(artist), t = norm(title);
  // Accept only a result whose artist matches and whose song name overlaps the title.
  const hit = results.find((r) => {
    const ra = norm(r.artistName), rt = norm(r.trackName);
    const artistOk = ra && a && (ra.includes(a) || a.includes(ra));
    const firstWord = rt.split(' ')[0];
    const titleOk = rt && t && (t.includes(rt) || rt.includes(t) || (firstWord.length > 2 && t.includes(firstWord)));
    return artistOk && titleOk && r.artworkUrl100;
  });
  if (!hit) return null;
  return fetchBuf(hit.artworkUrl100.replace(/100x100bb/, '600x600bb'));
}

module.exports = {
  /** Resolves to an image Buffer, or null. Never throws. */
  find(media) {
    const { artist, title } = parse(media);
    if (!artist || !title) return Promise.resolve(null); // nothing reliable to search for
    const key = norm(artist) + '|' + norm(title);
    if (cache.has(key)) return cache.get(key);
    const p = lookup(artist, title).catch((e) => { log.warn('album art lookup failed: ' + e.message); return null; });
    cache.set(key, p);
    if (cache.size > MAX) cache.delete(cache.keys().next().value);
    return p;
  },
};
