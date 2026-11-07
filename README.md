# PhoneDesk

Turn an old Android phone (built and tuned for a Samsung Galaxy A11) into a fast desk display for your Windows PC: now playing with album art, media controls, volume, a clock, PC stats, and a pad of shortcut buttons.

It's a lighter take on the DeskThing idea.

## Install

Run **`PhoneDesk-Setup-1.2.0.exe`**. It installs for your Windows account only and needs no admin rights. Node.js comes bundled, so you don't need to install it.

- PhoneDesk opens as its **own window** (it uses the Edge WebView2 engine that comes with Windows 11). Closing the window keeps PhoneDesk running in the **tray**, near the clock; click the tray icon to bring it back, right-click it for the menu.
- The window has: **Overview** (a live preview of what the phone shows, its connection, latency and battery), **Shortcuts** (edit the buttons by clicking them on a phone-shaped grid, record keys by pressing them), **Phone display** (theme, accent, clock, dimming, screens, battery icon, album-art lookup), **Connection** and **Activity**.
- It starts with Windows and runs quietly in the background. If the server ever crashes, the tray app restarts it.
- The installer offers to let phones on your Wi-Fi through Windows Firewall. That's the only step where Windows asks for permission.
- To update, run a newer setup. Your settings are kept.
- To uninstall, use Windows Settings → Apps → PhoneDesk.

Windows SmartScreen may warn about the setup because it isn't code-signed. Choose *More info → Run anyway*.

Settings are stored in `%APPDATA%\PhoneDesk`, and logs in `%APPDATA%\PhoneDesk\logs`.

### Run from source instead

Double-click **`start.bat`** (needs Node.js 18+). The dashboard opens at http://localhost:8765.

### Build the installer

```
powershell -ExecutionPolicy Bypass -File builduild.ps1
```

This writes `dist\PhoneDesk-Setup-<version>.exe`. It uses only the C# compiler that comes with Windows plus your installed Node.js, which it copies in as the bundled runtime.

## Connect the phone

**USB (recommended)**
1. On the phone: Settings → About phone → Software information → tap *Build number* 7 times.
2. Settings → Developer options → turn on **USB debugging**.
3. Plug the phone in and accept the "Allow USB debugging" prompt.

PhoneDesk links the phone and opens itself on the phone's browser. If ADB isn't installed, the dashboard has a button that downloads it from Google.

**Wi-Fi**
On the phone, open **http://phonedesk.local** in the browser, or scan the QR code on the dashboard. The phone must be on the same network as the PC.

`phonedesk.local` always points at the PC, even when the router gives it a new IP address. PhoneDesk announces the name on your local network (mDNS), so there's nothing to set up on the router. You can rename it in `config.json` (`"name"`) if you have more than one PC.

If the phone can't connect, right-click the tray icon and choose *Let phones on Wi-Fi connect…*.

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

## Phone on a charger (no cable to the PC)

- **Screen always on:** once the phone has been plugged in by USB with PhoneDesk running, Android's *Stay awake* setting is switched on. It stays on afterwards, so the screen never sleeps while the phone is charging.
- **Battery icon and auto-reopen over Wi-Fi:** turn on *Developer options → ADB over network* (LineageOS) or *Wireless debugging*. When the phone opens PhoneDesk over Wi-Fi, the PC links to it, shows its battery, keeps the screen on and reopens PhoneDesk on it after a restart. Accept the "Allow debugging" prompt once.

## Album art

PhoneDesk shows the picture the music app gives Windows (Spotify, Media Player, …). When an app gives none (YouTube in a browser), PhoneDesk looks the song up in the iTunes catalog by artist and title, and only uses a result whose artist matches. Turn it off in *Phone display → Extras*.

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
server/mdns.js         Answers "phonedesk.local" on the local network
server/artwork.js      Finds album art online when the app gives none
installer/Window.cs    The PhoneDesk window (WebView2)
installer/Tray.cs      PhoneDesk.exe: tray app, server supervisor, uninstaller
installer/Setup.cs     PhoneDesk-Setup.exe
build/build.ps1        Builds the installer
public/phone/          The phone app
public/dashboard/      The PC dashboard
data/config.json       Your settings when running from source (installed: %APPDATA%\PhoneDesk)
```

## Notes

- Media info comes from Windows' media controls, so Spotify, browsers (YouTube etc.), Media Player and most music apps work.
- Changing settings or the dashboard API only works from the PC itself. Anyone on your network who opens the phone page can control playback and press your shortcut buttons.
- Browsers only allow wake lock on secure origins. Over USB the phone uses `localhost`, which counts as secure, so the screen stays on. Over Wi-Fi, turn on Developer options → *Stay awake*.
