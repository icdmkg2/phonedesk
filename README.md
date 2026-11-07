# PhoneDesk

Turn an old Android phone (built and tuned for a Samsung Galaxy A11) into a fast desk display for your Windows PC: now playing with album art, media controls, volume, a clock, PC stats, and a pad of shortcut buttons.

It's a lighter take on the DeskThing idea.

## Start it

Double-click **`start.bat`**. The first run installs what it needs, then the dashboard opens in your browser at http://localhost:8765.

You need **Node.js 18 or newer** (https://nodejs.org).

To start PhoneDesk with Windows and no console window: press `Win+R`, type `shell:startup`, and put a shortcut to `start-hidden.vbs` in that folder.

## Connect the phone

**USB (recommended)**
1. On the phone: Settings → About phone → Software information → tap *Build number* 7 times.
2. Settings → Developer options → turn on **USB debugging**.
3. Plug the phone in and accept the "Allow USB debugging" prompt.

PhoneDesk links the phone and opens itself on the phone's browser. If ADB isn't installed, the dashboard has a button that downloads it from Google.

**Wi-Fi**
Scan the QR code on the dashboard, or type the address it shows into the phone's browser. Both devices must be on the same network. If it won't connect, allow Node.js through Windows Firewall on **Private** networks.

On the phone, tap the ⤢ button in the corner for full screen, or use Chrome's menu → *Add to Home screen*.

## Why it's lighter than DeskThing

| | DeskThing | PhoneDesk |
|---|---|---|
| PC app | Electron (a whole Chromium) | One small Node process, with the dashboard in your normal browser |
| If media reading breaks | Can take the app down | Runs in its own helper process that restarts itself; the server keeps going |
| Phone UI | React app | Plain JS and CSS, about 45 KB total, no framework |
| Progress bar | Re-rendered by JS | One CSS transition per track change, run by the GPU |
| Album art | Sent over the socket | Cached URL, downloaded once per track |
| Connection drops | Often needs a restart | Reconnects with backoff, detects dead sockets, resumes on screen wake |

Other things that keep it fast on old phones:
- Only the visible screen does any work. The clock ticks only while it's on screen.
- No blur, backdrop filters or large shadows.
- Volume drags are throttled, and play/pause flips the icon instantly before the PC confirms.

## Shortcuts

In the dashboard, open the **Shortcuts** tab. Each button can do one of three things:
- **Press keys**, such as `ctrl+shift+m`, `win+d`, `alt+f4`, `f5` or `medianext`
- **Open a link**, either a web page or an app link like `spotify:` or `discord://`
- **Start an app**, using a full path to an `.exe`

## Files

```
server/index.js        HTTP + WebSocket server, API for the dashboard
server/bridge-win.ps1  Windows media (SMTC), volume and key presses; its own process
server/bridge.js       Restarts the bridge if it crashes or hangs
server/adb.js          USB auto-connect (adb reverse)
public/phone/          The phone app
public/dashboard/      The PC dashboard
data/config.json       Your settings (created on first run)
```

## Notes

- Media info comes from Windows' media controls, so Spotify, browsers (YouTube etc.), Media Player and most music apps work.
- Changing settings or the dashboard API only works from the PC itself. Anyone on your network who opens the phone page can control playback and press your shortcut buttons.
- Browsers only allow wake lock on secure origins. Over USB the phone uses `localhost`, which counts as secure, so the screen stays on. Over Wi-Fi, turn on Developer options → *Stay awake*.
