# Onyx Architecture

Read this before making feature changes. It captures the current product boundaries, state model, and the files that matter most.

## Product Scope

Onyx is a local-first Windows IPTV player built with Tauri, React, and libmpv.

Current product constraints:

- Live TV remains the startup and automatic-resume priority; Xtream Movies and TV Shows are separate, explicitly lazy sections.
- Fast startup and responsive guide browsing matter more than loading every possible provider feature.
- Saved sources, favorites, guide mappings, and playback state are local to the machine.
- Xtream passwords and remote M3U/EPG URLs must stay out of JSON state/cache files and remain in the OS credential store.
- Production and development identities, local data, credentials, and CSP allowances must remain isolated.

## Stack

- Frontend: React 19 + TypeScript + Vite
- Desktop shell: Tauri v2
- Native playback: `tauri-plugin-libmpv`
- Backend services: Rust commands in `src-tauri`
- Persistence: bounded, versioned JSON app-state files managed through the frontend persistent-state hook and atomic Rust backend, plus OS keyring secrets for Xtream passwords and remote M3U/EPG URLs

## High-Level Layout

- [src/App.tsx](/D:/Projects/Onyx-public/src/App.tsx)
  Main app orchestration. Handles persistent state, source loading, player startup, guide windows, settings and guide dialogs, and the persistent live-TV layout.
- [src/App.css](/D:/Projects/Onyx-public/src/App.css)
  Main application styling, including the guide layout, persistent sidebar, player shell styling, and settings/guide presentation.
- [src/components/ChannelSidebar.tsx](/D:/Projects/Onyx-public/src/components/ChannelSidebar.tsx)
  Persistent left navigation rail plus the searchable group browser.
- [src/components/ChannelShelf.tsx](/D:/Projects/Onyx-public/src/components/ChannelShelf.tsx)
  Guide-first main screen, including timeline rows and the channel context menu.
- [src/components/PlayerPanel.tsx](/D:/Projects/Onyx-public/src/components/PlayerPanel.tsx)
  Shared embedded/fullscreen player shell and overlay chrome.
- [src/components/SettingsDrawer.tsx](/D:/Projects/Onyx-public/src/components/SettingsDrawer.tsx)
  Settings container for General, Library, EPG, and saved sources.
- [src/components/GeneralSettingsPanel.tsx](/D:/Projects/Onyx-public/src/components/GeneralSettingsPanel.tsx)
  General startup behavior, including the fullscreen/mini-player automatic-resume preference.
- [src/components/UserGuideDrawer.tsx](/D:/Projects/Onyx-public/src/components/UserGuideDrawer.tsx)
  Keyboard-modal in-app quick guide with shortcuts into Sources and EPG settings.
- [src/components/VodBrowser.tsx](/D:/Projects/Onyx-public/src/components/VodBrowser.tsx)
  Lazy Movies/TV Shows category browser, poster grid, metadata details, seasons, and episodes.
- [src/components/VodPlayerPanel.tsx](/D:/Projects/Onyx-public/src/components/VodPlayerPanel.tsx)
  Fullscreen finite-media player controls for movies and episodes, including idle chrome and click/double-click gesture arbitration.
- [src/components/VodCategorySettingsPanel.tsx](/D:/Projects/Onyx-public/src/components/VodCategorySettingsPanel.tsx)
  Lazy, source-scoped Movies/TV Shows group visibility management under Library settings.

## Core Domains

### Sources

- Saved source records live in [src/domain/sourceProfiles.ts](/D:/Projects/Onyx-public/src/domain/sourceProfiles.ts).
- Source helpers live in [src/features/sources/profiles.ts](/D:/Projects/Onyx-public/src/features/sources/profiles.ts).
- Xtream passwords and remote M3U URLs live in the OS credential store through [src/features/sources/secrets.ts](/D:/Projects/Onyx-public/src/features/sources/secrets.ts).

Important rule:

- Source deletion must remove source-scoped saved data, not just the visible profile row.
- Secret writes/deletes must succeed before the corresponding source state is committed; stale hydration or source operations must not resurrect deleted or edited records.

### Playlists

- M3U parsing: [src/features/playlist/m3u.ts](/D:/Projects/Onyx-public/src/features/playlist/m3u.ts)
- Remote playlist download: [src/features/playlist/remote.ts](/D:/Projects/Onyx-public/src/features/playlist/remote.ts)
- Xtream import: [src/features/playlist/xtream.ts](/D:/Projects/Onyx-public/src/features/playlist/xtream.ts)

### EPG

- Frontend domain/types: [src/domain/epg.ts](/D:/Projects/Onyx-public/src/domain/epg.ts)
- Frontend API bridge: [src/features/epg/api.ts](/D:/Projects/Onyx-public/src/features/epg/api.ts)
- Matching logic: [src/features/epg/matching.ts](/D:/Projects/Onyx-public/src/features/epg/matching.ts)
- Rust cache/window logic: [src-tauri/src/epg.rs](/D:/Projects/Onyx-public/src-tauri/src/epg.rs)
- EPG URL credential bridge: [src/features/epg/secrets.ts](/D:/Projects/Onyx-public/src/features/epg/secrets.ts)

Important rule:

- Enabled XMLTV guides are merged for matching, but manual mappings are stored against stable playlist and guide identities rather than raw URLs.
- EPG downloads, decoded XML, caches, and warning samples are bounded; malformed programmes are skipped with safe diagnostics, and stale refresh generations cannot repopulate a deleted or superseded guide.

### Player

- Native player hook: [src/features/player/mpv.ts](/D:/Projects/Onyx-public/src/features/player/mpv.ts)
- UI shell: [src/components/PlayerPanel.tsx](/D:/Projects/Onyx-public/src/components/PlayerPanel.tsx)
- VOD UI shell: [src/components/VodPlayerPanel.tsx](/D:/Projects/Onyx-public/src/components/VodPlayerPanel.tsx)

Important rules:

- The Tauri window and page background must remain transparent for libmpv video to show through.
- Decorative gradients belong on app panels, not on `html`, `body`, or `:root`.
- Startup autoplay resumes the last active channel according to the independent General preference: fullscreen by default or mini-player when selected.
- The player must synchronize native video margins before every `loadfile`, reject unmounted/zero-size surfaces, and resynchronize on nested scrolling as well as resize/fullscreen changes.
- VOD play, pause, seek, stop, and fullscreen actions must never replace or clear the saved Live TV startup target.

### Video On Demand

- Frontend types: [src/domain/vod.ts](/D:/Projects/Onyx-public/src/domain/vod.ts)
- Frontend provider bridge/materialization: [src/features/vod/api.ts](/D:/Projects/Onyx-public/src/features/vod/api.ts) and [src/features/vod/model.ts](/D:/Projects/Onyx-public/src/features/vod/model.ts)
- Rust response normalization: [src-tauri/src/vod.rs](/D:/Projects/Onyx-public/src-tauri/src/vod.rs)

VOD is Xtream-only. Categories are fetched when a VOD section or its Library settings subsection is first opened, then one concrete category catalog is downloaded at a time. Responses have transport limits and a 20,000-valid-title per-category cap. The backend returns explicit truncation metadata and the browser displays a notice when the cap is reached. A very large category can still require substantial parsing, IPC, and renderer memory; category-first loading reduces that exposure rather than pretending it is paging. Catalog metadata stays in memory and materialized `/movie/` or `/series/` URLs exist only at the final libmpv playback boundary. The authenticated `server_info` playback origin is resolved separately from the login endpoint so providers with distinct stream hosts or ports work correctly. Category visibility is the exception: bounded hidden-category IDs are persisted independently per source and VOD kind.

## Main UI Behavior

### Persistent Live TV Layout

Outside fullscreen, the primary navigation rail, searchable group pane, preview player, and TV guide remain visible together. Group selection never hides the navigation. Search is a field above the groups rather than a separate primary-navigation destination, and it filters enabled channels directly in the guide while preserving deferred/incremental rendering for large libraries.

`Esc` is reserved for leaving fullscreen or closing an open channel menu/dialog; it does not walk through sidebar modes.

### Guide Behavior

- Selecting `All channels`, `Favorites`, or a group updates the guide while leaving the navigation and groups visible.
- Right-clicking a guide row must expose favorite and EPG assignment actions.
- The preview player in the guide should stay close to a 16:9 frame.

### VOD Behavior

- Movies and TV Shows are destinations under Live TV in the persistent primary rail. Their search and visible vertical category list occupy the same persistent secondary-sidebar pattern used by Live TV.
- Selecting a movie or episode transitions directly to the shared fullscreen native player. VOD has no embedded/mini-player details-page mode; double-clicking, pressing `Esc`, or choosing **Quit** returns to the preserved details view.
- VOD chrome hides after pointer inactivity and reappears on movement. A delayed single-click toggles pause/resume; double-click cancels that pending toggle before quitting, and control events do not bubble into surface gestures.
- Category catalogs and detail payloads load only after the user opens the corresponding section/title.
- Poster images are lazy, card rendering is incremental, and switching away preserves the already loaded in-memory section state for the session.
- Series episode maps are authoritative; season metadata is optional decoration.
- Embedded subtitles come from mpv's `track-list`. Arbitrary provider sidecar subtitle URLs are not followed or persisted.

## Persistence Model

Most persistent UI and library state is stored through the shared hook in [src/hooks/usePersistentState.ts](/D:/Projects/Onyx-public/src/hooks/usePersistentState.ts).

The Rust persistence backend writes a versioned envelope per key, serializes in-process and cross-process writes, enforces size/schema/credential checks, and uses durable temporary-file replacement plus validated backups. Corrupt safe data can be quarantined and recovered from backup; unsafe credential-bearing or oversized legacy artifacts are not retained as recovery copies. Frontend migrations rewrite compatible legacy state to URL-free IDs while preserving user references where a safe old-to-new match exists.

Key persisted buckets:

- favorites
- recent channels
- hidden/collapsed groups
- saved sources
- source library index
- active source
- playlist snapshot
- EPG sources
- manual EPG mappings
- playback session
- saved volume
- automatic-resume presentation mode
- source-scoped hidden Movies and TV Shows category IDs

Playback session details:

- Current playback selection is tracked separately from the startup resume target.
- Any successfully playing channel can become the startup resume target.
- Startup presentation is not inferred from playback history. The separate General preference is authoritative and defaults to fullscreen.
- Startup restore must be a one-shot launch behavior. After launch completes, manual fullscreen enter and exit should never be overridden by the startup restore flow.
- Startup resume uses generation and fullscreen-revision guards so delayed native operations cannot override a newer manual playback or window action.

## Startup Flow

1. Hydrate the playback-critical persisted state: saved sources, active source, playback target, volume, resume preference, playlist snapshot, and compact selection.
2. Start all saved-source credential reads, but release playback startup as soon as the active source credential has settled; unrelated source credentials finish in the background.
3. Load the credential-free cached playlist snapshot immediately. A validated Xtream descriptor is playable after active credential hydration, while a remote M3U cache remains intentionally display-only until refresh.
4. Reconcile native fullscreen state explicitly with the General preference and issue the one-shot resume command for the exact cached target channel when materializable.
5. Refresh the active source catalog in the background when a playable cache exists; wait for refresh only when the requested target cannot be reconstructed safely.
6. Hydrate EPG credentials, load cached EPG directories, and refresh configured EPG sources independently of playback startup.

## Build And Release Files

- Authoritative JavaScript package metadata and dependency graph: [package.json](/D:/Projects/Onyx-public/package.json) and `package-lock.json` (npm only; use `npm ci`)
- Desktop version metadata: [src-tauri/tauri.conf.json](/D:/Projects/Onyx-public/src-tauri/tauri.conf.json) and [src-tauri/Cargo.toml](/D:/Projects/Onyx-public/src-tauri/Cargo.toml)
- Pinned toolchains: `.nvmrc`, `package.json#packageManager`, and `rust-toolchain.toml`
- Native provenance and verification: `src-tauri/lib/SOURCES.md`, `src-tauri/lib/SHA256SUMS`, and `scripts/verify-native-deps.ps1`; release inputs must come from the fixed recorded URLs and match both archive and extracted-file hashes
- Changelog: [CHANGELOG.md](/D:/Projects/Onyx-public/CHANGELOG.md)
- Release notes: `RELEASE_NOTES_v*.md`
- Release helper script: [Build Onyx Release.cmd](/D:/Projects/Onyx-public/Build%20Onyx%20Release.cmd)

When shipping a new version:

- bump package/package-lock, Cargo/Cargo.lock, Tauri, and release-helper versions together
- update `CHANGELOG.md`
- add a dated changelog section; tagged release automation extracts it as the curated public release notes
- verify pinned toolchains and native provenance
- run frontend/Rust checks before packaging
- build and smoke-test the Tauri release bundle; do not describe a release as complete until packaging, smoke testing, and final review are actually complete

## Testing Expectations

For most feature work, run:

- `npm run check`
- `npm test`
- `npm run build`
- `cargo check`

For release work, also run:

- the prerequisite, native-provenance, audit, fmt, and clippy gates listed in `README.md`
- `npm run tauri build`, followed by isolated installer/application smoke testing

## Implementation Guardrails

- Keep the app responsive with large libraries.
- Preserve the live-TV-first startup/resume path; VOD work must remain isolated, lazy, bounded, and credential-free at rest.
- Do not store Xtream passwords or remote M3U/EPG URLs in plaintext JSON, cache identifiers, logs, or diagnostics.
- Keep npm and `package-lock.json` authoritative; do not add another JavaScript lockfile.
- Do not break the transparent window/background requirement for native playback.
- If changing startup playback, verify both configured resume modes, exact-target cache readiness, active-source-first credential hydration, stale fullscreen probes, and cancellation by newer manual playback actions.
