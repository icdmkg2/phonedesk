'use strict';
// LRC parsing (LRCLIB).   node test/lyrics.test.js
const assert = require('assert');
process.env.PHONEDESK_DATA = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'pd-lyr-'));
const { parseLrc } = require('../server/lyrics');
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

require('fs').rmSync(process.env.PHONEDESK_DATA, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
