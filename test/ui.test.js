'use strict';
// Phone UI in a real browser (emulated touch): every screen can be swiped away from, a customized page keeps its
// widgets while it is edited, and the layout preview never goes blank.
//   node test/ui.test.js        needs Playwright and Chromium (CI installs them; without them this skips)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('skip  Playwright is not installed'); process.exit(0); }

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ui-'));
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ port: PORT, port80: false }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'content-type': 'application/json' };
const api = (u, body) => fetch(BASE + '/api/' + u, { method: body ? 'POST' : 'GET', headers: J, body: body && JSON.stringify(body) }).then((r) => r.json());

let failed = false;
async function t(name, fn) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { failed = true; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: Object.assign({}, process.env, { PHONEDESK_DATA: DATA }), stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/api/config'); break; } catch { await sleep(250); } }
    await api('pages/from-screen', { screen: 'clock' }); // a customized page in the swipe row too
    browser = await chromium.launch();

    for (const [label, W, H, land] of [['landscape', 800, 360, true], ['portrait', 360, 800, false]]) {
      await t(`${label}: a swipe leaves every screen, wherever it starts`, async () => {
        const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true, isMobile: true });
        const pg = await ctx.newPage();
        await pg.goto(BASE + '/phone/'); await sleep(2000);
        const cdp = await ctx.newCDPSession(pg);
        const cur = () => pg.evaluate(() => document.querySelector('.screen.on').getAttribute('data-screen'));
        // the swipe runs along the screen's long side; "cross" is where on the other axis it starts (0..1)
        const pt = (a, cross) => (land ? { x: W * a, y: H * cross } : { x: W * cross, y: H * (1 - a) });
        const drag = async (a0, a1, cross) => {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(a0, cross)] });
          for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(a0 + (a1 - a0) * i / 10, cross)] }); await sleep(16); }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(500);
        };
        const seen = new Set();
        // Every start point must work, except where a slider is (those keep their own drag on purpose).
        const onSlider = (c) => { const q = pt(0.8, c); return pg.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest('.slider, .track, iframe')); }, [q.x, q.y]); };
        for (let i = 0; i < 14; i++) {
          const s = await cur(); seen.add(s);
          for (const cross of [0.12, 0.5, 0.88]) {
            if (await onSlider(cross)) continue;
            const here = await cur();
            await drag(0.8, 0.2, cross);
            assert.notStrictEqual(await cur(), here, `a swipe starting at ${cross} did not leave "${here}"`);
            seen.add(await cur());
          }
        }
        assert.ok(seen.has('shortcuts'), 'the walk never reached Shortcuts: ' + [...seen]);
        assert.ok([...seen].some((s) => s.startsWith('page:')), 'the walk never reached the customized page: ' + [...seen]);
        await ctx.close();
      });
    }

    await t('editing a page keeps its widgets on screen in the preview', async () => {
      const pages = (await api('config')).pages;
      const p = pages[0];
      const ctx = await browser.newContext({ viewport: { width: 900, height: 420 } });
      const pg = await ctx.newPage();
      await pg.goto(BASE + '/phone/?preview=' + p.id); await sleep(2000);
      const count = () => pg.evaluate(() => document.querySelectorAll('.screen.on .wgrid > *').length);
      const before = await count();
      assert.ok(before > 0, 'the preview started empty');
      p.widgets[0].w = Math.max(2, p.widgets[0].w - 1);
      await api('config', { pages }); await sleep(1500);
      assert.ok((await count()) > 0, 'the preview went blank after an edit');
      p.widgets[0].h = Math.max(1, p.widgets[0].h - 1);
      await api('config', { pages }); await sleep(1500);
      assert.ok((await count()) > 0, 'the preview went blank after a second edit');
      await ctx.close();
    });

    await t('layout editor: add, duplicate, undo, redo, reset and snapping', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
      const pg = await ctx.newPage();
      await pg.goto(BASE + '/#layouts'); await sleep(1500);
      await pg.evaluate(() => { for (const id of ['onboard', 'whatsnew']) { const o = document.getElementById(id); if (o) o.remove(); } });
      const n = () => pg.locator('#ly-over > .lay-w').count();
      const settle = () => sleep(900);
      const start = await n();
      assert.ok(start > 1, 'expected the customized page to have widgets, got ' + start);
      // remove one so there is room, then add
      await pg.locator('#ly-over > .lay-w').last().click();
      await pg.click('#ly-rm'); await settle();
      assert.strictEqual(await n(), start - 1);
      await pg.click('#ly-undo'); await settle();
      assert.strictEqual(await n(), start, 'undo brings the removed widget back');
      await pg.click('#ly-redo'); await settle();
      assert.strictEqual(await n(), start - 1, 'redo removes it again');
      await pg.click('#ly-undo'); await settle();
      // duplicate (may say there is no room: free some space first)
      await pg.locator('#ly-over > .lay-w').last().click();
      await pg.click('#ly-rm'); await settle();
      await pg.locator('#ly-over > .lay-w').first().click();
      await pg.click('#ly-dup'); await settle();
      assert.ok(await n() >= start - 1, 'duplicate keeps the page populated');
      // the editor and the phone agree after the edits
      const saved = (await api('config')).pages[0].widgets.length;
      assert.strictEqual(saved, await n(), 'the saved page matches the editor');
      // dragging a widget onto another snaps it to free space instead of refusing, and nothing overlaps
      const a = await pg.locator('#ly-over > .lay-w').first().boundingBox();
      const z = await pg.locator('#ly-over > .lay-w').last().boundingBox();
      await pg.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await pg.mouse.down();
      await pg.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 10 }); await pg.mouse.up(); await settle();
      const ws = (await api('config')).pages[0].widgets;
      for (let i = 0; i < ws.length; i++) for (let k = i + 1; k < ws.length; k++) {
        const A = ws[i], B = ws[k];
        assert.ok(!(A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h), 'two widgets overlap after a drag');
      }
      // reset goes back to how the page was when the editor opened
      await pg.click('#ly-reset'); await settle();
      assert.strictEqual(await n(), start, 'reset restores the opening layout');
      assert.strictEqual((await api('config')).pages[0].widgets.length, start, 'reset is saved');
      await ctx.close();
    });

    await t('a scheduled screen is shown when its time window is open', async () => {
      const hm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      const now = Date.now();
      await api('config', { schedule: [{ from: hm(new Date(now - 60000)), to: hm(new Date(now + 3600000)), screen: 'stats' }] });
      const ctx = await browser.newContext({ viewport: { width: 800, height: 360 }, hasTouch: true, isMobile: true });
      const pg = await ctx.newPage();
      await pg.goto(BASE + '/phone/'); await sleep(2500);
      assert.strictEqual(await pg.evaluate(() => document.querySelector('.screen.on').getAttribute('data-screen')), 'stats');
      await api('config', { schedule: [] });
      await ctx.close();
    });

    await t('the built-in widgets draw: PC stats with graphs, Now playing with its source, and the Lyrics widget', async () => {
      const w = require('../server/widgets');
      const page = w.sanitizePages([{ name: 'Widgets', widgets: [
        { type: 'nowplaying', x: 0, y: 0, w: 5, h: 3 }, { type: 'lyrics', x: 5, y: 0, w: 7, h: 3 },
        { type: 'stats', x: 0, y: 3, w: 12, h: 3, opts: { metric: 'all' } },
      ] }])[0];
      const before = await api('config');
      await api('config', { pages: [...before.pages, page], screens: [...before.screens, 'page:' + page.id] });
      const ctx = await browser.newContext({ viewport: { width: 960, height: 444 } });
      // pretend the PC is playing a song and reporting stats
      await ctx.addInitScript(() => {
        const lines = ['one', 'two', 'Every little thing you said stayed with me', 'four'].map((text, i) => ({ t: i * 60, text }));
        const stats = (i) => ({ cpu: 20 + (i % 30), cores: 8, coresLoad: [10, 20, 30, 40, 50, 60, 70, 80], memUsed: 8e9, memTotal: 16e9, uptime: 1000, host: 'PC', gpu: { load: 40, temp: 60 }, net: { rx: 500000 + i * 1000, tx: 90000 } });
        const P = window.WebSocket;
        window.WebSocket = class extends P {
          constructor(u, p) {
            super(u, p);
            this.addEventListener('open', () => {
              const d = (m) => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) }));
              setTimeout(() => {
                d({ t: 'media', d: { active: true, title: 'A very long song title that cannot possibly fit in the box', artist: 'Someone', app: 'Spotify', status: 'Playing', position: 130, duration: 200, updated: Date.now() } });
                d({ t: 'lyrics', d: { synced: true, lines } });
                let i = 0; setInterval(() => d({ t: 'stats', d: stats(i++) }), 250); // keeps ahead of the real server's own (GPU-less) stats
              }, 300);
            });
          }
        };
      });
      await ctx.addInitScript((id) => { if (window === window.top) localStorage.setItem('pd.screen', JSON.stringify('page:' + id)); }, page.id);
      const pg = await ctx.newPage();
      const errors = []; pg.on('pageerror', (e) => errors.push(e.message));
      await pg.goto(BASE + '/phone/'); await sleep(3000);
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(await pg.locator('.wg-stats .st-t:not([hidden])').count(), 4, 'CPU, memory, GPU and network tiles: ' + await pg.evaluate(() => [...document.querySelectorAll('.wg-stats .st-t')].map((e) => e.className + (e.hidden ? ' hidden' : '')).join(' / ')));
      assert.ok(await pg.locator('.wg-stats .st-g .st-l[d^="M"]').count() >= 3, 'the graphs have lines');
      assert.match(await pg.locator('.wg-nowplaying .w-title').innerText(), /A very long song title/);
      assert.strictEqual((await pg.locator('.wg-nowplaying .w-srcn').innerText()).toLowerCase(), 'spotify');
      assert.ok(await pg.locator('.wg-nowplaying .w-title.run').count() === 1, 'a title that does not fit scrolls');
      assert.strictEqual(await pg.locator('.wg-lyrics .lw-c').innerText(), 'Every little thing you said stayed with me');
      // nothing is clipped: every widget's content fits inside its box
      const clipped = await pg.evaluate(() => [...document.querySelectorAll('.wgrid > .wg')].filter((e) => e.scrollHeight > e.clientHeight + 2).map((e) => e.className));
      assert.deepStrictEqual(clipped, [], 'content spills out of: ' + clipped);
      await ctx.close();
      await api('config', { pages: before.pages, screens: before.screens });
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
