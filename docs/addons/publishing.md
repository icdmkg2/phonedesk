# Publishing

Getting an addon into the marketplace takes four steps.

## 1. Pack it

    node tools/pd-addon.js pack my-addon

This writes `my-addon-1.0.0.zip` and prints its SHA-256 checksum and a registry entry. Packing the same files twice gives the same checksum. To try the package exactly as people will get it, install it on your own PC: *Install from a file or link* on the Addons page, then choose the `.zip`.

## 2. Put the zip on GitHub

Attach it to a release in your own repository, for example `https://github.com/you/my-addon/releases/download/v1.0.0/my-addon-1.0.0.zip`. The marketplace only accepts `https://github.com/...` and `https://raw.githubusercontent.com/...` downloads.

## 3. Add a registry entry

Open a pull request to https://github.com/icdmkg2/phonedesk that adds your entry to the `addons` list in `registry/index.json`:

    {
      "id": "my-addon",
      "name": "My addon",
      "version": "1.0.0",
      "author": "You",
      "description": "One sentence.",
      "homepage": "https://github.com/you/my-addon",
      "download": "https://github.com/you/my-addon/releases/download/v1.0.0/my-addon-1.0.0.zip",
      "sha256": "…the checksum pack printed…",
      "permissions": ["media"],
      "phonedesk": "1.9.0",
      "tags": ["screen"]
    }

The entry has to agree with the package: the same `id`, `version`, `permissions` and `phonedesk` as its `addon.json`. The checks on the pull request download your zip and compare. Run them yourself first:

    node registry/check.js

## 4. Review

A maintainer reads the addon, usually the whole package, and asks about every permission. They look for:

- **A reason for each permission**, and no more than it needs. `keys`, `run` and `network:` get the most attention.
- **Code that can be read.** No obfuscated or minified-only code without the source; no downloading and running other code.
- **Honest behaviour.** It does what the description says and nothing else; no tracking, no sending data out that it was not described as sending.
- **A screen that works** at the phone's real size and follows the theme.
- **A name and description** that do not mislead or copy someone else's.

## Updating

Release the new zip, then open a pull request that changes `version`, `download` and `sha256` in your entry. People who have the addon get the update: automatically if it asks for the same permissions or fewer, after they approve if it asks for more. Always raise `version`; an older version never replaces a newer one.

## Taking an addon down

Remove its entry in a pull request, or ask the maintainers to. It disappears from the marketplace; people who already installed it keep it until they remove it.
