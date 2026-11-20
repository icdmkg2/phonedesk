'use strict';
// Lyrics from the Spicy Lyrics API (https://developers.spicylyrics.org): community word-by-word syncs first, then Apple
// Music and Spotify. Needs a secret key (sl_sk_...) from the user's own application; the key stays on this PC and is only
// ever sent to api.spicylyrics.org. Only the title, artist, album and length of the playing song are sent.
const log = require('./log');

const BASE = 'https://api.spicylyrics.org';
const PROVIDERS = { spicy_lyrics: 'Spicy Lyrics', apple_music: 'Apple Music', spotify: 'Spotify' };

let pausedUntil = 0;   // after a rate limit or outage, leave the API alone for a while
let lastError = '';
// Why the last lookup found nothing: kind is 'nothing' (the API does not know the song), 'weak' (only poor matches),
// 'duration' (the song is known, but its length differs), 'nolyrics' or 'error'. Shown in the PC window and the log.
let lastMissInfo = { kind: '', text: '' };
function miss(kind, text) { lastMissInfo = { kind, text }; return null; }
const secs = (n) => (Number.isFinite(+n) ? (+n).toFixed(+n % 1 ? 1 : 0) + ' s' : '?');

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
  if (r.status === 401 || r.status === 403) { lastError = problem(r); throw Object.assign(new Error(lastError), { auth: true }); }
  if (r.status === 404) return miss('nothing', 'Spicy Lyrics does not know this song');
  if (r.status !== 200 || !r.body || !r.body.Body) return miss('error', 'the search answered HTTP ' + r.status);
  lastError = '';
  const all = r.body.Body.results || [];
  if (!all.length) return miss('nothing', 'Spicy Lyrics does not know this song');
  const results = all.filter((x) => x.tier === 'exact' || x.tier === 'likely');
  if (!results.length) return miss('weak', all.length + ' result' + (all.length > 1 ? 's' : '') + ', none a close enough match (best rated “' + all[0].tier + '”)');
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
  // Spicy rates the song itself 'exact': another edition of it is often a few seconds longer (outro, silence), so allow more there.
  const tol = best.tier === 'exact' ? 8 : 4;
  if (want > 0 && best.d > 0 && Math.abs(best.d - want) > tol) return miss('duration', 'it knows the song, but its closest copy is ' + secs(best.d) + ' and yours is ' + secs(want)); // a different cut: its timings would be wrong
  return best.id;
}

function person(p) { return p && p.username ? { name: p.username, url: p.url || '' } : null; }

// Translation and romanisation of a line, when the source carries them (TranslatedText / TransliteratedText). A
// syllable-synced line may carry its romanisation only per syllable: then it is joined with TransliteratedIsPartOfWord.
const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : '');
function extras(el, syllables) {
  const out = {};
  const tr = str(el && el.TranslatedText);
  let ro = str(el && el.TransliteratedText);
  if (!ro && Array.isArray(syllables) && syllables.some((y) => str(y.TransliteratedText))) {
    ro = syllables.map((y) => String(y.TransliteratedText || y.Text || '') + ((y.TransliteratedIsPartOfWord != null ? y.TransliteratedIsPartOfWord : y.IsPartOfWord) ? '' : ' ')).join('').replace(/\s+/g, ' ').trim();
  }
  if (tr) out.tr = tr;
  if (ro) out.ro = ro;
  return out;
}
function flags(res) {
  if (res.lines.some((l) => l.tr)) res.hasTr = true;
  if (res.lines.some((l) => l.ro)) res.hasRo = true;
  return res;
}

function convert(env) {
  const b = env && env.Body;
  // Static (untimed) lyrics carry their lines in Lines, the timed ones in Content
  if (b && b.Type === 'Static' && Array.isArray(b.Lines) && !Array.isArray(b.Content)) b.Content = b.Lines;
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
      lines.push(Object.assign({ t, e, dur: Math.max(0.3, e - t), text: w.map((x) => x.text).join(' '), words: w, opp: !!line.OppositeAligned }, extras(lead, lead.Syllables)));
    }
    if (!lines.length) return null;
    return flags({ synced: true, wordSynced: true, lines, source: credit.source, credit });
  }
  if (b.Type === 'Line') {
    const lines = b.Content.filter((x) => x && typeof x.Text === 'string' && Number.isFinite(x.StartTime))
      .map((x) => Object.assign({ t: x.StartTime, e: x.EndTime, dur: Number.isFinite(x.EndTime) ? Math.max(0.3, x.EndTime - x.StartTime) : 0, text: x.Text.trim(), opp: !!x.OppositeAligned }, extras(x)));
    if (!lines.length) return null;
    return flags({ synced: true, lines, source: credit.source, credit });
  }
  const lines = b.Content.map((x) => Object.assign({ t: -1, text: String((x && (x.Text || x.text)) || '').trim() }, extras(x)));
  return lines.some((x) => x.text) ? flags({ synced: false, lines, source: credit.source, credit }) : null;
}

module.exports = {
  convert, // (for tests)
  lastError: () => lastError,
  lastMiss: () => lastMissInfo,
  /** Milliseconds until the API may be asked again (0 when it is fine). */
  pausedFor: () => Math.max(0, pausedUntil - Date.now()),
  /** Resolves to a lyrics result, or null when the API has none. Throws on key problems, rate limits and outages. */
  async find(media, key) {
    if (!key) return null;
    if (Date.now() < pausedUntil) throw new Error('Spicy Lyrics is paused for a moment (rate limit)');
    const title = String(media.title || '').trim(), artist = String(media.artist || '').trim();
    if (!title || !artist) return null;
    lastMissInfo = { kind: '', text: '' };
    const id = await findTrackId({ title, artist, album: String(media.album || '').trim(), duration: media.duration || 0 }, key);
    if (!id) return null;
    const r = await call('/v1/lyrics/' + encodeURIComponent(id), key);
    if (r.status === 404) return miss('nolyrics', 'it knows the song, but has no lyrics for it');
    if (r.status === 429 || r.status === 503 || r.status >= 500) { pausedUntil = Date.now() + Math.max(30, r.retryAfter || 60) * 1000; throw new Error(problem(r)); }
    if (r.status === 401 || r.status === 403) { lastError = problem(r); throw Object.assign(new Error(lastError), { auth: true }); }
    if (r.status !== 200) return miss('error', 'the lyrics answered HTTP ' + r.status);
    lastError = '';
    return convert(r.body) || miss('nolyrics', 'its lyrics came back empty');
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
