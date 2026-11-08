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

- [src/App.tsx](src/App.tsx)
  Main app orchestration. Handles persistent state, source loading, player startup, guide windows, settings and guide dialogs, and the persistent live-TV layout.
- [src/App.css](src/App.css)
  Main application styling, including the guide layout, persistent sidebar, player shell styling, and settings/guide presentation.
- [src/components/ChannelSidebar.tsx](src/components/ChannelSidebar.tsx)
  Persistent left navigation rail plus the searchable group browser.
- [src/components/ChannelShelf.tsx](src/components/ChannelShelf.tsx)
  Guide-first main screen, including timeline rows and the channel context menu.
- [src/components/PlayerPanel.tsx](src/components/PlayerPanel.tsx)
  Shared embedded/fullscreen player shell and overlay chrome.
- [src/components/SettingsDrawer.tsx](src/components/SettingsDrawer.tsx)
  Settings container for General, Library, EPG, and saved sources.
- [src/components/GeneralSettingsPanel.tsx](src/components/GeneralSettingsPanel.tsx)
  General startup behavior, including the fullscreen/mini-player automatic-resume preference.
- [src/components/UserGuideDrawer.tsx](src/components/UserGuideDrawer.tsx)
  Keyboard-modal in-app quick guide with shortcuts into Sources and EPG settings.
- [src/components/VodBrowser.tsx](src/components/VodBrowser.tsx)
  Lazy Movies/TV Shows category browser, poster grid, metadata details, seasons, and episodes.
- [src/components/VodPlayerPanel.tsx](src/components/VodPlayerPanel.tsx)
  Fullscreen finite-media player controls for movies and episodes, including idle chrome and click/double-click gesture arbitration.
- [src/components/VodCategorySettingsPanel.tsx](src/components/VodCategorySettingsPanel.tsx)
  Lazy, source-scoped Movies/TV Shows group visibility management under Library settings.

## Core Domains

### Sources

- Saved source records live in [src/domain/sourceProfiles.ts](src/domain/sourceProfiles.ts).
- Source helpers live in [src/features/sources/profiles.ts](src/features/sources/profiles.ts).
- Xtream passwords and remote M3U URLs live in the OS credential store through [src/features/sources/secrets.ts](src/features/sources/secrets.ts).

Important rule:

- Source deletion must remove source-scoped saved data, not just the visible profile row.
- Secret writes/deletes must succeed before the corresponding source state is committed; stale hydration or source operations must not resurrect deleted or edited records.

### Playlists

- M3U parsing: [src/features/playlist/m3u.ts](src/features/playlist/m3u.ts)
- Remote playlist download: [src/features/playlist/remote.ts](src/features/playlist/remote.ts)
- Xtream import: [src/features/playlist/xtream.ts](src/features/playlist/xtream.ts)

### EPG

- Frontend domain/types: [src/domain/epg.ts](src/domain/epg.ts)
- Frontend API bridge: [src/features/epg/api.ts](src/features/epg/api.ts)
- Matching logic: [src/features/epg/matching.ts](src/features/epg/matching.ts)
- Rust cache/window logic: [src-tauri/src/epg.rs](src-tauri/src/epg.rs)
- EPG URL credential bridge: [src/features/epg/secrets.ts](src/features/epg/secrets.ts)

Important rule:

- Enabled XMLTV guides are merged for matching, but manual mappings are stored against stable playlist and guide identities rather than raw URLs.
- EPG downloads, decoded XML, caches, and warning samples are bounded; malformed programmes are skipped with safe diagnostics, and stale refresh generations cannot repopulate a deleted or superseded guide.

### Player

- Native player hook: [src/features/player/mpv.ts](src/features/player/mpv.ts)
- UI shell: [src/components/PlayerPanel.tsx](src/components/PlayerPanel.tsx)
- VOD UI shell: [src/components/VodPlayerPanel.tsx](src/components/VodPlayerPanel.tsx)

Important rules:

- The Tauri window and page background must remain transparent for libmpv video to show through.
- Decorative gradients belong on app panels, not on `html`, `body`, or `:root`.
- Startup autoplay resumes the last active channel according to the independent General preference: windowed (the default for new installs), fullscreen, or mini-player.
- Selecting a Live channel keeps the guide and plays it in the mini player. Double-clicking the mini player opens the windowed player; its own Fullscreen button opens fullscreen. The player views offer the other two views as buttons (**Windowed**/**Fullscreen** and **Guide**), and the mini player keeps **Stop**.
- The player must synchronize native video margins before every `loadfile`, reject unmounted/zero-size surfaces, and resynchronize on nested scrolling as well as resize/fullscreen changes.
- VOD play, pause, seek, stop, and fullscreen actions must never replace or clear the saved Live TV startup target.
- Live has one explicit display state (`guide`, `fullscreen`, `windowed`). [src/features/player/views.ts](src/features/player/views.ts) plans every transition: the view commits before the native window call, the window minimum and the pre-player window snapshot are applied after it, and a refused call rolls back to the view that matches the window that actually exists. A view change never issues a new `loadfile`.

### Video On Demand

- Frontend types: [src/domain/vod.ts](src/domain/vod.ts)
- Frontend provider bridge/materialization: [src/features/vod/api.ts](src/features/vod/api.ts) and [src/features/vod/model.ts](src/features/vod/model.ts)
- Rust response normalization: [src-tauri/src/vod.rs](src-tauri/src/vod.rs)

VOD is Xtream-only. Categories are fetched when a VOD section or its Library settings subsection is first opened, then one concrete category catalog is downloaded at a time. Responses have transport limits and a 20,000-valid-title per-category cap. The backend returns explicit truncation metadata and the browser displays a notice when the cap is reached. A very large category can still require substantial parsing, IPC, and renderer memory; category-first loading reduces that exposure rather than pretending it is paging. Catalog metadata stays in memory and materialized `/movie/` or `/series/` URLs exist only at the final libmpv playback boundary. The authenticated `server_info` playback origin is resolved separately from the login endpoint so providers with distinct stream hosts or ports work correctly. Category visibility is the exception: bounded hidden-category IDs are persisted independently per source and VOD kind.

## Main UI Behavior

### Persistent Live TV Layout

Outside fullscreen, the primary navigation rail, searchable group pane, preview player, and TV guide remain visible together. Group selection never hides the navigation. Search is a field above the groups rather than a separate primary-navigation destination, and it filters enabled channels directly in the guide while preserving deferred/incremental rendering for large libraries.

`Esc` leaves the fullscreen player, closes an open channel menu or dialog, and never walks through sidebar modes. Live TV has three views: the guide, the fullscreen player, and a windowed player that fills a normal resizable window. The mini player and the player views carry buttons for the views they can reach: **Windowed** and **Guide** in fullscreen, **Fullscreen** and **Guide** in the window, and **Fullscreen** plus **Stop** on the guide's mini player. `Esc` in fullscreen drops to the window; `Esc` in the window returns to the guide and restores the library window (size, maximized state, and minimum). A view change reuses the same mpv playback and never reopens the stream, and the windowed view is not saved between launches.

Leaving Live (for Movies, TV Shows, or a source change) stops the stream first, so a one-connection account never overlaps. Returning to Live resumes the channel recorded in the shared playback-session intent unless the user stopped it; a channel that is gone after a refresh leaves Live stopped, with no error.

### Guide Behavior

- Selecting `All channels`, `Favorites`, or a group updates the guide while leaving the navigation and groups visible.
- Right-clicking a guide row must expose favorite and EPG assignment actions.
- The preview player in the guide should stay close to a 16:9 frame.

### VOD Behavior

- Movies and TV Shows are destinations under Live TV in the persistent primary rail. Their search and visible vertical category list occupy the same persistent secondary-sidebar pattern used by Live TV.
- Selecting a movie or episode opens the shared native player in its windowed view. VOD has no embedded/mini-player details-page mode; **Quit**, or `Esc` from the windowed player, returns to the preserved details view.
- VOD chrome hides after pointer inactivity and reappears on movement. A delayed single-click toggles pause/resume; double-click cancels that pending toggle before switching views, and control events do not bubble into surface gestures.
- A finished title shows **Playback complete** instead of freezing on the last frame. A stalled or dropped title retries and re-opens at the last known position.
- The player offers **Fullscreen** while windowed and **Windowed** while fullscreen, plus **Quit**. Double-click switches views at any time; `Esc` leaves fullscreen and, once windowed, is Quit through the same path as the button (position saved, window restored, Resume row shown), so it can never leave an orphaned player behind. The panel fills the window and the library stays mounted but hidden, which is what restores the same details view (and its scroll position) on Quit. A title that starts windowed and later goes fullscreen still restores on Quit.
- The window is not a saved setting. While windowed, the minimum drops to 480x270 and the controls switch to a compact single row; Quit puts the 1100x700 minimum back and then restores the pre-VOD window: by maximizing when the title started from a maximized window, by resizing only when the current window would be smaller than the library minimum, and never by moving it. A crash or a close while windowed relaunches at the normal size.
- A saved position turns the action into **Resume from m:ss** with a separate **Start over**, for both movies and individual episodes. Positions are keyed by source, kind and the provider's own id (never the URL), saved between 10 s and 95% of a known duration, flushed every ten seconds while a title plays and once more on Quit, capped at 500 entries, and dropped when their source is removed.
- Category catalogs and detail payloads load only after the user opens the corresponding section/title.
- Poster images are lazy, card rendering is incremental, and switching away preserves the already loaded in-memory section state for the session.
- Series episode maps are authoritative; season metadata is optional decoration.
- Embedded subtitles come from mpv's `track-list`. Arbitrary provider sidecar subtitle URLs are not followed or persisted.

### Playback Recovery

[src/features/player/recovery.ts](src/features/player/recovery.ts) is a pure state machine. [src/features/player/mpv.ts](src/features/player/mpv.ts) feeds it loader, first-frame, progress, buffering, pause, seek, end-of-stream, and load-failure events and runs the only timer (1 s). Thresholds and the ladder are documented in `HANDOFF-onyx-v0.7.0-2026-11-06.md` section 9.

- **First frame, not metadata.** The UI reports playing only after `playback-restart`. `file-loaded` means the headers parsed; audio-only streams reach `playback-restart` too.
- **Triggers.** No frame within 20 s, 15 s without progress while `paused-for-cache` is set (30 s otherwise), an mpv error before the first frame, or a clean end of a live stream.
- **Ladder.** 1/2/4/8 second delays, at most five attempts. A failure before the first frame is refusal-shaped (the pinned wrapper cannot report HTTP status) and gets one retry, but only if the media has never played in this ladder. The ladder resets after 60 s of sustained progress.
- **VOD completion.** A title is complete only when the position reaches the end of a known duration. The duration is the provider's declared value when the catalog supplied one, then the longest value mpv has reported; a shrinking duration is ignored. An early EOF retries from the last position, and a retry that hits EOF again without advancing is the real end, so a truncated title cannot loop.
- **Pause across loads.** `keep-open` leaves `pause=true` at EOF, and mpv preserves it across `loadfile`; every load clears it explicitly or a retry silently starts paused.
- **One connection.** A retry is a fresh `loadfile replace`; mpv closes the previous stream first, and the server-side connection count is expected to peak at one.
- **User actions win.** Any new playback, stop, or source change cancels a pending retry. The `end-file stop` produced by Onyx's own `loadfile replace` is consumed and never shown as a user stop.
- **mpv EOF semantics.** With `keep-open=yes`, libavformat reports a closed stream or a mid-stream reset as EOF: no `end-file` arrives. Recovery therefore watches `eof-reached` and progress rather than `end-file`. HLS live reloads (`end-file` immediately followed by `start-file`) belong to mpv and are ignored.
- **No logs.** The pinned `libmpv-wrapper` never calls `mpv_request_log_messages`, so `log-message` events never reach Onyx. Recovery cannot distinguish a 403 from a 500 and classifies by timing instead.

### Diagnostics

[src/features/player/diagnostics.ts](src/features/player/diagnostics.ts) owns the readable form; [useDiagnostics.ts](src/features/player/useDiagnostics.ts) owns the reads.

- **Only while open.** The polling effect is mounted by the overlay's open flag and reads a fixed set of eleven properties about once a second; closed, nothing is read at all.
- **Fixed property set.** Codec, size, estimated fps, `hwdec-current`, cache time/speed/fill, frame drops, and the recovery snapshot. `path`, `stream-open-filename`, `media-title` and anything else that can carry a URL or a credential are never read.
- **Redacted twice.** Recovery errors are redacted before they reach the screen, and the whole block is redacted again when formatted: URLs, `user:pass@` segments and Xtream-style paths become `[removed]`.
- **A dash, never an error.** An unavailable property formats as `—`; a failed read leaves its row empty for that tick instead of surfacing an exception.

## Persistence Model

Most persistent UI and library state is stored through the shared hook in [src/hooks/usePersistentState.ts](src/hooks/usePersistentState.ts).

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
- automatic-resume presentation mode (windowed, fullscreen, or mini-player; new installs resolve to windowed, profiles with saved sources or a playback intent keep fullscreen when the key was never stored)
- source-scoped hidden Movies and TV Shows category IDs
- saved VOD positions (one entry per source, kind and provider id)

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
4. Reconcile native fullscreen state explicitly with the General preference (windowed, fullscreen, or mini-player) and issue the one-shot resume command for the exact cached target channel when materializable.
5. Refresh the active source catalog in the background when a playable cache exists; wait for refresh only when the requested target cannot be reconstructed safely.
6. Hydrate EPG credentials, load cached EPG directories, and refresh configured EPG sources independently of playback startup.

## Build And Release Files

- Authoritative JavaScript package metadata and dependency graph: [package.json](package.json) and `package-lock.json` (npm only; use `npm ci`)
- Desktop version metadata: [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) and [src-tauri/Cargo.toml](src-tauri/Cargo.toml)
- Pinned toolchains: `.nvmrc`, `package.json#packageManager`, and `rust-toolchain.toml`
- Native provenance and verification: `src-tauri/lib/SOURCES.md`, `src-tauri/lib/SHA256SUMS`, and `scripts/verify-native-deps.ps1`; release inputs must come from the fixed recorded URLs and match both archive and extracted-file hashes
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Release notes: `RELEASE_NOTES_v*.md`
- Release helper script: [Build Onyx Release.cmd](Build%20Onyx%20Release.cmd)

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
