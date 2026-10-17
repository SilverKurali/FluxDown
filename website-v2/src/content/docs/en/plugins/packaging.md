---
title: Packaging & Plugin Market
description: The .fxplug format, install safety limits, and publishing to the plugin index.
section: plugins
order: 5
---

## The `.fxplug` format

A `.fxplug` file is nothing more than a **zip of the plugin folder** with a different extension. Zip `manifest.json` and your `.js` files, rename to `my-plugin.fxplug`, done. Both layouts work:

```
my-plugin.fxplug          my-plugin.fxplug
├── manifest.json         └── my-plugin/          ← single wrapper folder
└── resolver.js               ├── manifest.json      is stripped automatically
                               └── resolver.js
```

`manifest.json` must be at the zip root or inside exactly one wrapper directory; anything else is rejected with "manifest.json not found".

### Install-time limits

Installers enforce these regardless of where the zip came from:

| Check | Limit |
|---|---|
| Zip entries | ≤ 200 |
| Total uncompressed size | ≤ 50 MB |
| Entry paths | Must stay inside the target folder — `..` and absolute paths are rejected (zip-slip protection) |
| Manifest | Parsed and fully validated (see [Manifest reference](/docs/en/plugins/manifest/)) |
| Scripts | Compile-checked; syntax errors abort the install |

The plugin is extracted to `<data dir>/plugins/<identity>/`. Installing the same identity again replaces the previous version.

## The plugin market

FluxDown's market is **a data format, not a service** — an index the app reads directly, with no backend and no account. The pieces:

- **An index** — a Git-versioned JSON catalog of plugins, versions and download mirrors. The default index lives at `zerx-lab/fluxdown-plugin-index` on GitHub; anyone can fork it and run their own. Users can add custom index sources in the app.
- **Author-owned repositories** — each plugin lives in its author's own GitHub repository. The index only records which repository publishes which plugin identity; every GitHub Release of that repository is ingested automatically.
- **Content addressing** — every published version records `contentHash = sha256(<the .fxplug file>)`. After downloading from any mirror, FluxDown recomputes the hash and rejects a mismatch. A compromised mirror cannot swap the payload, and a published version's bytes never change.
- **Manifest match** — before installing, FluxDown checks that the package's manifest identity, version and permissions match the index entry, so the permissions you approve are exactly the ones the plugin gets.
- **Rollback protection** — each index carries a monotonically increasing `sequence`; the app remembers the highest value seen per index and refuses an older one.

v1 has no author-level cryptographic signatures — integrity rests on content addressing plus TLS plus Git history. The index schema reserves signature fields so they can be added later without breaking existing clients.

### Publishing a plugin

1. Build and test your plugin locally (dev mode, see [Your first plugin](/docs/en/plugins/your-first-plugin/)), in your own public GitHub repository.
2. Publish a GitHub Release (not a draft or pre-release) with exactly one `.fxplug` asset. `version` in `manifest.json` must be plain `MAJOR.MINOR.PATCH` and higher than any version already in the index.
3. **Once**, open a pull request against the index repository that adds your plugin to `registry.json`:

   ```json
   { "id": "author@name", "repo": "owner/repo", "tags": ["resolver", "video"] }
   ```

   `id` must equal the manifest `identity`. A bot downloads your latest release, runs the same checks the app applies at install time, and comments with the result, the permissions you declare and the URL patterns your plugin intercepts. A maintainer reviews and merges it.

After that, **publishing an update is just publishing a new GitHub Release**. The index picks it up within an hour, with no pull request needed. If a release cannot be ingested (wrong identity, version not bumped, malformed manifest…), an issue labeled `stage-fail` is opened in the index repository and closed automatically once you fix it.

The full rules are in the index repository's [README](https://github.com/zerx-lab/fluxdown-plugin-index#publishing-a-plugin).

### Yanking a version

Index maintainers can mark a version as yanked (for broken or malicious releases). Yanked versions are skipped by "install latest", and versions marked `vulnerable` or `malicious` are disabled where already installed. Publish a fixed version with a higher version number as a new release.

## Install APIs

Besides the settings page, plugins can be installed programmatically:

- `GET /api/v1/market` — fetch the merged market index.
- `POST /api/v1/market/install` with `{ "pluginId": "name@author" }` — install the latest non-yanked version.

Both are part of the management API group and require the management token — see the [API overview](/docs/en/api/overview/).
