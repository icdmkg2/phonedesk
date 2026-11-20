'use strict';
// LRC parsing (LRCLIB).   node test/lyrics.test.js
const assert = require('assert');
process.env.PHONEDESK_DATA = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'pd-lyr-'));
const lyrics = require('../server/lyrics');
const { parseLrc } = lyrics;
const spicy = require('../server/spicylyrics');
let failed = false;
function t(name, fn) { try { fn(); console.log('ok   ' + name); } catch (e) { failed = true; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); } }

t('lines are read with their times and sorted', () => {
  assert.deepStrictEqual(parseLrc('[00:12.50]b\n[00:10.00]a'), [{ t: 10, text: 'a' }, { t: 12.5, text: 'b' }]);
});
t('a line with several times appears at each of them', () => {
  assert.deepStrictEqual(parseLrc('[00:01.00][00:05.00]x').map((l) => l.t), [1, 5]);
});
t('an [offset:] tag moves every line (positive is earlier)', () => {
  assert.deepStrictEqual(parseLrc('[offset:+500]\n[00:10.00]a').map((l) => l.t), [9.5]);
  assert.deepStrictEqual(parseLrc('[offset:-250]\n[00:10.00]a').map((l) => l.t), [10.25]);
});
t('nothing goes before the start of the song', () => {
  assert.deepStrictEqual(parseLrc('[offset:2000]\n[00:01.00]a').map((l) => l.t), [0]);
});

t('a version of a different length (a music video) gives only its words, not wrong timings', () => {
  const lyrics = require('../server/lyrics');
  const song = { duration: 200, syncedLyrics: '[00:10.00]One\n[00:20.00]Two', plainLyrics: 'One\nTwo' };
  const timed = lyrics.pick([song], 202);
  assert.ok(timed.syncedLyrics, 'within 6 s: the timings are kept');
  const video = lyrics.pick([song], 210);
  assert.strictEqual(video.syncedLyrics, null, '10 s longer: no timings');
  assert.strictEqual(video.plainLyrics, 'One\nTwo');
  const noPlain = lyrics.pick([{ duration: 200, syncedLyrics: '[00:10.00]One\n[00:20.00]Two' }], 191);
  assert.strictEqual(noPlain.plainLyrics, 'One\nTwo', 'the words come from the timed text when there is no plain text');
  assert.strictEqual(lyrics.pick([song], 230), null, 'half a minute off: not this song');
});

// ---------------------------------------------------------------- which copy, and in which order (network stubbed)
let chain = Promise.resolve(); // these share the fake network, so they run one after another
function ta(name, fn) { chain = chain.then(async () => { try { await fn(); console.log('ok   ' + name); } catch (e) { failed = true; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); } }); }
const lrc = (...times) => times.map((t, i) => '[' + String(Math.floor(t / 60)).padStart(2, '0') + ':' + (t % 60).toFixed(2).padStart(5, '0') + ']line number ' + (i + 1) + ' of the song').join('\n');
const copy = (id, dur, shift, extra) => Object.assign({ id, duration: dur, albumName: 'Album ' + id, syncedLyrics: lrc(10 + shift, 14 + shift, 18 + shift, 22 + shift, 26 + shift, 30 + shift), plainLyrics: 'x' }, extra || {});
const realFetch = global.fetch;
function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const body = handler(String(url));
    if (body === undefined || body === null) return { status: 404, ok: false, json: async () => null, headers: { get: () => null } };
    return { status: 200, ok: true, json: async () => body, headers: { get: () => null } };
  };
  return calls;
}

t('the copy most uploaders agree with wins over an outlier, even one from the playing album', () => {
  const list = [copy(1, 200, 2.1, { albumName: 'Playing Album' }), copy(2, 200, 0), copy(3, 200, 0.2), copy(4, 200, -0.1)];
  assert.strictEqual(lyrics.bestSynced(list, 200, 'Playing Album').id !== 1, true, 'the copy that is two seconds late loses');
});
t('the copy from the playing album wins when it agrees with the others', () => {
  const list = [copy(1, 200, 0), copy(2, 200, 0.1, { albumName: 'Playing Album' }), copy(3, 200, 0.2)];
  assert.strictEqual(lyrics.bestSynced(list, 200, 'Playing Album').id, 2);
});
t('a copy of the right length beats a shorter one that more copies share', () => {
  const list = [copy(1, 201, 0), copy(2, 201, 0), copy(3, 201, 0), copy(4, 204, 1.0)];
  assert.strictEqual(lyrics.bestSynced(list, 203.8, '').id, 4, 'only the 204 s copy is this recording');
});
t('a copy whose lines run past the end of the song is not this recording', () => {
  const longer = copy(1, 200, 0, { syncedLyrics: lrc(10, 20, 30, 150, 260) });
  assert.strictEqual(lyrics.bestSynced([longer], 200, ''), null);
});
t('the first of several artists', () => {
  assert.strictEqual(lyrics.firstArtist('Calvin Harris, Dua Lipa'), 'Calvin Harris');
  assert.strictEqual(lyrics.firstArtist('Drake & Future'), 'Drake');
  assert.strictEqual(lyrics.firstArtist('Adele'), 'Adele');
});

ta('timed lyrics from another copy beat a plain-only exact match', async () => {
  const plainExact = { id: 10, duration: 200, albumName: 'Playing Album', plainLyrics: 'a\nb\nc', syncedLyrics: null };
  stubFetch((u) => (u.includes('/api/get') ? plainExact : u.includes('/api/search') ? [plainExact, copy(11, 201, 0)] : null));
  const r = await lyrics.lookup('Band', 'Song One', 'Playing Album', 200);
  global.fetch = realFetch;
  assert.strictEqual(r.synced, true, 'the timed copy is used, not the plain words');
});
ta('a song with several artists is found under the first one', async () => {
  const calls = stubFetch((u) => {
    const q = new URL(u).searchParams;
    if (u.includes('/api/search') && q.get('artist_name') === 'Calvin Harris') return [copy(20, 215, 0)];
    return u.includes('/api/search') ? [] : null;
  });
  const r = await lyrics.lookup('Calvin Harris, Dua Lipa', 'One Kiss', '', 215);
  global.fetch = realFetch;
  assert.ok(r && r.synced, 'found with the first artist');
  assert.ok(calls.some((c) => c.includes('artist_name=Calvin+Harris&')), 'it asked for the first artist');
});

ta('Spicy Lyrics is asked first, and LRCLIB is not asked when it has the song', async () => {
  const calls = stubFetch(() => [copy(30, 200, 0)]);
  const orig = spicy.find; let asked = 0;
  spicy.find = async () => { asked++; return { synced: true, wordSynced: true, lines: [{ t: 1, text: 'hi' }], source: 'apple_music', credit: { provider: 'Apple Music', source: 'apple_music' } }; };
  const r = await lyrics.find({ title: 'Spicy Song A', artist: 'Band', album: 'A', duration: 200 }, { spicyKey: 'sl_sk_aaaaaaaaaaaa' });
  spicy.find = orig; global.fetch = realFetch;
  assert.strictEqual(asked, 1);
  assert.strictEqual(r.credit.provider, 'Apple Music');
  assert.strictEqual(calls.length, 0, 'LRCLIB was not asked');
});
ta('LRCLIB follows when Spicy Lyrics has nothing', async () => {
  stubFetch((u) => (u.includes('/api/search') ? [copy(31, 200, 0)] : copy(31, 200, 0)));
  const orig = spicy.find; spicy.find = async () => null;
  const r = await lyrics.find({ title: 'Spicy Song B', artist: 'Band', album: 'B', duration: 200 }, { spicyKey: 'sl_sk_aaaaaaaaaaaa' });
  spicy.find = orig; global.fetch = realFetch;
  assert.strictEqual(r.credit.provider, 'LRCLIB');
  assert.strictEqual(r.retryMs, undefined, 'no retry: Spicy Lyrics simply does not have it');
});
ta('Spicy Lyrics is tried with the first artist, then the title exactly as the player gave it', async () => {
  stubFetch(() => null);
  const orig = spicy.find; const seen = [];
  spicy.find = async (m) => { seen.push(m.artist + ' | ' + m.title); return m.artist === 'Calvin Harris, Dua Lipa' && m.title === 'One Kiss (with Dua Lipa)' ? { synced: true, lines: [{ t: 1, text: 'x' }], credit: { provider: 'Spotify', source: 'spotify' } } : null; };
  const r = await lyrics.find({ title: 'One Kiss (with Dua Lipa)', artist: 'Calvin Harris, Dua Lipa', album: '', duration: 214 }, { spicyKey: 'sl_sk_aaaaaaaaaaaa' });
  spicy.find = orig; global.fetch = realFetch;
  assert.ok(r && r.credit.provider === 'Spotify', 'found on a later spelling (' + seen.join(' ; ') + ')');
  assert.ok(seen.length <= 3, 'no more than three requests');
});
ta('LRCLIB fills in when Spicy Lyrics is down, with a hint to ask again; a wrong key gives no hint', async () => {
  stubFetch((u) => (u.includes('/api/search') ? [copy(32, 200, 0)] : copy(32, 200, 0)));
  const orig = spicy.find;
  spicy.find = async () => { throw new Error('HTTP 503'); };
  const down = await lyrics.find({ title: 'Spicy Song C', artist: 'Band', album: 'C', duration: 200 }, { spicyKey: 'sl_sk_aaaaaaaaaaaa' });
  spicy.find = async () => { throw Object.assign(new Error('bad key'), { auth: true }); };
  const bad = await lyrics.find({ title: 'Spicy Song D', artist: 'Band', album: 'D', duration: 200 }, { spicyKey: 'sl_sk_aaaaaaaaaaaa' });
  spicy.find = orig; global.fetch = realFetch;
  assert.ok(down.retryMs >= 30000, 'asks again in at least 30 s');
  assert.strictEqual(bad.retryMs, undefined, 'a wrong key does not fix itself');
});

// ---------------------------------------------------------------- "why LRCLIB?": what each source said (real Spicy client, fake network)
const KEY = 'sl_sk_aaaaaaaaaaaa';
// ---------------------------------------------------------------- translations and romanisations (shapes from the API's OpenAPI spec)
t('Spicy line lyrics keep a translation and a romanisation per line', () => {
  const r = spicy.convert({ Body: { Type: 'Line', source: 'musixmatch', Content: [
    { Type: 'Vocal', Text: '君の名は', StartTime: 1, EndTime: 3, TranslatedText: 'Your name', TransliteratedText: 'kimi no na wa' },
    { Type: 'Vocal', Text: 'hello', StartTime: 4, EndTime: 5 },
  ] } });
  assert.strictEqual(r.lines[0].tr, 'Your name');
  assert.strictEqual(r.lines[0].ro, 'kimi no na wa');
  assert.ok(!r.lines[1].tr && !r.lines[1].ro);
  assert.ok(r.hasTr && r.hasRo);
});
t('a syllable-synced line with the romanisation only on its syllables is joined into one line', () => {
  const r = spicy.convert({ Body: { Type: 'Syllable', source: 'apple_music', Content: [{ Type: 'Vocal', Lead: { StartTime: 1, EndTime: 3, Syllables: [
    { Text: '사', StartTime: 1, EndTime: 1.5, IsPartOfWord: true, TransliteratedText: 'sa', TransliteratedIsPartOfWord: true },
    { Text: '랑', StartTime: 1.5, EndTime: 2, IsPartOfWord: false, TransliteratedText: 'rang', TransliteratedIsPartOfWord: false },
    { Text: '해', StartTime: 2, EndTime: 3, IsPartOfWord: false, TransliteratedText: 'hae' },
  ] } }] } });
  assert.strictEqual(r.lines[0].ro, 'sarang hae');
  assert.ok(r.hasRo && !r.hasTr);
});
t('untimed Spicy lyrics come in Lines (not Content) and are no longer dropped', () => {
  const r = spicy.convert({ Body: { Type: 'Static', source: 'musixmatch', Lines: [{ Text: 'one' }, { Text: 'two', TranslatedText: 'deux' }] } });
  assert.ok(r && !r.synced);
  assert.deepStrictEqual(r.lines.map((l) => l.text), ['one', 'two']);
  assert.strictEqual(r.lines[1].tr, 'deux');
});

const spicySearch = (results) => (u) => (u.includes('api.spicylyrics.org/v1/tracks/search') ? { Body: { results } } : u.includes('/api/search') ? [copy(40, 200, 0)] : u.includes('/api/get') ? copy(40, 200, 0) : null);

ta('a song Spicy knows only at another length is explained, and not searched again under other spellings', async () => {
  const calls = stubFetch(spicySearch([{ id: 'abc', tier: 'exact', duration: 213, variants: [] }]));
  const r = await lyrics.find({ title: 'Why Song A', artist: 'Band, Other', album: 'A', duration: 204 }, { spicyKey: KEY });
  global.fetch = realFetch;
  assert.strictEqual(r.credit.provider, 'LRCLIB');
  const why = r.trace.join(' | ');
  assert.match(why, /Spicy Lyrics: no match.*it knows the song, but its closest copy is 213 s and yours is 204 s/, why);
  assert.match(why, /LRCLIB: timed copy/, why);
  assert.strictEqual(calls.filter((c) => c.includes('/v1/tracks/search')).length, 1, 'a different length stays different: one search');
});
ta('an exact match whose length is a few seconds off (an edition of the same song) is still taken from Spicy', async () => {
  const body = { Body: { Type: 'Line', source: 'apple_music', Content: [{ StartTime: 1, EndTime: 3, Text: 'hola' }] } };
  stubFetch((u) => (u.includes('/v1/tracks/search') ? { Body: { results: [{ id: 'ed1', tier: 'exact', duration: 194.4, variants: [] }] } } : u.includes('/v1/lyrics/') ? body : null));
  const r = await lyrics.find({ title: 'Why Song G', artist: 'Band', album: 'G', duration: 189.6 }, { spicyKey: KEY });
  global.fetch = realFetch;
  assert.strictEqual(r.credit.provider, 'Apple Music');
});
ta('a song Spicy does not know is tried under other spellings, and said so', async () => {
  const calls = stubFetch(spicySearch([]));
  const r = await lyrics.find({ title: 'Why Song B', artist: 'Band, Other', album: 'B', duration: 200 }, { spicyKey: KEY });
  global.fetch = realFetch;
  assert.match(r.trace.join(' | '), /does not know this song/);
  const n = calls.filter((c) => c.includes('/v1/tracks/search')).length;
  assert.ok(n >= 2 && n <= 3, 'more than one spelling, three at most (' + n + ')');
});
ta('only weak matches are explained too', async () => {
  stubFetch(spicySearch([{ id: 'zzz', tier: 'possible', duration: 200 }]));
  const r = await lyrics.find({ title: 'Why Song C', artist: 'Band', album: 'C', duration: 200 }, { spicyKey: KEY });
  global.fetch = realFetch;
  assert.match(r.trace.join(' | '), /none a close enough match \(best rated “possible”\)/);
});
ta('no key saved, and a key that was thrown away, say so', async () => {
  stubFetch(spicySearch([]));
  const none = await lyrics.find({ title: 'Why Song D', artist: 'Band', album: 'D', duration: 200 }, { spicyKey: '' });
  const bad = await lyrics.find({ title: 'Why Song E', artist: 'Band', album: 'E', duration: 200 }, { spicyKey: '', spicyKeyBad: true });
  global.fetch = realFetch;
  assert.match(none.trace[0], /no key is saved/);
  assert.match(bad.trace[0], /saved key was rejected/);
});
ta('when Spicy Lyrics has the song, the trace says so and LRCLIB is not asked', async () => {
  const body = { Body: { Type: 'Line', source: 'apple_music', Content: [{ StartTime: 1, EndTime: 3, Text: 'hello' }] } };
  const calls = stubFetch((u) => (u.includes('/v1/tracks/search') ? { Body: { results: [{ id: 'ok1', tier: 'exact', duration: 200, variants: [] }] } } : u.includes('/v1/lyrics/') ? body : null));
  const r = await lyrics.find({ title: 'Why Song F', artist: 'Band', album: 'F', duration: 200 }, { spicyKey: KEY });
  global.fetch = realFetch;
  assert.strictEqual(r.credit.provider, 'Apple Music');
  assert.match(r.trace.join(' | '), /Spicy Lyrics: found, from Apple Music/);
  assert.strictEqual(calls.filter((c) => c.includes('lrclib.net')).length, 0);
});

chain.then(() => {
  require('fs').rmSync(process.env.PHONEDESK_DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
