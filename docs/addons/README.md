# Addons

Addons add screens and features to PhoneDesk. An addon can:

- **add a screen to the phone**, a web page (HTML, CSS, JavaScript) that appears as one more page in the swipe row
- **run code on the PC**, in its own process, to feed that screen or to do things (talk to a service on your network, press keys, add shortcut actions)
- **add widgets** that people place on their own pages, next to the built-in ones (clock, weather, calendar, PC stats...)
- **add shortcut actions** that any shortcut button can use

People install addons from the **Addons** page of the PhoneDesk window: from the marketplace, from a link to a package on GitHub, or from a `.zip` file on their PC. Before anything installs they see exactly what the addon is allowed to do.

## Try one in five minutes

You need PhoneDesk running on your PC and Node.js 22 or newer (the PhoneDesk repository, `git clone https://github.com/icdmkg2/phonedesk`).

    node tools/pd-addon.js init my-addon
    cd my-addon
    node ../tools/pd-addon.js dev . --watch

`init` makes a small addon with a screen and PC-side code. `dev` loads it into the PhoneDesk running on this PC and loads it again every time you save a file. Swipe to its screen on the phone.

## What is in an addon

An addon is a folder, shipped as a `.zip`, with a file called `addon.json` at its root:

    my-addon/
      addon.json          what it is, what it needs
      screen/index.html   the phone screen (optional)
      widget/index.html   a widget (optional, any number)
      server.js           the PC-side code (optional)

- [The manifest](manifest.md): every field of `addon.json`
- [The API](api.md): what your screen and your PC-side code can call
- [Security](security.md): what is enforced, what is reviewed, and what is not protected
- [Publishing](publishing.md): getting an addon into the marketplace

## The tools

`tools/pd-addon.js` has four commands:

- `init <id>` creates a new addon (`--widget` for a widget-only one that scales to any size)
- `validate [dir]` checks `addon.json` and the files it names
- `dev [dir] [--watch]` loads the folder into PhoneDesk on this PC
- `pack [dir]` makes `<id>-<version>.zip`, prints its checksum and a registry entry

## Examples

The `examples/addons` folder has five real addons, all in the marketplace:

- **Pomodoro timer**: a screen with a server that keeps today's count. Needs no permissions.
- **Home Assistant**: tap-to-toggle tiles; the server talks to Home Assistant on your network with a token that never reaches the phone.
- **Media and system keys**: no screen, only shortcut actions.
- **Countdown** and **World clock**: widgets only, no PC-side code and no permissions. The smallest useful addons: a good place to start.

## When something is wrong

In the PhoneDesk window, **Addons > Log** shows what an addon printed, how many messages it sent to its screen, how many were dropped for sending too fast (more than 30 a second), how long its PC-side code takes to answer (a busy loop shows up here) and any request that was slow. `dev` also prints where to find your addon on the phone.
