# The manifest

`addon.json` describes the addon. PhoneDesk reads it before anything else, and refuses an addon whose manifest is wrong. `node tools/pd-addon.js validate` tells you what to fix.

    {
      "id": "pomodoro",
      "name": "Pomodoro timer",
      "version": "1.0.0",
      "description": "A big focus timer on the phone.",
      "author": "PhoneDesk",
      "homepage": "https://github.com/you/pomodoro",
      "phonedesk": "1.9.0",
      "permissions": ["network:lan"],
      "screen": { "title": "Timer", "entry": "screen/index.html", "icon": "bolt" },
      "server": "server.js",
      "widgets": [{ "id": "timer", "title": "Focus timer", "entry": "widget/index.html", "minW": 3, "minH": 2, "defW": 4, "defH": 3 }],
      "actions": [{ "id": "start", "label": "Start a timer" }],
      "settings": [{ "key": "focusMinutes", "label": "Focus (minutes)", "type": "number", "default": 25 }]
    }

## Fields

- **id** (required): 2 to 40 characters: lower-case letters, numbers and dashes. It names the addon for good: it is the folder it installs in and the key of its saved data. Pick it once.
- **name** (required): up to 40 characters, shown to people.
- **version** (required): three numbers, like `1.2.0`. Raise it for every release. PhoneDesk will not install an older version over a newer one.
- **description** (required): one sentence, up to 200 characters.
- **author** (required): up to 60 characters.
- **homepage**: an `https://` link to the addon's page or repository.
- **phonedesk**: the oldest PhoneDesk version the addon needs, like `1.9.0`. It is the default and the lowest allowed.
- **permissions**: what the addon is allowed to do. See below. An addon with none can still draw a screen and use its own saved data.
- **screen**: the phone screen. `title` (up to 24 characters, shown in the page list), `entry` (an `.html` file in the package), `icon` (one of `mic desktop lock camera music play chart folder bolt globe game code chat power vol next`).
- **widgets**: widgets people can place on their pages. See below.
- **server**: the PC-side code, a `.js` file in the package.
- **actions**: shortcut actions the server provides. Each has an `id` (like `volume-up`) and a `label`. Needs a `server`; register each with `pd.action(id, fn)`.
- **settings**: values people set in the PhoneDesk window. See below.

An addon needs a `screen`, a `server`, `widgets`, or any mix of them.

## Permissions

Every permission is shown to the person installing, in plain words, and has to be approved as a whole. The PC-side API checks it on every call.

- `media`: read what is playing (title, artist, app)
- `volume`: read the PC's volume and mute state
- `stats`: read CPU, memory and GPU use
- `weather`: read the weather and forecast PhoneDesk shows
- `calendar`: read your upcoming calendar events
- `notifications`: read the PC notifications PhoneDesk shows (app, title and text)
- `control`: start, pause and skip playback, and set the volume
- `keys`: press keys on the PC. **Powerful**: a key press can do almost anything the person could.
- `run`: run programs on the PC. **Powerful.**
- `network:<host>`: talk to one host, like `network:api.example.com`, or all hosts under a domain, like `network:*.example.com`. **Powerful.**
- `network:lan`: talk to devices on the home network: addresses like `192.168.x.x`, `10.x.x.x`, `172.16.x.x` to `172.31.x.x`, `localhost`, and names ending in `.local`. **Powerful.**

Ask for as little as you can. People read this list, and reviewers will ask why anything on it is there. An update that asks for a new permission is not installed automatically; the person has to approve it.

## Widgets

People arrange **pages** in the PhoneDesk window: a grid of 12 columns by 6 rows that they fill with widgets (the built-in ones, and yours). A page becomes one more screen in the phone's swipe row. Each widget you list shows up in the editor's palette under your addon's name.

Each entry in `widgets` has:

- **id** (required): like `timer`; lower-case letters, numbers and dashes.
- **title**: up to 24 characters, shown in the palette and on the widget's outline.
- **description**: up to 120 characters.
- **entry**: an `.html` file in the package (default `widget/index.html`).
- **minW**, **minH**: the smallest size in grid cells (defaults 2 and 1). People can not make it smaller.
- **defW**, **defH**: the size it starts with (never below the minimum).
- **options**: fields people set per widget, like settings: `key`, `label`, `type` (`text`, `number`, `boolean`, `select`), and optionally `default`, `min`, `max`, `options`, `placeholder`. Your widget reads them from `PD.options`.

A widget is a small web page in the same sandbox as an addon screen, with the same SDK and the same permissions. The same widget can be placed on several pages, each with its own options. See [the API](api.md#widgets).

## Settings

Each setting has a `key` (a camelCase name), a `label`, and a `type`: `text`, `password`, `number`, `boolean` or `select` (with an `options` list). Optional: `default`, `placeholder`, `hint`.

People fill them in on the Addons page of the PhoneDesk window. Your PC-side code reads them with `pd.settings.get('key')`. A `password` is stored on the PC and never sent to the phone or shown again; your screen can not read settings at all, so send your screen whatever it needs from the server.
