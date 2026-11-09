# Security

An addon is code from someone else, and PC-side code runs on your PC. This page says what protects you, and where the protection stops.

## What PhoneDesk enforces

- **Permissions are approved before install.** The person sees every permission in plain words and has to approve all of them. An update that asks for more is not installed until they approve.
- **Downloads come from GitHub, and are checked.** Marketplace packages must match the SHA-256 checksum in the registry, or they are not installed. The package must say the same thing as its listing (id, version, permissions). Links people paste must also be on GitHub, and are marked as not reviewed.
- **Packages are read strictly.** File names that try to leave the addon's folder, duplicate files, encrypted or oversized zips are refused.
- **The screen is sandboxed.** It runs in a frame without access to PhoneDesk's page or storage, and the server sends it a policy that forbids network requests. It can only talk through the SDK.
- **The PC-side code runs in its own process** with Node's permission model on: it can not start programs or workers, read files outside its own folder, or write anywhere except its own data folder.
- **Powerful calls are checked.** Press keys, run programs, read media or stats, and every network request go through PhoneDesk, which checks the granted permissions each time. `network:` permissions are checked against the real host of every request and every redirect.
- **Secrets stay on the PC.** Settings of type `password` are never sent to the phone.
- **Nothing runs unless it is turned on.** The person can turn any addon off or remove it, with its data.

## What is not protected

- **The network is not blocked at the system level.** Node's permission model does not cover network access. PhoneDesk removes the usual ways to open a connection from the addon's process (`fetch`, `net`, `http`...) so honest mistakes fail loudly, but a determined author could find another way. For that reason the `network:` permission and the review of the registry are what to rely on, not the process.
- **`keys` and `run` are powerful.** An addon with `keys` can press keys as if you did. An addon with `run` can run any program as you. Install those only from authors you trust.
- **An addon can read what it is allowed to.** With `media` it sees what you play; with `network:` it can send that out.
- **It is not a virtual machine.** A bug in Node or in Windows could let code out of its process. Keep PhoneDesk and Windows up to date.

## The registry

The marketplace is a list in this repository (`registry/index.json`). A change to it is a pull request that the maintainers review. The checks run automatically (`node registry/check.js`): well-formed entry, GitHub download, matching checksum and permissions. Reviewers then read the addon's code. Addons that were reviewed are listed there; anything else was installed from a link and is marked as unreviewed.

A listed addon that turns out to be harmful is removed from the registry. Because installed addons are not downloaded again, tell people to remove it from the Addons page.

## Reporting a problem

Report a harmful addon or a hole in the sandbox as a private security advisory at https://github.com/icdmkg2/phonedesk/security/advisories/new, not as a public issue.
