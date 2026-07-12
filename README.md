# Onyx

Onyx is a local-first Windows IPTV player built with Tauri, React, TypeScript, and native `libmpv` playback.

It is meant for people who already have their own playlists, Xtream accounts, and XMLTV guide URLs, and want a desktop app that can keep large libraries usable without pushing their data through a cloud account.

Windows is the primary supported platform.

## Download

Download the latest Windows installer from [GitHub Releases](https://github.com/Guts444/Onyx/releases).

Release builds include the native playback dependencies. You do not need Node.js, Rust, or the mpv DLLs unless you are building Onyx from source.

Onyx uses the system Microsoft Edge WebView2 runtime. Windows 11 and current Windows 10 installs normally include it already, so the installer does not download or run the WebView2 bootstrapper.

## What Onyx Does

- Loads local `.m3u` / `.m3u8` files, remote M3U URLs, and Xtream live TV accounts.
- Saves source profiles so you can reload a provider without re-entering the same details.
- Browses large channel libraries by group, favorites, recents, and search.
- Lets you hide noisy groups and collapse source/group sections.
- Loads one or more XMLTV EPG guides.
- Caches guide data locally for matching and now/next programme display.
- Supports manual EPG matching when automatic matching is not enough.
- Plays streams through native `libmpv`.
- Provides reload, stop, mute, volume, fullscreen, resume, resolution, and FPS controls in the player overlay.

## Large Library Behavior

Onyx is built around large IPTV libraries. Recent startup and browsing work focuses on cases with tens of thousands of playlist channels and many EPG programmes:

- cached playlists can appear immediately while saved remote sources refresh later
- startup EPG refreshes are delayed until cached guide directories have loaded
- multiple startup EPG refreshes are staggered instead of launched all at once
- the channel shelf renders large groups incrementally instead of trying to mount every visible channel card in one pass
- EPG now/next lookup uses faster indexed programme searches

## Privacy And Storage

Onyx has no cloud backend, analytics, telemetry, or account sync. Playlist, guide, playback, and settings data stay on the local machine except for direct requests to the source and guide URLs supplied by the user.

Local app state is stored by Tauri in the app local data directory. This includes credential-free source metadata, guide settings, favorites, recents, hidden groups, playback session data, volume, and credential-free playlist snapshots.

Xtream passwords, remote M3U URLs, and EPG URLs are stored separately in Windows Credential Manager through the Rust `keyring` integration. Persisted state and cache identities do not use those URLs. At startup, Onyx hydrates the secrets into memory and migrates compatible legacy source, channel, cache, and EPG-mapping references to URL-free identifiers before safely rewriting them.

App-state and EPG-cache writes are size-bounded, serialized, and atomically replaced with validated recovery backups. If a primary is corrupt, Onyx can recover a safe backup; invalid or credential-bearing legacy artifacts are quarantined or securely discarded according to their contents. A failed migration or credential-store operation keeps existing saved data rather than committing a partial change.

## Security Notes

- Playlist metadata is treated as untrusted text and rendered without HTML injection.
- Stream URLs are normalized and restricted to supported protocols or local file paths.
- Remote playlist and XMLTV guide imports are fetched in Rust to avoid browser CORS limitations and to enforce size limits.
- Xtream passwords and remote M3U/EPG URLs are stored in Windows Credential Manager rather than browser storage, app-state JSON, or EPG cache JSON.
- Persisted state uses URL-free source/cache identifiers and rejects credential-bearing playlist state at the backend boundary.
- Production uses a restrictive CSP and a minimum Tauri IPC capability set; development has a separate identity, data directory, credential namespace, and explicit localhost-only CSP additions.
- No shell execution is driven by playlist data.

## Screenshots

### Home

![Onyx home screen](docs/screenshots/home.png)

### Settings

| Library | EPG | Sources |
| --- | --- | --- |
| ![Onyx library settings](docs/screenshots/library-settings.png) | ![Onyx EPG settings](docs/screenshots/epg-settings.png) | ![Onyx saved sources](docs/screenshots/saved-sources.png) |

## Build From Source

The supported Windows x86-64 build is intentionally reproducible. Required versions are:

- Node.js `24.18.x` (`.nvmrc` pins `24.18.0`)
- npm `11.16.x` (`package.json` pins `npm@11.16.0`)
- Rust `1.95.x` with `x86_64-pc-windows-msvc`, `rustfmt`, and `clippy` (`rust-toolchain.toml` pins `1.95.0`)
- the normal [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/)

The npm manifest and `package-lock.json` are authoritative for JavaScript dependencies; use npm only and install the exact lockfile graph:

```bash
npm ci
```

Do not generate or commit a pnpm lockfile. Before building, run the pinned prerequisite and native-binary checks:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-toolchain.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-native-deps.ps1
```

The required `src-tauri/lib/libmpv-wrapper.dll` and `libmpv-2.dll` are described in `src-tauri/lib/SOURCES.md`. That file contains fixed release URLs, archive hashes, extracted DLL hashes, and the fetch/replacement procedure. Fetch only those pinned archives, verify each archive hash before extraction, verify the extracted DLL hash against both `SOURCES.md` and `src-tauri/lib/SHA256SUMS`, then run `scripts/verify-native-deps.ps1`. Do not use a `latest` release URL or `tauri-plugin-libmpv-api setup-lib` for release inputs.

Start isolated development mode:

```bash
npm run tauri:dev
```

Or double-click `Start Onyx Dev.cmd`. Development uses the `com.guts444.onyx.dev` identifier, `Onyx Dev` product/title, a development-only CSP overlay, separate local app data, and separate OS credential-store service names. It cannot read or overwrite production state or credentials.

If you only run `npm run dev`, the app opens in a browser preview and native playback is disabled.

Validate a release candidate without packaging:

```bash
npm ci
npm test
npm run check
npm run build
npm audit
cargo test --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc --all-targets -- -D warnings
cargo audit --file src-tauri/Cargo.lock
```

Only after those checks and native provenance verification pass, build a release with `Build Onyx Release.cmd` or:

```bash
npm run tauri build
```

Release artifacts are generated in `src-tauri/target/release/bundle`.

## Disclaimer

Onyx is a client application for loading and playing user-supplied playlists, streams, guide URLs, and related credentials. It does not provide channels, playlists, stream URLs, guide data, or service access.

Users are responsible for ensuring they are authorized to use any playlists, streams, Xtream accounts, credentials, EPG URLs, and other third-party services or content loaded by Onyx, and that their use complies with applicable law and the terms of the relevant provider.

Onyx is not affiliated with, endorsed by, or responsible for third-party content or services loaded by users.

## Donations

If you enjoy Onyx, donations help support continued fixes and improvements.

Bitcoin:

```text
3LYX3oEDCzz5S7oQjPmYQYi7ZGoA5XpCdM
```

Ethereum:

```text
0x1246dFAf32E435d79689852A3304ca384A73c1cb
```

Solana:

```text
Aqm2mLHikyZ5guTf7pKcaXjNXG69ifrDRY2324h79ony
```

Thank you for the support.

## License

This project is licensed under the MIT License.
