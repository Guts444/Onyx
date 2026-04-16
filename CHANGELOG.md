# Changelog

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
