# Changelog

## v0.6.0 - 2026-07-16

- **Simpler Live TV navigation**: The main menu, searchable group list, and TV guide now remain visible together; selecting a group no longer hides navigation, and Search is an in-place field above the groups instead of a separate menu destination.
- **Built-in quick guide**: Added a User Guide button directly above Settings with current source, playback, EPG, and control instructions plus shortcuts into the relevant settings pages.
- **Deterministic automatic resume**: Added **Settings > General** with fullscreen (default) and mini-player startup choices, and apply the selected presentation mode before resumed playback begins.
- **Faster secured restart playback**: Credential-free Xtream channel descriptors can resume immediately after Credential Manager hydration while source and EPG refreshes continue in the background, avoiding the previous full-provider-refresh delay without persisting stream credentials.
- **Xtream Movies and TV Shows**: Added lazy category-first VOD browsing with poster grids, rich movie/series details, season and episode selection, authenticated provider stream-origin discovery, and credential-safe playback materialization without putting large VOD catalogs on the Live TV startup path. Individual categories are capped at 20,000 valid titles with an explicit truncation notice.
- **Consistent on-demand navigation**: Movies and TV Shows now use the same persistent sidebar pattern as Live TV, with title search above vertical provider groups instead of a horizontal category strip.
- **Per-provider VOD libraries**: Added searchable Movies and TV Shows group management under **Settings > Library**, including independent enable/disable-all and per-group visibility choices that persist for each Xtream source.
- **Fullscreen VOD transport**: Movies and episodes launch directly into fullscreen with idle-hiding controls, single-click pause/resume, double-click or **Quit** to return to preserved details, 30-second rewind/forward skips, timeline seeking, detected resolution, embedded subtitle selection, mute, and volume while automatic restart playback remains Live-TV-only.
- **Native surface synchronization**: Fixed first-play and scroll-time races that could leave libmpv using whole-window or stale video margins behind the transparent UI.

## v0.5.10 - 2026-07-15

- **Microsoft Store publication**: Onyx-IPTV is now publicly available through Microsoft Store with automatic Store-managed installation and updates.
- **Microsoft Store native-player repair**: Make the MSIX native playback payload self-contained on clean Windows systems by placing libmpv beside the executable, bundling the pinned Vulkan loader required by libmpv, and declaring the Microsoft Visual C++ desktop runtime framework dependency.
- **Store regression gate**: Verify the native DLL layout and runtime declaration before every Store package is created.
- **Repeatable release flow**: Synchronize all version metadata with one command, build MSI/NSIS/Store formats through one helper, and publish verified tagged installers from CI using curated changelog notes.

## v0.5.9 - 2026-07-13

- **Xtream restart repair**: Persist the Xtream username and domain required to rebuild credential-free cached stream descriptors while continuing to keep passwords in Windows Credential Manager.
- **Fullscreen return position**: Leaving fullscreen keeps the group you were browsing and automatically brings both that group and the selected channel row back into view.

## v0.5.8 - 2026-07-12

- **Credential-safe sources and guides**: Xtream passwords, remote M3U URLs, and EPG URLs are held in Windows Credential Manager instead of app-state or cache JSON; existing records are securely hydrated and rewritten during migration.
- **URL-free identity and migration**: Persisted playlist/EPG state uses stable source and cache identifiers rather than credential-bearing URLs, with compatibility migrations for saved channels, favorites, recents, selections, and manual EPG mappings.
- **Crash-safe local state**: App state and EPG caches use bounded, serialized atomic writes, validated backups, corruption recovery, and safe quarantine/deletion rules for invalid or credential-bearing legacy data.
- **EPG integrity**: Download, decode, cache, and parser bounds were tightened; stale refresh races are rejected; malformed programmes are skipped with bounded, credential-free diagnostics rather than invalidating an otherwise usable guide.
- **Hardened release inputs**: Dependencies, production CSP, and Tauri capabilities were tightened; pinned Node/npm/Rust toolchains, isolated development identity/state/credentials, and fixed native DLL provenance plus checksum verification are documented and enforced by release prerequisites.

Release packaging, installer smoke testing, and final independent review completed before publication as `v0.5.8`.

## v0.5.7

- **Fullscreen Escape polish**: When leaving startup fullscreen playback, favorite channels now reopen the Favorites view instead of their normal channel group.
- **Release maintenance**: Bumped desktop/package metadata and release helper output names for the v0.5.7 test build.

## v0.5.6

- **Xtream cache rollback**: Restored the pre-v0.5.4 playlist snapshot behavior so cached Xtream channels keep their stream URLs and play immediately after restart.
- **Stream URL compatibility**: Restored the pre-v0.5.4 stream handling for Windows paths, UNC paths, and `file:` URLs.
- **Xtream domain compatibility**: Scheme-less Xtream domains default to `http://` again, matching the behavior before v0.5.4.
- **Storage compatibility**: Legacy `localStorage` values are no longer removed after migration, keeping the old fallback behavior intact.
- **Kept from recent builds**: Preserved the cleaner Windows installer path and the improved fullscreen `Esc` navigation.

## v0.5.5

- **Xtream restore fix**: Cached Xtream libraries once again restore groups and channels on startup while persisted stream URLs are redacted so provider credentials are not written to app-state JSON.
- **Startup resume fix**: Redacted Xtream caches now wait for the saved source refresh before attempting fullscreen playback resume, avoiding attempts to play placeholder stream URLs.
- **Fullscreen Escape flow**: Pressing `Esc` after startup fullscreen playback now exits to Live TV with the selected channel's group open instead of jumping to Search.

## v0.5.4

- **Windows installer hardening**: Removed Tauri's default WebView2 bootstrapper from the MSI so the installer no longer runs hidden PowerShell to download and launch Microsoft's WebView2 setup. Onyx now relies on the system WebView2 runtime included with current Windows 10/11 installs.
- **Defender false-positive reduction**: Rebuilt release metadata around a cleaner installer path after Microsoft Defender began flagging the old v0.5.3 MSI/EXE as `Behavior:Win32/DefenseEvasion.A!ml`.
- **Playlist safety**: Remote playlists can no longer mark Windows paths, UNC network paths, or `file:` URLs as playable, reducing accidental local file access and SMB credential exposure from malicious playlist entries.
- **Credential storage cleanup**: Xtream playlist snapshots are no longer persisted to app-state JSON because generated stream URLs can contain provider usernames and passwords.
- **Legacy state cleanup**: Migrated legacy `localStorage` values are removed after being written into Tauri app-state files.
- **HTTPS default**: Scheme-less Xtream domains now default to `https://` instead of `http://`.

## v0.5.3

- **Guide-first UI**: Reworked the main experience into a faster Live TV layout with a collapsible left rail, group browser, larger 16:9 mini player, richer programme details, and a full-width guide view that feels much closer to a dedicated IPTV app.
- **Navigation flow**: Added the new `Search`, `Live TV`, and `Settings` rail, with the sidebar and library panels hidden until needed and `Esc` stepping back through groups and then the main menu.
- **TV guide improvements**: Added a proper timeline grid with a moving now line, better time tracking, larger preview area, and guide rows built for quick browsing of large channel lists.
- **Channel actions**: Right-click channel rows to favorite or unfavorite them and open manual EPG assignment directly from the guide.
- **Source management**: Added full source removal from Settings, including cleanup of source-scoped library data, startup playback state, favorites and recents references, manual EPG mappings, and saved Xtream secrets.
- **Playback polish**: Startup resume now restores the last fullscreen channel correctly, fullscreen enter and exit no longer fight the UI, double-click fullscreen does not reload an already playing stream, and the embedded player remains visible in both guide and fullscreen layouts.
- **UI cleanup**: Removed prototype branding mentions, tightened icon alignment and scaling in the rail and settings views, and kept the app focused on fast Live TV playback without adding heavy movies or TV show sections.

## v0.5.0

- **Startup performance**: Uses cached playlists immediately on launch, delays saved-source refreshes, staggers startup EPG updates, and renders large channel groups incrementally so very large libraries start and browse more smoothly.
- **Reliability**: Replaced hard 20-second total network timeouts with connect/read timeouts for playlist, Xtream, and EPG downloads so large but active responses are less likely to fail.
- **Storage**: Moved app state from browser `localStorage` into Tauri-managed JSON files under the app local data directory.
- **Security**: Moved saved Xtream passwords into the operating system credential store and scrubbed passwords from persisted source JSON.
- **EPG performance**: Avoids cloning the full EPG cache when writing to disk and uses binary search for now/next programme lookups.
- **Playback UI**: Cleaned up the player overlay by removing raw stream filenames from the title, showing just the resolution value, and adding a separate FPS badge.

## v0.4.4

- **Security**: Fixed high-severity vulnerabilities related to `Math.random()`.
- **Performance**: Optimized visible EPG channel keys computation and hoisted loop-invariant computations in EPG search.
- **UX / Accessibility**: Added contextual ARIA labels to group toggles.
- **Testing & Stability**: Comprehensive unit testing added for EPG source management, URL key normalization, sanitization logic, and stream references. Refined Tauri backend configurations.

## v0.4.0

- **Under the Hood / Security**: Upgraded to Tauri v2 project structure and implemented robust source profile management logic.
- **Speed & Efficiency**: Significantly optimized EPG loop processing and channel lookups.
- **UX Improvements**: Implemented lazy guide lookups for much faster initial loads and snappier UI responsiveness.
- **Code Health**: Removed dead code, unused legacy functions, and refactored ID generation pipelines.

## v0.3.0

- Added support for saving and using multiple XMLTV EPG sources at the same time.
- Added per-guide enable, disable, remove, manual refresh, auto update, and startup refresh controls.
- Merged all enabled guides into the channel matcher so channels can be matched against multiple countries or providers at once.
- Improved the EPG settings layout to keep guide summary stats readable in the drawer.

## v0.2.0

- Added XMLTV EPG support with local guide caching.
- Added EPG settings for guide URL, manual refresh, auto update, and update on startup.
- Added manual per-channel EPG matching from the channel shelf with saved mappings that reload automatically.
- Added now/next guide data to channels and the player overlay.

## v0.1.0

- First public release of Onyx with native `libmpv` playback, source profiles, favorites, recents, and startup restore.
