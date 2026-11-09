# The addon registry

`index.json` is the marketplace: the list of addons PhoneDesk shows on the Addons page and on the website.

- Adding or changing an addon: [docs/addons/publishing.md](../docs/addons/publishing.md)
- How addons are kept safe: [docs/addons/security.md](../docs/addons/security.md)

`packages/` holds the packages of the addons made by the PhoneDesk project itself (from `examples/addons`). Everyone else's packages live on their own GitHub releases.

    node registry/check.js              check every entry (downloads the packages)
    node registry/check.js --offline    check the entries and the packages in this folder only
    node registry/build-first-party.js  pack examples/addons into packages/ and list them

The checks run on every pull request that touches this folder (`.github/workflows/registry.yml`).
