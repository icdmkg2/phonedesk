'use strict';
// Lyrics from the Spicy Lyrics API (https://developers.spicylyrics.org): community word-by-word syncs first, then Apple
// Music and Spotify. Needs a secret key (sl_sk_...) from the user's own application; the key stays on this PC and is only
// ever sent to api.spicylyrics.org. Only the title, artist, album and length of the playing song are sent.
const log = require('./log');

const BASE = 'https://api.spicylyrics.org';
const PROVIDERS = { spicy_lyrics: 'Spicy Lyrics', apple_music: 'Apple Music', spotify: 'Spotify' };

let pausedUntil = 0;   // after a rate limit or outage, leave the API alone for a while
let lastError = '';

async function call(path, key) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const res = await fetch(BASE + path, { signal: ctl.signal, headers: { Authorization: 'Bearer ' + key, 'User-Agent': 'PhoneDesk' } });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body, retryAfter: +res.headers.get('retry-after') || 0 };
  } finally { clearTimeout(timer); }
}

function problem(r) {
  const b = r.body && r.body.Body;
  return (b && (b.message || b.error)) || ('HTTP ' + r.status);
}

/** Find the Spotify id of this exact recording (and release) through the API's search. */
async function findTrackId(media, key) {
  const q = new URLSearchParams({ title: media.title, artist: media.artist });
  if (media.album) q.set('album', media.album);
  if (media.duration > 0) q.set('duration', media.duration.toFixed(3));
  const r = await call('/v1/tracks/search?' + q, key);
  if (r.status === 429 || r.status === 503 || r.status >= 500) { pausedUntil = Date.now() + Math.max(30, r.retryAfter || 60) * 1000; throw new Error(problem(r)); }
  if (r.status === 401 || r.status === 403) { lastError = problem(r); throw new Error(lastError); }
  if (r.status !== 200 || !r.body || !r.body.Body) return null;
  lastError = '';
  const results = (r.body.Body.results || []).filter((x) => x.tier === 'exact' || x.tier === 'likely');
  if (!results.length) return null;
  const want = media.duration || 0;
  // Every release of the best matches; the one whose length is closest to what is playing has the right timings.
  const cands = [];
  for (const x of results.slice(0, 3)) {
    cands.push({ id: x.id, d: x.duration, tier: x.tier });
    for (const v of x.variants || []) cands.push({ id: v.id, d: v.duration, tier: x.tier });
  }
  const diff = (c) => (want > 0 && c.d > 0 ? Math.abs(c.d - want) : 0);
  cands.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'exact' ? -1 : 1) || diff(a) - diff(b));
  const best = cands[0];
  if (want > 0 && best.d > 0 && Math.abs(best.d - want) > 4) return null; // a different cut: its timings would be wrong
  return best.id;
}

function person(p) { return p && p.username ? { name: p.username, url: p.url || '' } : null; }

function convert(env) {
  const b = env && env.Body;
  if (!b || !Array.isArray(b.Content) || !b.Content.length) return null;
  const credit = { provider: PROVIDERS[b.source] || 'Spicy Lyrics', source: b.source || '' };
  if (b.source === 'spicy_lyrics' && b.UploadAttribution) {
    credit.uploader = person(b.UploadAttribution.Uploader);
    credit.maker = person(b.UploadAttribution.Maker);
    if (!credit.uploader) delete credit.uploader;
    if (!credit.maker) delete credit.maker;
  }
  if (b.Type === 'Syllable') {
    const lines = [];
    for (const line of b.Content) {
      const lead = line.Lead;
      if (!lead || !Array.isArray(lead.Syllables) || !lead.Syllables.length) continue;
      const words = [];
      let cur = null;
      for (const s of lead.Syllables) {
        if (!cur) cur = { t: s.StartTime, e: s.EndTime, text: '' };
        cur.text += s.Text || '';
        if (Number.isFinite(s.EndTime)) cur.e = s.EndTime;
        if (!s.IsPartOfWord) { words.push(cur); cur = null; }
      }
      if (cur) words.push(cur);
      const w = words.map((x) => ({ t: x.t, e: x.e, text: String(x.text).trim() })).filter((x) => x.text && Number.isFinite(x.t));
      if (!w.length) continue;
      const t = Number.isFinite(lead.StartTime) ? lead.StartTime : w[0].t;
      const e = Number.isFinite(lead.EndTime) ? lead.EndTime : w[w.length - 1].e;
      lines.push({ t, e, dur: Math.max(0.3, e - t), text: w.map((x) => x.text).join(' '), words: w, opp: !!line.OppositeAligned });
    }
    if (!lines.length) return null;
    return { synced: true, wordSynced: true, lines, source: credit.source, credit };
  }
  if (b.Type === 'Line') {
    const lines = b.Content.filter((x) => x && typeof x.Text === 'string' && Number.isFinite(x.StartTime))
      .map((x) => ({ t: x.StartTime, e: x.EndTime, dur: Number.isFinite(x.EndTime) ? Math.max(0.3, x.EndTime - x.StartTime) : 0, text: x.Text.trim(), opp: !!x.OppositeAligned }));
    if (!lines.length) return null;
    return { synced: true, lines, source: credit.source, credit };
  }
  const lines = b.Content.map((x) => ({ t: -1, text: String((x && (x.Text || x.text)) || '').trim() }));
  return lines.some((x) => x.text) ? { synced: false, lines, source: credit.source, credit } : null;
}

module.exports = {
  lastError: () => lastError,
  /** Resolves to a lyrics result, or null when the API has none. Throws on key problems, rate limits and outages. */
  async find(media, key) {
    if (!key) return null;
    if (Date.now() < pausedUntil) throw new Error('Spicy Lyrics is paused for a moment (rate limit)');
    const title = String(media.title || '').trim(), artist = String(media.artist || '').trim();
    if (!title || !artist) return null;
    const id = await findTrackId({ title, artist, album: String(media.album || '').trim(), duration: media.duration || 0 }, key);
    if (!id) return null;
    const r = await call('/v1/lyrics/' + encodeURIComponent(id), key);
    if (r.status === 404) return null;
    if (r.status === 429 || r.status === 503 || r.status >= 500) { pausedUntil = Date.now() + Math.max(30, r.retryAfter || 60) * 1000; throw new Error(problem(r)); }
    if (r.status === 401 || r.status === 403) { lastError = problem(r); throw new Error(lastError); }
    if (r.status !== 200) return null;
    lastError = '';
    return convert(r.body);
  },
  /** For the dashboard's "Check" button. */
  async check(key) {
    if (!/^sl_[sp]k_/.test(key || '')) return { ok: false, error: 'That does not look like a Spicy Lyrics key (it starts with sl_sk_).' };
    try {
      const r = await call('/v1/lyrics/1QV6tiMFM6fSOKOGLMHYYg', key);
      if (r.status === 200) { lastError = ''; return { ok: true }; }
      return { ok: false, error: problem(r) };
    } catch (e) { return { ok: false, error: 'Could not reach Spicy Lyrics: ' + e.message }; }
  },
};
