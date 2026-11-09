# The API

Two sides, joined by messages: the **screen** on the phone, and the **server** on the PC.

    phone screen  ⇄  PhoneDesk on the phone  ⇄  PhoneDesk on the PC  ⇄  your server.js

You do not need a server. A screen can run on its own with the phone's data (the playing track, the volume).

## The screen (phone side)

Your screen is an HTML page. Load the SDK with one line:

    <script src="/addons/sdk.js"></script>

It runs in a sandboxed frame: it can not reach the rest of PhoneDesk, it has no storage that outlives the page, and it can not make network requests. Everything goes through the `PD` object.

- `PD.on('ready', fn)`: connected. `PD.permissions`, `PD.theme` and `PD.id` are set.
- `PD.on('message', fn)`: data your server sent with `pd.screen.send(data)`.
- `PD.send(data)`: data for your server (its `pd.screen.on` handler).
- `PD.on('media', fn)`, `PD.on('volume', fn)`, `PD.on('stats', fn)`: the current state and every change, **if** your manifest asks for `media`, `volume` or `stats`. Only while your screen is showing.
- `PD.on('visible', fn)`: `true` when your screen is swiped to, `false` when it is swiped away.
- `PD.media.command('toggle' | 'play' | 'pause' | 'next' | 'prev')` and `PD.volume.set(0 to 1)`: need `control`.
- `PD.captureSwipe(true)`: keep horizontal swipes for your screen (they normally change the page).

**Look.** PhoneDesk's colours arrive as CSS variables on `<html>`: `--bg`, `--fg`, `--fg2`, `--fg3`, `--card`, `--line`, `--accent`, `--radius`. Use them and your screen follows the user's theme and accent. Keep your content clear of `var(--safe-top)` (44px: the battery pill and full-screen button) and `var(--safe-bottom)` (30px: the page dots). The phone is usually in landscape; use `vh` and `vw` units and test at 960 by 444.

**Files.** Your screen can load its own files (scripts, styles, images, fonts, audio) from the package. It can not load anything from the internet.

## Widgets

A widget is a page like a screen, but small, and sitting on a page next to other widgets. Load the same SDK. What is different:

- `PD.widget` is `{ id, instance, w, h }`: which widget this is, and its size in pixels. `PD.on('resize', fn)` runs when the size changes (a person resized it, or the phone turned). Draw for the size you are given.
- `PD.options` holds the options the person set in the layout editor, as listed in your manifest.
- Several widgets (and the screen) of one addon can be on the phone at the same time. They share one PC-side `server.js`. Everything your server sends with `pd.screen.send(data)` reaches **all** of them, so put a `type` in your messages. Messages from a widget arrive in `pd.screen.on((msg, from) => ...)` with `from = { widget: 'timer' }`; from the screen `from` is empty.
- Media, volume and stats events (with the permissions) reach a widget while its page is showing. `PD.on('visible', fn)` tells you when the page is shown or hidden.
- Give your widget a card look that matches PhoneDesk, or none, as suits it: the frame is transparent. The colours come as CSS variables, like on a screen.
- Taps work as usual. A horizontal swipe on your widget changes the page, unless you call `PD.captureSwipe(true)`.

A widget with no `server` is fine: a clock face, a timer or a counter can run entirely on the phone.

## The server (PC side)

`server.js` exports one function. PhoneDesk calls it with a `pd` object when the addon starts:

    module.exports = (pd) => {
      pd.screen.on((msg) => { if (msg.type === 'hello') pd.screen.send({ type: 'hi' }); });
    };

It runs in its own Node process, started again if it crashes (five times in five minutes at most). Output goes to PhoneDesk's activity log.

- `pd.screen.send(data)`: send JSON to the screen and the widgets of this addon on every connected phone. Up to 64 KB, 30 messages a second.
- `pd.screen.on(fn)`: receive what the screen sent with `PD.send`.
- `pd.settings.get(key, fallback)` and `pd.settings.all()`: the values people set. `pd.on('settings', fn)` runs when they change.
- `pd.storage.get(key, fallback)`, `.set(key, value)`, `.delete(key)`, `.all()`: your own saved data (JSON, up to 1 MB), kept between runs.
- `pd.on('media' | 'volume' | 'stats', fn)`: events, if you have the permission.
- `pd.action(id, fn)`: run when a shortcut button using your action is pressed (declare it in `actions` in the manifest).
- `pd.on('stop', fn)`: PhoneDesk is stopping your addon (the person turned it off, or PhoneDesk is closing).
- `pd.log.info(...)`, `.warn(...)`, `.error(...)`.

Calls that need a permission return a promise and fail with a clear message if it was not granted:

- `pd.http.request({ url, method, headers, body })` resolves with `{ status, ok, headers, text }`; `pd.http.get(url)` and `pd.http.json(url)` are shortcuts. Needs `network:<host>`. Redirects are followed only to hosts you may contact. Responses are limited to 2 MB, requests time out after 15 seconds.
- `pd.media.get()`, `pd.volume.get()`, `pd.stats.get()`: need `media`, `volume`, `stats`.
- `pd.media.command(cmd)` and `pd.volume.set(v)`: need `control`.
- `pd.keys.send('ctrl+shift+m')`: needs `keys`. Key names are the ones shortcut buttons use.
- `pd.run.exec(file, args)` resolves with `{ code, stdout, stderr }`: needs `run`. No shell; 30 seconds at most.

**What is not available.** Your server can not use `fetch`, `net`, `http`, `child_process` or similar modules; it gets a clear error. It can read its own folder and write only to its data folder. Use the calls above instead.

## Testing

`node tools/pd-addon.js dev . --watch` loads your addon into the PhoneDesk running on this PC and reloads it when you save. It shows up on the Addons page as "loaded from a folder". Test the screen at the real size: open `http://localhost:8765/phone` in a browser window about 960 by 444.
