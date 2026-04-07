# Changelog

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
