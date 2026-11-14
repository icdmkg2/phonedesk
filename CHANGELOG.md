# Changelog

Every PhoneDesk version, newest first. Each version heading links to its page on
[GitHub Releases](https://github.com/icdmkg2/phonedesk/releases), where the installer is attached (newest version) and
the same notes are shown. Releases are published from this file by `.github/workflows/release.yml`.

Screenshots of interface changes are in [`docs/changelog/`](docs/changelog/). They were taken from each version as it
was released, with a made-up song (*Paper Lanterns* by *Harbor Lights*) and original placeholder lyrics.

## [1.14.1] — 2026-11-14

Synced lyrics and the song position keep time with Firefox and with music videos, and Zen shows its own name.

### Fixed

- **Skipping within a song in a Firefox-based browser no longer throws the lyrics back to the start.** After a skip,
  Zen and Firefox tell Windows the song is at 0:00 (with a fresh time stamp) and only send the real place after a pause
  and play. PhoneDesk keeps the lyrics going and shows “Skipped in the song? Pause and play to sync the lyrics” until the
  real place arrives; one pause and play in the browser puts the lyrics back in time.
- **Lyrics are found when a song starts in a Firefox-based browser.** The lyrics were looked up the moment a new song
  appeared, before the browser had said how long it is, so the exact lookup failed and nothing tried again; PhoneDesk now
  searches without the length at first and looks again (for the right version) as soon as the length is known.
- **No more coloured lines around the lyrics screen in the iOS style.** Burn-in protection moves the screens a few
  pixels now and then, which uncovered a sliver of the album wallpaper along the lyrics screen's edges; its background
  now reaches past them. In the iOS style with the Classic Now playing layout, the app name is a small pill again
  instead of a bar across the screen.
- In the PC window: drop-down lists were white with white text, so their choices looked empty; Find a setting only
  matches the start of words and its box and results look like Windows Settings; the expandable rows (“Install the
  phone app”, “How to set it up”) lost a stray line and open with a chevron on the right.
- **A new song no longer sits on its intro until you pause and play.** Firefox-based browsers often tell Windows a new
  song's length only after a pause; until then PhoneDesk held the position (and the lyrics) at the start, and when the
  length arrived it could jump back to the start. The song now runs from the first second either way.
- **Lyrics of music videos are no longer out of time.** A music video on YouTube Music is often a different length
  from the song (an intro, an outro), and PhoneDesk used to show the song's timed lyrics anyway, so every line came at
  the wrong moment. Lyrics from a version more than 6 seconds longer or shorter now show their words with estimated
  timing instead (like lyrics that have no timings), and the song and its video no longer share cached lyrics.
- **Zen and other Firefox-based browsers show their own name and icon** as the source, instead of a code like
  “F0DC299D809B9700”. These browsers name themselves to Windows by a code of their install folder; PhoneDesk now looks
  that code up to find the browser.
- **The song position and the lyrics no longer stay stuck at 0:00 with Firefox** (and Firefox-based browsers like Zen)
  playing YouTube Music or another site ([#14](https://github.com/icdmkg2/phonedesk/issues/14)). Firefox keeps telling
  Windows the song is at 0:00 while it plays and only sends the real position after a pause or a seek; PhoneDesk now
  keeps its own clock running through those reports instead of following them back to the start, and ignores a sudden
  jump back to 0:00 in the middle of a song. A real seek, previous or next still moves it at once.

## [1.14.0] — 2026-11-14

The PhoneDesk window now looks and works like Windows 11 Settings, and the phone has a Windows widget style.

### Added

- **Find a setting** in the PC window: a search box at the top of the sidebar (or Ctrl+F) finds any setting on any page;
  pick one and the page opens with that setting highlighted.

  ![Finding the night settings](docs/changelog/1.14.0/dashboard-find.png)

- **Quick toggles widget:** tap tiles for the PC like Windows quick settings: sound, microphone, Wi-Fi, Bluetooth and dark
  mode, each showing whether it is on. Choose which tiles it shows. A tile the PC can't control is shown dimmed.
- **Month calendar widget:** this month at a glance, today marked, with a dot for each event on a day (from the
  calendar in Phone display). Weeks can start on Monday or Sunday.
- **Weather details:** the Weather widget can show the next hours (with the chance of rain) and a line with how warm it
  feels, the chance of rain, the wind, sunrise and sunset. The 5-day forecast shows the chance of rain on wet days.

  ![The new widgets in the Windows style](docs/changelog/1.14.0/phone-new-widgets.png)

- **Windows widget style for the phone.** In Phone display, under Widget style, pick Windows: pages sit on a deep blue
  desktop with a soft blue bloom, and widgets are dark Mica-style cards with small corners and a thin light edge, in
  Windows blue, with the page dots in a small taskbar-style bar. Weather shows its place, the temperature, the sky and
  the next four days, like the Windows weather widget; World clock lists each place with how many hours ahead or
  behind it is, like the Windows Clock app; Forecast has a title row too. Classic stays the default; iOS is still there.

![A page in the Windows widget style](docs/changelog/1.14.0/phone-windows-style.png)

### Changed

- **The PC window looks like Windows 11 Settings.** A quiet dark window, a plain sidebar where the selected page is
  marked by a small blue bar, large page titles, Windows-style buttons, text boxes and switches, in Segoe UI.
- **Every page is one column of settings rows.** Each setting is a full-width row with its icon, name and description
  on the left and its switch or choice on the right, grouped under small headings:
  - Overview: your phone, Now playing with volume, PC stats, recent activity.
  - Phone display: Music, Look, Clock and calendar, Night and screen care, Notifications, Screens, Widgets, with the
    live preview at the top.
  - Layouts: the pages, then the page's settings, the editor, adding widgets and the selected widget.
  - Shortcuts, Addons, Connection (phones, connecting, USB, Spotify, Spicy Lyrics, Advanced), Updates and Activity.

![The Overview page of the PhoneDesk window](docs/changelog/1.14.0/dashboard-overview.png)

### Fixed

- The music note shown when a song has no album cover is redrawn as one solid note; it looked broken, with thin
  disconnected lines and seams on the newer styles.
- The pill that names the music app on the phone always has an icon now: the app's own icon from Windows, or a music
  note when Windows doesn't give one.
- The release workflow no longer fails when GitHub won't create a page for an older version that shipped inside a later one.

## [1.13.0] — 2026-11-13

An iOS-style look for your pages, and lyrics that stay in time.

### Added

- **iOS widget style, in Liquid Glass.** In Phone display, under Widget style, choose iOS: pages sit on a blurred copy of the album cover, and widgets become clear glass tiles with a bright edge that catches the light, so the wallpaper's colour shows through. Buttons and the page dots are glass too. Weather is coloured like the sky, PC stats and device batteries are rings, the world clock has analog faces, the calendar shows the date large, and Now playing takes the cover's colour. Classic stays the default.

- **Bluetooth devices widget** (was Device batteries): lists every Bluetooth device connected to the PC (headphones, mouse, keyboard, controller, phone) with an icon for each, and its battery when it reports one. Devices that don't report one show as Connected; an option hides them. It looks for new devices every 30 seconds.
- The iOS style also covers the built-in screens (stats, clock, shortcuts) and the top pills.
- **A new logo**: your PC and your phone side by side. It is the app icon on Windows and Android, the icon in the PC window and on the phone, and the website's favicon.

### Fixed

- **Lyrics from LRCLIB are in time.** LRCLIB gives only when each line starts, and PhoneDesk used to guess when each word inside it is sung, which drifted ahead of or behind the singer. Lines without word timings now light up whole, right when they start, on the Lyrics screen, in the kinetic style and in the Lyrics widget. Spicy Lyrics, which has the real timing of every word, still lights up word by word. LRC files with an `[offset:]` tag are now shifted by it.
- In the iOS style, each device's battery reading is centred in its ring (it sat low).

## [1.12.0] — 2026-11-12

Six new widgets, a layout you can rearrange on the phone, and more for addons.

### Added

- **New widgets:** World clock (up to four places), Timer and stopwatch, Notes (a to-do list you write in the PC window and tick off on the phone), Photo frame (pictures from a folder on your PC), Recently played, and Device batteries (Bluetooth headphones, mice and keyboards that report their battery to Windows).
- **PC stats:** the CPU temperature (when Windows or LibreHardwareMonitor provides it), a Disks view with free space on every drive, and a Busiest apps view.
- **Up next:** Now playing shows the next song when PhoneDesk is connected to Spotify.
- **Lyrics widget:** words light up as they are sung, like on the Lyrics screen.
- **Rearrange a page on the phone:** hold an empty spot (or a widget for a second), drag widgets to move them and their corner to resize them, then tap Done.
- **Long press:** a widget can do something when held (open a screen, press a shortcut, control the music), as well as when tapped.
- **Double-tap to play or pause** anywhere on the phone (turn it on in Phone display).
- **Widget style and page corners:** show a widget as a card, an outline or with no card at all; make a page's corners square, small or round.
- **Schedule night mode or a dim screen:** a Schedule time can now turn on night mode or dim the screen instead of showing a screen.
- **Addons:** new `weather`, `calendar` and `notifications` permissions with events on the phone and the PC side, and `PD.autoscale(w, h)` so a widget scales to any size. `pd-addon init <id> --widget` starts a widget-only addon set up that way.

### Fixed

- Unselected pages in the Layouts list no longer have a grey background.

## [1.11.1] — 2026-11-12

A fix for the Lyrics widget's timing.

### Fixed

- The Lyrics widget changes line on time. It used to look for the next line only four times a second, so a line could come in up to a quarter of a second late, and its fade-in made it feel later still. It now wakes up exactly when the next line starts, within a few milliseconds.
- The Lyrics widget no longer redraws (and flashes) the current line every time the PC sends its stats or the volume changes.

## [1.11.0] — 2026-11-10

Better widgets: they scale to any size, PC stats has graphs, Now playing is redone and there is a Lyrics widget.

### Added

- **PC stats shows everything.** The widget now shows CPU, memory, GPU and network together, each with a graph, laid out to fit the box. Choose *All* or a single metric (a single CPU adds a bar for every thread). Existing stats widgets keep their metric and gain the graph.
- **Lyrics widget.** The line being sung, with the lines before and after it when there is room. It follows the song and shows messages while lyrics load or when a song has none.
- **A Music page template**: Now playing, lyrics and the volume.

### Changed

- **Now playing is redone.** It shows the app the music plays in (Spotify, YouTube and so on), scrolls a long title instead of cutting it off, has smaller buttons and a progress bar, and changes its layout to fit: cover beside the text, cover above it, or a single compact row.
- **Widgets scale properly.** Every built-in widget is drawn at a reference size and scaled to the box it is given, so text and icons keep their proportions and nothing is clipped. The five-day forecast drops to icons and highs when it is only one row tall.
- In the layout editor, a widget's name only shows when you point at it or select it, so it no longer covers the preview.

## [1.10.0] — 2026-11-10

Easier updates, more control over pages, and tools for addon makers.

### Added

- **Updates have their own page.** An update shows as a *New* badge on Updates and an *Update available* button at the bottom of the sidebar. With *Download updates automatically* turned off, a new version waits as "available" until you press Download, and its release notes are shown in the page.
- **Layouts: undo and redo, duplicate, reset.** Ctrl+Z, Ctrl+Shift+Z and Ctrl+D work on the Layouts page. Reset goes back to how the page was when you opened the editor. A widget you drag onto another now snaps to the nearest free space (and a resize shrinks to fit) instead of being refused.
- **Tap actions.** A widget can open a screen, press a shortcut button or control the music when you tap it (set in *When tapped* in the widget's options).
- **Page backgrounds and accents.** Each page can have its own background (Black, Aurora, Dusk, Forest, Slate) and accent colour.
- **Schedule.** In Phone display, choose a screen to show during certain hours, such as the clock overnight. You can swipe away; the phone goes back when the time ends.
- **Addon log and health.** Addons > Log shows what an addon printed, how many messages it sent, how many were dropped, how fast its PC-side code answers and any slow request, with a Copy button for bug reports.
- Two new first-party addons: **Countdown** and **World clock** (widgets, no permissions). `pd-addon dev` now says where to find the addon on the phone.
- A browser test of the phone screens runs on every pull request: it swipes through every screen with touch and edits a page in the layout editor.

### Changed

- The sidebar is grouped: Overview, then Customize (Phone display, Layouts, Shortcuts, Addons), then System (Connection, Updates, Activity).
- A phone that still has an old copy of the screens (kept by its browser) now loads the current one when it connects to a newer PhoneDesk.

### Fixed

- Changing a page in Layouts no longer leaves the preview (and the phone, when it is on that page) empty. The page was rebuilt but never shown again, so its widgets disappeared until you switched screens.

## [1.9.3] — 2026-11-10

A fix for getting stuck on the Shortcuts screen.

### Fixed

- Swiping to another screen works again after you scroll or touch the Shortcuts screen. The browser was cancelling the swipe whenever it started on a shortcut button or on the scrolling pad, so the phone stayed on that screen. Swipes are now read from touch events on every screen.

## [1.9.2] — 2026-11-09

A fix for addon screens on the phone.

### Fixed
- **Stuck on an addon screen.** After swiping to an addon's screen on a touch screen, swiping no longer did anything, so
  the phone stayed on that screen. Swipes inside addon screens and addon widgets are now read from touch events and
  change the page as they do everywhere else. The fix is in PhoneDesk itself, so installed addons don't need an update.

## [1.9.1] — 2026-11-09

Install addons from a .zip file.

### Added
- **Install an addon from a file.** On the *Addons* page, *Install from a file or link* now lets you choose a `.zip`
  on this PC (or drop one on the page). It is checked like a download, then you see the same permission prompt before
  anything installs. Addons from a file are marked as not reviewed. The *From a link* option is still there.

<p>
<img src="docs/changelog/1.9.1/dashboard-install-file.png" width="49%" alt="The install dialog with a place to choose or drop a .zip, and a link field">
</p>

## [1.9.0] — 2026-11-09

Addons: screens and features made by anyone, with a marketplace. Pages and widgets: build your own screens.

### Added
- **Pages made of widgets.** The new *Layouts* page in the PhoneDesk window lets you build your own screens: pick a
  template (*Clock layout*, *Desk overview* or a blank page), then drag widgets onto a 12 by 6 grid and resize them.
  A page joins the phone's swipe row, and the editor shows the real page live, so every change is on the phone as you
  make it. Move and resize with the mouse, or with the arrow keys (Shift resizes); a widget turns red where it would
  overlap another.
- **Built-in widgets:** Clock (digital, analog or big, with the date and optional seconds), Weather, 5-day forecast,
  Calendar agenda, Now playing (with controls), PC stats (CPU, memory, GPU or network), Volume, Shortcut buttons (all
  of them, or one group) and Text. Each has its own options. Mix them in any way, and put the same widget on several
  pages.
- **Customize the built-in screens.** *Now playing*, *Clock*, *PC stats* and *Shortcuts* each have a *Customize* button in
  *Phone display*. It turns the screen into a page of widgets that looks like it does now (following your clock face,
  forecast and calendar settings), in the same place in the swipe row, so you can rearrange it, resize things and add
  widgets. The original screen stays available: turn it back on in *Phone display*. (The lyrics sheet that pulls up over
  Now playing and the group tabs of Shortcuts are not part of the widget versions.)
- **Widgets from addons.** An addon can list widgets in its manifest, with the sizes it supports and options people can
  set. They appear in the editor's palette next to the built-in ones and run in the same sandbox as addon screens. The
  Pomodoro timer and Home Assistant addons now each have one.
- **Addons.** An addon adds a screen to the phone (a page in the swipe row) and can run code on the PC to feed it or to
  do things. Install them from the new *Addons* page of the PhoneDesk window: browse the marketplace, see every
  permission an addon asks for in plain words, approve, install. Turn an addon on or off, change its settings, update or
  remove it. Addon screens appear in *Phone display* like the built-in ones.
- **Permissions you approve before install**, and a sandbox behind them: an addon's screen runs in a sealed frame with
  no network and no access to PhoneDesk's page; its PC-side code runs in its own process that can't start programs or
  leave its own folders, and every powerful call (keys, programs, network, media) is checked against what you approved.
  Network access can't be fully blocked at the system level, so read the permissions: [docs/addons/security.md](docs/addons/security.md).
- **The marketplace** is a list in this repository (`registry/`), reviewed in pull requests. Downloads come only from
  GitHub and must match their checksum. *Install from a link* is there for addons that aren't listed (marked as not
  reviewed), and addons update themselves when they ask for no new permissions.
- **Shortcut actions from addons.** A shortcut button can now run an *Addon action*.
- **Three addons to start with:** *Pomodoro timer* (a focus timer on the phone), *Home Assistant* (tap-to-toggle
  lights, switches and scenes, with the token kept on the PC) and *Media and system keys* (volume, play/pause, task
  view and more as shortcut actions).
- **Build your own:** `node tools/pd-addon.js init`, `dev --watch`, `validate` and `pack`, a phone SDK and a PC-side API,
  and a developer guide at [phonedesk.orreinis.me/docs/addons](https://phonedesk.orreinis.me/docs/addons). The website
  has a marketplace page too.

<p>
<img src="docs/changelog/1.9.0/dashboard-addons.png" width="49%" alt="The Addons page: installed addons and the marketplace">
<img src="docs/changelog/1.9.0/dashboard-addon-install.png" width="49%" alt="The install prompt listing the permissions an addon asks for">
</p>
<p>
<img src="docs/changelog/1.9.0/dashboard-layouts.png" width="49%" alt="The layout editor: a page of widgets with a live preview">
<img src="docs/changelog/1.9.0/phone-page-widgets.png" width="49%" alt="A page of built-in and addon widgets on the phone">
</p>
<p>
<img src="docs/changelog/1.9.0/phone-addon-pomodoro.png" width="49%" alt="The Pomodoro timer addon on the phone">
<img src="docs/changelog/1.9.0/phone-addon-home.png" width="49%" alt="The Home Assistant addon on the phone">
</p>

### Fixed
- On the offline screen (PC disconnected), the time and weather pills of Now playing no longer sit on top of the
  offline clock and weather.

## [1.8.1] — 2026-11-09

Fixes for first-run setup and updates, and a redesigned shortcuts screen.

### Added
- **Shortcuts screen, redesigned:** wide rounded buttons with the icon beside the label, grouped under headings with a
  tab for each group (*All*, *Audio*, *System*, *Apps*…). A button can show live state under its label: the playing
  track (*Playing · Paper Lanterns*) or whether the PC's sound is muted. Set the group and what a button shows in the
  dashboard's *Shortcuts* page. Buttons without a group look like before, in one grid; new installs start with the
  groups above.

<p>
<img src="docs/changelog/1.8.1/phone-shortcuts-groups.png" width="49%" alt="Shortcuts grouped under Audio, System and Apps">
</p>

### Fixed
- The first-run setup's *Connect your phone* step kept showing *Waiting for your phone…* after a phone had connected.
  It now shows the phone's name and how it is connected, and the button changes to *Next*.
- **Updates:** *Check for updates* showed *Couldn't update: Failed to execute 'json' on 'Response': Unexpected end of JSON
  input* whenever the check ended without a newer version (up to date, off, running from source). The check now always
  answers, and the status says what it found.
- An update whose installer didn't start no longer leaves *Installing* on screen: it shows the problem and lets you try
  again.

### Changed
- The website has a new look (the *Website* screenshot in the 1.8.0 notes now shows it).

## [1.8.0] — 2026-11-08

Clock faces, your calendar, night mode, an hour of PC stats, and a website.

### Added
- **Clock faces:** *Digital* (time, date, weather), *Analog* (a clock face beside the date) and *Big* (just the time,
  as large as the screen allows), under *Phone display → Clock screen*.
- **5-day forecast** under the clock: day, icon, high and low (Open-Meteo, as before).
- **Your calendar beside the clock:** paste a private iCal address from Google Calendar, Outlook or iCloud and the
  next events of the coming week show in an *Up next* panel, with the one happening now highlighted. Repeating events,
  all-day events, time zones and cancelled or skipped dates are handled. The address stays on the PC (removed from
  diagnostics too); only the next few events go to the phone.
- **Night mode:** off, on a schedule (e.g. 22:00–07:00) or *when it's dark* (the phone app's light sensor). At night
  the phone goes black with a dim clock, red if you like, switches to the clock, and the phone app turns the screen's
  own brightness down. It switches back in the morning.
- **Burn-in protection** (on by default): everything moves a few pixels every 3 minutes, slowly, so a screen that's
  always on doesn't keep a ghost image.
- **PC stats, rebuilt:** a *Network* card (download speed, upload under it), a **last hour graph** of CPU, memory and
  GPU (the PC keeps the history even while no phone is watching), and a bar for **every CPU thread**. The PC name and
  uptime moved to the top, clear of the battery pill.
- **What's new:** after an update, the PhoneDesk window shows that version's notes once (they ship with the app).
  Click the version number at the bottom left to see them again.
- **Save diagnostics** (*Activity*): one zip with the logs, settings and system facts for a bug report. Keys, tokens,
  the calendar address and shortcut commands are left out. *Report a problem* opens the new issue forms.
- **Website** at [phonedesk.orreinis.me](https://phonedesk.orreinis.me/) with every feature, the lyrics
  styles, setup help and this changelog with its screenshots.
- **Phone app in the release:** each release has `PhoneDesk-x.y.z.apk` attached. When the signing key is stored as a
  repository secret, the release workflow also rebuilds the app; its version now follows PhoneDesk's.
- **Build check** for pull requests: JavaScript syntax, the phone app and the installer are built on Windows.
- Issue forms for bug reports and feature requests; the README shows screenshots.

### Fixed
- The README's build command was broken (`build\build.ps1` had lost a character).

### Screenshots
<p>
<img src="docs/changelog/1.8.0/phone-clock-agenda.png" width="49%" alt="Clock with forecast and calendar">
<img src="docs/changelog/1.8.0/phone-clock-analog.png" width="49%" alt="Analog clock face with the agenda">
</p>
<p>
<img src="docs/changelog/1.8.0/phone-clock-big.png" width="49%" alt="Big clock face">
<img src="docs/changelog/1.8.0/phone-clock-forecast.png" width="49%" alt="Digital clock with the 5-day forecast">
</p>
<p>
<img src="docs/changelog/1.8.0/phone-night-red.png" width="49%" alt="Night mode with a red clock">
<img src="docs/changelog/1.8.0/phone-night-analog.png" width="49%" alt="Night mode, dim analog clock">
</p>

![PC stats with the last hour, network and every thread](docs/changelog/1.8.0/phone-stats-history.png)

<p>
<img src="docs/changelog/1.8.0/dashboard-clock-night.png" width="49%" alt="Clock screen and Night mode settings">
<img src="docs/changelog/1.8.0/dashboard-whats-new.png" width="49%" alt="What's new after an update">
</p>

![Website](docs/changelog/1.8.0/website.png)

## [1.7.3] — 2026-11-08

Updates work out of the box.

### Changed
- **Official releases by default:** PhoneDesk now updates from
  [icdmkg2/phonedesk](https://github.com/icdmkg2/phonedesk/releases) without any setup. Existing installs with an
  empty *GitHub repository* field switch to it too; a fork you entered is kept.
- An empty *GitHub repository* field means the official releases; turn off **Check automatically** to stop updates.
  The field explains this under it.

### Screenshots
![Updates card with the official repository filled in](docs/changelog/1.7.3/dashboard-updates-default.png)

## [1.7.2] — 2026-11-08

Release notes, linked from the app.

### Added
- **Patch notes for every version** in `CHANGELOG.md`, with screenshots of interface changes, and a matching
  [GitHub Release](https://github.com/icdmkg2/phonedesk/releases) per version.
- **Release links in the app:** *Connection → Updates* now has **What's new in vX.Y.Z** (the release page of the
  version you run, or of the update that's ready to install) and **All releases**. Links open in your browser.
- Automatic releases: when the version in `package.json` changes on `main`, GitHub Actions builds
  `PhoneDesk-Setup-x.y.z.exe` (+ `.sha256`) on Windows and publishes the release with the notes from this file, so the
  in-app updater finds it. Editing this file refreshes the notes of existing releases.

### Changed
- The updater keeps the release page address of a downloaded update, so the link goes straight to its notes.

### Screenshots
![Connection → Updates with the new release links](docs/changelog/1.7.2/dashboard-updates.png)

## [1.7.1] — 2026-11-08

Word-by-word lyrics from Spicy Lyrics. (This version's commit is titled "1.7.0"; it shipped as 1.7.1.)

### Added
- **Spicy Lyrics as the first lyrics source**, when you add a key: community word-by-word syncs first, then Apple
  Music and Spotify lyrics. LRCLIB stays as the fallback, and is used when Spicy Lyrics has nothing, is rate-limited or
  is down (it's then left alone for a while).
- New **Spicy Lyrics** card under *Connection*: paste your secret key (`sl_sk_…`), **Save and check** tests it, and
  "Where do I get a key?" explains how. The key stays on the PC; phones never see it. The card shows where the current
  lyrics came from.
- **Real word timings:** with word-synced lyrics, each word fills exactly while it's sung, in the scrolling and
  Kinetic styles, and lines last as long as they're actually sung.
- **Lyrics credit** (required by the providers): "Lyrics: Spicy Lyrics · uploaded by … · made by …" under the cover
  in scrolling lyrics, and along the bottom in Kinetic.

### Changed
- The exact recording is matched by length (within 4 s) across its releases, so the timings fit the version playing.
- Only the title, artist, album and length are sent to the lyrics services.

### Screenshots
<p>
<img src="docs/changelog/1.7.1/phone-lyrics-credit.png" width="49%" alt="Word-synced lyrics with the credit under the cover">
<img src="docs/changelog/1.7.1/phone-kinetic-credit.png" width="49%" alt="Kinetic lyrics with the credit along the bottom">
</p>

![Spicy Lyrics key in Connection](docs/changelog/1.7.1/dashboard-spicy-lyrics.png)

## [1.6.4] — 2026-11-08

### Added
- **Melody indicator:** dancing bars with a label while music plays but nobody sings: **Intro**, **Instrumental**
  (breaks) and **Outro**, and for songs with no lyrics (**No lyrics for this song**, **Instrumental**, **Looking for
  lyrics…**). The bars pause with the song, and the lyrics fade back while they show.

### Changed
- Kinetic lines clear sooner after they're sung (1.2 s instead of 3.2 s) when a gap follows.

### Screenshots
<p>
<img src="docs/changelog/1.6.4/phone-melody-intro.png" width="49%" alt="Melody indicator during the intro">
<img src="docs/changelog/1.6.4/phone-melody-no-lyrics.png" width="49%" alt="Melody indicator for a song without lyrics">
</p>

## [1.6.3] — 2026-11-08

### Changed
- **Fast reconnect:** a connection attempt gives up after 3 s and the next try comes sooner (at most every 2.5 s);
  returning to the page reconnects at once. The phone app checks the PC every 5 s (was 15 s) and pokes the page as
  soon as the PC is back.
- **Lyrics timing:** lines light 0.4 s early (was 0.25 s); Earlier/Later move in 0.15 s steps up to ±5 s, and the
  current shift is shown between the buttons (e.g. `+0.30s`).

### Fixed
- Reading the volume no longer fails now and then with "Unable to cast … MMDeviceEnumeratorComObject".

### Screenshots
![Lyrics timing shift shown between Earlier and Later](docs/changelog/1.6.3/phone-lyrics-offset.png)

## [1.6.1] — 2026-11-07

Plain (unsynced) lyrics now scroll, and the scrolling lyrics view gets a cover column.

### Added
- **Estimated timing for plain lyrics:** when LRCLIB only has unsynced text, the lines are spread over the song by
  their length, so they still scroll and light up. The view says *Estimated timing*; the Earlier/Later buttons
  fine-tune it.
- **Cover column** in the scrolling lyrics view: album art, title and artist on the left, lyrics on the right.

### Screenshots
<p>
<img src="docs/changelog/1.6.1/phone-lyrics-cover-column.png" width="49%" alt="Scrolling lyrics with the cover column">
<img src="docs/changelog/1.6.1/phone-plain-lyrics.png" width="49%" alt="Plain lyrics with estimated timing">
</p>

## [1.6.0] — 2026-11-07

Proper Hebrew fonts.

### Added
- **Bundled Hebrew fonts** (SIL Open Font License, from Google Fonts), so Hebrew looks right on phones without them:
  Heebo for the interface and Sans/Condensed lyrics, Frank Ruhl Libre for Serif lyrics, Rubik for Mono/Script lyrics.
  They apply only to Hebrew letters (`unicode-range`), so Latin text keeps the fonts it had.

### Screenshots
<p>
<img src="docs/changelog/1.6.0/phone-hebrew-now-playing.png" width="49%" alt="Hebrew song on Now playing">
<img src="docs/changelog/1.6.0/phone-hebrew-lyrics.png" width="49%" alt="Hebrew scrolling lyrics">
</p>

![Hebrew Kinetic lyrics in Frank Ruhl Libre](docs/changelog/1.6.0/phone-hebrew-kinetic.png)

## [1.5.9] — 2026-11-07

### Changed
- **Top pills line up:** battery, source, time and weather pills share one height and an even 8 px gap. In Immersive,
  the source pill (Spotify, YouTube…) sits right after the battery pill whatever width the battery reading has.

### Screenshots
![Top pills with one height and gap](docs/changelog/1.5.9/phone-top-pills.png)

## [1.5.8] — 2026-11-07

### Changed
- **Immersive layout as an album card:** a big cover on the left; title, artist, progress and controls aligned to one
  edge on the right, with the progress bar inline (time · bar · length). Each text still reads in its own direction,
  so Hebrew and English titles share the same edge.

### Screenshots
<p>
<img src="docs/changelog/1.5.8/phone-album-card.png" width="49%" alt="Immersive album card">
<img src="docs/changelog/1.5.8/phone-album-card-hebrew.png" width="49%" alt="Immersive album card with a Hebrew title">
</p>

## [1.5.7] — 2026-11-07

Lyrics that stay in sync.

### Added
- **Earlier / Later buttons** on the lyrics screen shift the current song's lyrics; the shift is remembered per song on
  that phone.
- **Lyrics timing slider** under *Phone display* moves all lyrics earlier or later (±1.5 s).

### Changed
- **Smooth playback clock:** players report their position only every few seconds and slightly off, so the phone keeps
  its own running clock and nudges it toward each report instead of jumping back and forth. Seeks, new songs and
  play/pause still reset it at once.
- **Real line pacing:** a line is lit for most of the gap to the next line, but not stretched over long instrumental
  breaks.

### Screenshots
<p>
<img src="docs/changelog/1.5.7/phone-lyrics-earlier-later.png" width="49%" alt="Earlier and Later buttons on the lyrics screen">
<img src="docs/changelog/1.5.7/dashboard-lyrics-timing.png" width="49%" alt="Lyrics timing slider in Phone display">
</p>

## [1.5.5] — 2026-11-07

### Added
- **Right-to-left lyrics** (Hebrew, Arabic): correct word order, right alignment, word fill running right to left,
  and RTL-aware titles, in both the scrolling and Kinetic styles.

### Screenshots
<p>
<img src="docs/changelog/1.5.5/phone-rtl-lyrics.png" width="49%" alt="Hebrew scrolling lyrics">
<img src="docs/changelog/1.5.5/phone-rtl-kinetic.png" width="49%" alt="Hebrew Kinetic lyrics">
</p>

![Hebrew title on Now playing](docs/changelog/1.5.5/phone-rtl-now-playing.png)

## [1.5.4] — 2026-11-07

### Changed
- **Linked lines** replace the Glass hairlines and word map: every word is joined to the next, and a thread runs from
  the last word of one lyric to the first word of the next, so the whole song reads as one continuous line. (Chosen
  with *Connecting lines → Linked*.)

### Screenshots
![Kinetic lyrics with Linked lines](docs/changelog/1.5.4/phone-kinetic-linked-lines.png)

## [1.5.3] — 2026-11-07

### Added
- **Glass lines** for Kinetic lyrics: thin hairlines sweeping across the screen, a "word map" of tiny upper-case words
  joined by dotted lines in the free space, and a bold slanted slash that travels along the line as it's sung.

### Screenshots
![Kinetic lyrics with Glass lines](docs/changelog/1.5.3/phone-kinetic-glass-lines.png)

## [1.5.2] — 2026-11-07

### Added
- **Connecting lines** for Kinetic lyrics (*Phone display → Connecting lines*): a dot under each word and a line that
  draws from word to word as they're sung, **Curved** or **Straight** (or Off).

### Changed
- Lines drift slowly while shown, and words land with a springier motion.

### Screenshots
<p>
<img src="docs/changelog/1.5.2/phone-kinetic-curved-lines.png" width="49%" alt="Curved connecting lines">
<img src="docs/changelog/1.5.2/phone-kinetic-straight-lines.png" width="49%" alt="Straight connecting lines">
</p>

## [1.5.1] — 2026-11-07

Kinetic lyrics, part three.

### Added
- **Kinetic · dark**: the same look as light text on near-black, next to **Kinetic · light** (frosted glass, dark text).
- **Kinetic font** choice: Serif, Sans, Condensed, Mono or Script.

### Changed
- **Per-word fill:** each word starts as a ghost and fills with ink left to right, taking as long as the word takes to
  sing; each word slides in from its own random side.
- **Random layouts:** ragged rows of 1–3 words (never a lone word at the end), with one or two emphasis words among the
  longer ones.
- **Always on screen:** the laid-out (and tilted) text is measured, shrunk if too big and slid back inside if it pokes
  out.
- The corner pills turn dark only once the light sheet has settled.

### Screenshots
<p>
<img src="docs/changelog/1.5.1/phone-kinetic-light.png" width="49%" alt="Kinetic light">
<img src="docs/changelog/1.5.1/phone-kinetic-dark.png" width="49%" alt="Kinetic dark">
</p>
<p>
<img src="docs/changelog/1.5.1/phone-kinetic-sans.png" width="49%" alt="Kinetic dark in Sans">
<img src="docs/changelog/1.5.1/dashboard-kinetic-options.png" width="49%" alt="Lyrics style and Kinetic font in Phone display">
</p>

## [1.4.9] — 2026-11-07

### Changed
- **Kinetic lyrics redone as a glass-display look:** dark serif type on light frosted glass, ragged stacks of short
  rows, the longest word as the emphasis, ghost words for what's coming, and the previous line shrunk to a faint echo
  (one tucked above, one turned along the edge). Calm lines are lighter and wider; intense ones snap in as upper-case
  sans.

### Screenshots
![Kinetic lyrics, glass-display look](docs/changelog/1.4.9/phone-kinetic-glass.png)

## [1.4.8] — 2026-11-07

### Added
- **Kinetic lyrics style**, selectable under *Phone display → Lyrics style*: one big line at a time, words appearing as
  they're sung, with calm, mid and "hot" motion depending on the line, and a quiet screen during long pauses.
  *Scrolling* (the whole song, current line lit) stays the default.

### Screenshots
<p>
<img src="docs/changelog/1.4.8/phone-kinetic.png" width="49%" alt="Kinetic lyrics">
<img src="docs/changelog/1.4.8/dashboard-lyrics-style.png" width="49%" alt="Lyrics style picker">
</p>

## [1.4.6] — 2026-11-07

### Changed
- **Per-word lighting** in the lyrics: the sung words light up one by one instead of a fill sweeping the line.
- **Pill-style top bar:** battery and source on the left, time and weather on the right, each in its own pill.
- Lyrics sheet: the song name is centred between the pills and the close arrow sits where the Lyrics pill was.

### Screenshots
<p>
<img src="docs/changelog/1.4.6/phone-pill-top-bar.png" width="49%" alt="Pill-style top bar">
<img src="docs/changelog/1.4.6/phone-lyrics-per-word.png" width="49%" alt="Per-word lyric lighting">
</p>

## [1.4.5] — 2026-11-07

### Added
- **Karaoke-style lyrics:** the current line fills word by word, paced by how long it's sung; three dots fill in and
  breathe during instrumental breaks.
- **Tap a line to seek** the song there.

### Changed
- Tighter sync: lines light a touch early (0.28 s), like the big players; finding the current line is a binary search.
- **Better song matching** on LRCLIB: exact match with album and length first, then without the album, then searches;
  synced lyrics must be within 6 s of the song's length, plain ones within 12 s. "(feat. …)" credits and
  "- Remastered / Live / Radio Edit / Remix…" suffixes are stripped from titles before searching.

### Screenshots
![Karaoke-style lyrics](docs/changelog/1.4.5/phone-karaoke-lyrics.png)

## [1.4.3] — 2026-11-07

### Fixed
- **One entry per phone:** Wireless debugging lists a phone twice (ip:port and an mDNS name); the duplicate is ignored.
- Auto-connect launches the PhoneDesk phone app when it's installed, instead of opening a browser page.

## [1.4.2] — 2026-11-07

### Changed
- **Tidier Immersive layout:** a bigger cover, title/controls/volume/progress on a grid, larger touch targets, and the
  clock and weather hugging the top-right corner.

### Screenshots
![Tidier Immersive layout](docs/changelog/1.4.2/phone-immersive.png)

## [1.4.1] — 2026-11-07

### Changed
- The phone app draws behind the camera cutout/notch instead of leaving a black bar next to it.
- The fullscreen button is hidden inside the phone app (it's always full screen).

## [1.4.0] — 2026-11-07

The PhoneDesk phone app.

### Added
- **Android phone app** (`PhoneDesk.apk`, served by the PC at `/phone/PhoneDesk.apk`): a full-screen, always-on kiosk
  window onto PhoneDesk. It finds the PC by itself (phonedesk.local via its own mDNS lookup, or a saved address),
  follows the PC if its address changes, keeps the screen awake, locks landscape, ignores Back, and shares the battery
  level (which browsers don't do over plain http).
- *Connection → Connect a phone* has an **Install the phone app (recommended)** section.
- `build/android.ps1` builds the APK.

### Screenshots
<p>
<img src="docs/changelog/1.4.0/dashboard-android-app.png" width="49%" alt="Install the phone app in the Connection page">
<img src="docs/changelog/1.4.0/phone-app-finding-pc.png" width="49%" alt="The phone app looking for the PC">
</p>

## [1.3.7] — 2026-11-07

### Added
- The phone sends a one-off diagnostic line to the PC's log (secure context, battery API, kiosk interface), to help
  diagnose a missing battery.

## [1.3.6] — 2026-11-07

### Added
- **Battery from Fully Kiosk Browser** through its JavaScript interface, for browsers without the battery API.
- The battery help text explains how to turn that on.

## [1.3.5] — 2026-11-07

### Fixed
- The volume slider in the dashboard's Now playing card no longer overflows on narrow windows.
- The *Switch screen* menu opens upward, so it's no longer cut off the screen; it no longer lists Lyrics in the
  Immersive style (lyrics are a pull-up sheet there).

### Added
- **"Why is the battery missing?"** help on the Overview when the phone doesn't share it.

### Screenshots
![Overview in a narrow window](docs/changelog/1.3.5/dashboard-overview-narrow.png)

## [1.3.4] — 2026-11-07

### Fixed
- Round icon buttons in the dashboard stay round instead of squashing into ovals.

## [1.3.3] — 2026-11-07

Immersive Now playing.

### Added
- **Immersive Now playing style** (new default): a tinted background, cover and big title, time and weather in the
  corner, and a **Lyrics** pill that pulls the lyrics up as a sheet over the screen (swipe up to open, down to close).
- **Classic** (big cover, full controls) stays selectable under *Phone display → Now playing style*.

### Screenshots
<p>
<img src="docs/changelog/1.3.3/phone-immersive.png" width="49%" alt="Immersive Now playing">
<img src="docs/changelog/1.3.3/phone-immersive-lyrics.png" width="49%" alt="Pull-up lyrics sheet">
</p>
<p>
<img src="docs/changelog/1.3.3/phone-classic.png" width="49%" alt="Classic Now playing">
<img src="docs/changelog/1.3.3/dashboard-now-playing-style.png" width="49%" alt="Now playing style picker">
</p>

## [1.3.2] — 2026-11-07

### Changed
- **Compact Connection page:** a *Your phones* list (device, current screen, link type, latency, battery, Identify
  button), one *Connect a phone* card, one *USB and cable-free* card, and setup steps folded into "How to…" sections.

### Fixed
- App icons are no longer mirrored or upside down (GDI is always asked for top-down rows).
- Icons are found for more notification apps (ids like `com.squirrel.Discord.Discord`, or apps that aren't running, via
  their Start menu shortcut).

### Screenshots
![Compact Connection page](docs/changelog/1.3.2/dashboard-connection.png)

## [1.3.1] — 2026-11-07

### Changed
- **Smoother animations** everywhere (they respect *reduce motion*):
  - screens slide in the swipe direction;
  - the old cover stays until the new one has loaded, then the new one fades and settles in, with a light sweep while
    loading; title, artist and app slide up on track changes; the background tint cross-fades;
  - notification banners drop in with a spring, show a time-left bar, and slide out;
  - the ♥ button pops;
  - dashboard pages and cards fade up in sequence; buttons press in.

## [1.3.0] — 2026-11-07

Mixer, lyrics, weather, Spotify, notifications, GPU.

### Added
- **Volume mixer** screen: per-app volume and mute (Windows audio sessions) with app icons.
- **Lyrics** screen: synced lyrics from [LRCLIB](https://lrclib.net), highlighted line by line.
- **Weather** on the clock, from Open-Meteo (your city, or an approximate location).
- **GPU stats** on the PC stats screen: load, temperature, hotspot, power, VRAM (AMD via ADL, NVIDIA via
  `nvidia-smi`).
- **Spotify:** a ♥ button to save the song and "up next" (Web API, PKCE sign-in, no secret stored).
- **PC notifications** on the phone as banners, with app icon and name; private mode hides their text.
- **First-run setup wizard:** connect the phone, check and fix Windows Firewall for Wi-Fi, choose weather,
  notifications and start-with-Windows.
- **Auto-update from GitHub Releases** with SHA-256 verification; the installer runs silently and restarts PhoneDesk.
  The build writes a `.sha256` next to the installer.

### Fixed
- Microsoft Store apps get their real names and icons; path-style app ids resolve.
- New screens are added once, in order, to existing setups.

### Screenshots
<p>
<img src="docs/changelog/1.3.0/phone-lyrics.png" width="49%" alt="Lyrics screen">
<img src="docs/changelog/1.3.0/phone-mixer.png" width="49%" alt="Volume mixer">
</p>
<p>
<img src="docs/changelog/1.3.0/phone-clock-weather.png" width="49%" alt="Clock with weather">
<img src="docs/changelog/1.3.0/phone-notification.png" width="49%" alt="Notification banner">
</p>

![First-run setup wizard](docs/changelog/1.3.0/dashboard-setup-wizard.png)

## [1.2.0] — 2026-11-07

A real desktop app and a redesigned dashboard.

### Added
- **Desktop window** (WebView2) with a dark native title bar; closing it keeps PhoneDesk in the tray, and launching it
  again brings the window forward. Dark tray menu and "phone connected" notifications.
- **New icon** for the app, tray, favicon and phone home screen.
- **Rebuilt dashboard:** Overview with a live phone preview, latency, battery, Identify and Switch screen; a Shortcuts
  editor on a phone-shaped grid with key recording; Phone display settings with a live preview; Connection and
  Activity pages; bundled fonts so it works offline.
- **Battery icon** on the phone (from the browser, or read by the PC over ADB).
- Icon of the playing app next to the source (real app and game icons, YouTube detection).
- Optional network-ADB link for phones on a charger; start-with-Windows toggle in the app.

### Changed
- The phone falls back between USB, phonedesk.local and the PC's IP without reloading, so unplugging USB keeps it
  working over Wi-Fi.
- The screen is kept on with Android's *Stay awake*; the wake lock is re-acquired.
- Discord (configurable) is ignored when choosing the media source.

### Fixed
- Album art never loading (WinRT stream conversion failed). Missing art is looked up in the iTunes catalog, with an
  artist check.

### Screenshots
<p>
<img src="docs/changelog/1.2.0/dashboard-overview.png" width="49%" alt="Overview with live phone preview">
<img src="docs/changelog/1.2.0/dashboard-shortcuts.png" width="49%" alt="Shortcuts editor">
</p>
<p>
<img src="docs/changelog/1.2.0/dashboard-phone-display.png" width="49%" alt="Phone display settings">
<img src="docs/changelog/1.2.0/phone-now-playing.png" width="49%" alt="Now playing with battery">
</p>

## [1.1.0] — 2026-11-07

Windows installer, tray app and phonedesk.local.

### Added
- **PhoneDesk.exe tray app:** runs the server hidden, restarts it if it crashes, starts with Windows, stops the server
  if the tray app dies (job object), detects and fixes Windows Firewall blocks, and doubles as the uninstaller.
- **PhoneDesk-Setup.exe:** per-user installer with a bundled Node runtime; in-place updates keep settings; optional
  one-time firewall rule. Built with the C# compiler that ships with Windows (`build/build.ps1`).
- **phonedesk.local:** an mDNS responder, so phones reach the PC by name even when its IP changes; also listens on
  port 80 so no port is needed.
- Settings live in `%APPDATA%\PhoneDesk` when installed.
- Phone: when the PC connection drops, a **full-screen clock** with a small reconnecting status replaces the
  "Connecting" screen.

### Changed
- The phone is always landscape: upright phones get a rotated layout (touch, sliders and swipes mapped to match); the
  first tap goes full screen and asks for a landscape lock where the browser allows it.

### Screenshots
![Full-screen clock while disconnected](docs/changelog/1.1.0/phone-offline-clock.png)

## [1.0.0] — 2026-11-07

First version: a lightweight desk display for Windows, made to run smoothly on old Android phones.

### Added
- Node server plus a plain-JS phone client.
- Windows media (SMTC), volume and key presses through a supervised PowerShell bridge that restarts itself if it
  crashes or hangs.
- Phone screens: Now playing, clock, PC stats and shortcut buttons.
- Browser dashboard on the PC: connect by QR code or USB, shortcut editor, settings and logs.
- USB auto-connect through `adb reverse`.

### Screenshots
<p>
<img src="docs/changelog/1.0.0/phone-now-playing.png" width="49%" alt="Now playing">
<img src="docs/changelog/1.0.0/phone-clock.png" width="49%" alt="Clock">
</p>
<p>
<img src="docs/changelog/1.0.0/phone-stats.png" width="49%" alt="PC stats">
<img src="docs/changelog/1.0.0/phone-shortcuts.png" width="49%" alt="Shortcuts">
</p>

![Dashboard](docs/changelog/1.0.0/dashboard.png)

[1.9.2]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.9.2
[1.9.1]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.9.1
[1.9.0]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.9.0
[1.8.1]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.8.1
[1.8.0]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.8.0
[1.7.3]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.7.3
[1.7.2]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.7.2
[1.7.1]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.7.1
[1.6.4]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.6.4
[1.6.3]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.6.3
[1.6.1]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.6.1
[1.6.0]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.6.0
[1.5.9]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.5.9
[1.5.8]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.5.8
[1.5.7]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.5.7
[1.5.5]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.5.5
[1.5.4]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.5.4
[1.5.3]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.5.3
[1.5.2]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.5.2
[1.5.1]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.5.1
[1.4.9]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.4.9
[1.4.8]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.4.8
[1.4.6]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.4.6
[1.4.5]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.4.5
[1.4.3]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.4.3
[1.4.2]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.4.2
[1.4.1]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.4.1
[1.4.0]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.4.0
[1.3.7]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.3.7
[1.3.6]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.3.6
[1.3.5]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.3.5
[1.3.4]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.3.4
[1.3.3]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.3.3
[1.3.2]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.3.2
[1.3.1]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.3.1
[1.3.0]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.3.0
[1.2.0]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.2.0
[1.1.0]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.1.0
[1.0.0]: https://github.com/icdmkg2/phonedesk/releases/tag/v1.0.0
