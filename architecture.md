# Onyx Architecture

Read this before making feature changes. It captures the current product boundaries, state model, and the files that matter most.

## Product Scope

Onyx is a local-first Windows IPTV player built with Tauri, React, and libmpv.

Current product constraints:

- Live TV only. Do not add VOD movies or TV-show library work unless explicitly requested.
- Fast startup and responsive guide browsing matter more than loading every possible provider feature.
- Saved sources, favorites, guide mappings, and playback state are local to the machine.
- Xtream passwords must stay out of JSON state files and remain in the OS credential store.

## Stack

- Frontend: React 19 + TypeScript + Vite
- Desktop shell: Tauri v2
- Native playback: `tauri-plugin-libmpv`
- Backend services: Rust commands in `src-tauri`
- Persistence: JSON app-state files managed through the frontend persistent-state hook, plus OS keyring secrets for Xtream passwords

## High-Level Layout

- [src/App.tsx](/D:/Projects/Onyx-public/src/App.tsx)
  Main app orchestration. Handles persistent state, source loading, player startup, guide windows, settings drawer state, and the sidebar/guide navigation flow.
- [src/App.css](/D:/Projects/Onyx-public/src/App.css)
  Main application styling, including the guide layout, sidebar modes, player shell styling, and settings drawer presentation.
- [src/components/ChannelSidebar.tsx](/D:/Projects/Onyx-public/src/components/ChannelSidebar.tsx)
  Left navigation rail plus search/group browser.
- [src/components/ChannelShelf.tsx](/D:/Projects/Onyx-public/src/components/ChannelShelf.tsx)
  Guide-first main screen, including timeline rows and the channel context menu.
- [src/components/PlayerPanel.tsx](/D:/Projects/Onyx-public/src/components/PlayerPanel.tsx)
  Shared embedded/fullscreen player shell and overlay chrome.
- [src/components/SettingsDrawer.tsx](/D:/Projects/Onyx-public/src/components/SettingsDrawer.tsx)
  Settings container for library, EPG, and saved sources.

## Core Domains

### Sources

- Saved source records live in [src/domain/sourceProfiles.ts](/D:/Projects/Onyx-public/src/domain/sourceProfiles.ts).
- Source helpers live in [src/features/sources/profiles.ts](/D:/Projects/Onyx-public/src/features/sources/profiles.ts).
- Xtream secrets live in the OS credential store through [src/features/sources/secrets.ts](/D:/Projects/Onyx-public/src/features/sources/secrets.ts).

Important rule:

- Source deletion must remove source-scoped saved data, not just the visible profile row.

### Playlists

- M3U parsing: [src/features/playlist/m3u.ts](/D:/Projects/Onyx-public/src/features/playlist/m3u.ts)
- Remote playlist download: [src/features/playlist/remote.ts](/D:/Projects/Onyx-public/src/features/playlist/remote.ts)
- Xtream import: [src/features/playlist/xtream.ts](/D:/Projects/Onyx-public/src/features/playlist/xtream.ts)

### EPG

- Frontend domain/types: [src/domain/epg.ts](/D:/Projects/Onyx-public/src/domain/epg.ts)
- Frontend API bridge: [src/features/epg/api.ts](/D:/Projects/Onyx-public/src/features/epg/api.ts)
- Matching logic: [src/features/epg/matching.ts](/D:/Projects/Onyx-public/src/features/epg/matching.ts)
- Rust cache/window logic: [src-tauri/src/epg.rs](/D:/Projects/Onyx-public/src-tauri/src/epg.rs)

Important rule:

- Enabled XMLTV guides are merged for matching, but manual mappings are still stored per playlist scope and guide URL.

### Player

- Native player hook: [src/features/player/mpv.ts](/D:/Projects/Onyx-public/src/features/player/mpv.ts)
- UI shell: [src/components/PlayerPanel.tsx](/D:/Projects/Onyx-public/src/components/PlayerPanel.tsx)

Important rules:

- The Tauri window and page background must remain transparent for libmpv video to show through.
- Decorative gradients belong on app panels, not on `html`, `body`, or `:root`.
- Startup autoplay should only resume the last channel saved from fullscreen playback, not ordinary mini-player browsing.

## Main UI Behavior

### Sidebar State Machine

The live browser intentionally works in three modes:

- `hidden`: full guide focus
- `groups`: library/groups only
- `menu`: full left rail with `Search`, `Live TV`, and `Settings`

Expected `Esc` behavior:

1. From full guide, `Esc` opens `groups`
2. From `groups`, `Esc` opens `menu` and lands on `Search`
3. Fullscreen `Esc` exits fullscreen first

This behavior is coordinated in [src/App.tsx](/D:/Projects/Onyx-public/src/App.tsx).

### Guide Behavior

- Selecting `All channels`, `Favorites`, or a group should hide the sidebar and give the guide the full screen width.
- Right-clicking a guide row must expose favorite and EPG assignment actions.
- The preview player in the guide should stay close to a 16:9 frame.

## Persistence Model

Most persistent UI and library state is stored through the shared hook in [src/hooks/usePersistentState.ts](/D:/Projects/Onyx-public/src/hooks/usePersistentState.ts).

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

Playback session details:

- Current playback selection is tracked separately from the startup resume target.
- The startup resume target is updated only when a channel is sent fullscreen.
- Startup restore should bring back both the saved channel and fullscreen mode when the saved resume target was captured from fullscreen playback.
- Startup restore must be a one-shot launch behavior. After launch completes, manual fullscreen enter and exit should never be overridden by the startup restore flow.

## Startup Flow

1. Hydrate persistent frontend state.
2. Restore Xtream passwords from the OS keyring into live in-memory source state.
3. Load cached playlist snapshot immediately if available.
4. If the active saved source exists, refresh it in the background or foreground depending on cache availability.
5. Load cached EPG directories.
6. Refresh enabled EPG sources on startup if configured.
7. Resume the saved fullscreen startup channel once the active source and player are ready.

## Build And Release Files

- Versioned frontend package: [package.json](/D:/Projects/Onyx-public/package.json)
- Desktop version metadata: [src-tauri/tauri.conf.json](/D:/Projects/Onyx-public/src-tauri/tauri.conf.json) and [src-tauri/Cargo.toml](/D:/Projects/Onyx-public/src-tauri/Cargo.toml)
- Changelog: [CHANGELOG.md](/D:/Projects/Onyx-public/CHANGELOG.md)
- Release notes: `RELEASE_NOTES_v*.md`
- Release helper script: [Build Onyx Release.cmd](/D:/Projects/Onyx-public/Build%20Onyx%20Release.cmd)

When shipping a new version:

- bump the version in package and Tauri metadata
- update `CHANGELOG.md`
- add a new `RELEASE_NOTES_vX.Y.Z.md`
- build the Tauri release bundle

## Testing Expectations

For most feature work, run:

- `npm run check`
- `npm test`
- `npm run build`
- `cargo check`

For release work, also run:

- `npm run tauri build`

## Implementation Guardrails

- Keep the app responsive with large libraries.
- Preserve the live-TV-first design and avoid feature creep into VOD by default.
- Do not store Xtream passwords in plaintext JSON.
- Do not break the transparent window/background requirement for native playback.
- If changing startup playback, verify the fullscreen-only resume rule still holds.
