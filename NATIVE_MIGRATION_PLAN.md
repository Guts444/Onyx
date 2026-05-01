# Onyx Native Windows Migration Plan

This plan creates a conservative path from the current Tauri + React + TypeScript + WebView2 shell to a side-by-side native Windows app built with C# + WinUI 3 + Windows App SDK.

The current Tauri app remains the stable release path. The native app lives under `src-winui/` and must not replace or rewrite the Tauri app until feature parity is proven.

## 1. Current Architecture Summary

Onyx is a local-first, Windows-focused live TV IPTV player.

Current stable stack:

- UI: React 19 + TypeScript + Vite in `src/`.
- Desktop host: Tauri v2 in `src-tauri/`.
- Windows UI runtime: system Microsoft Edge WebView2 through Tauri.
- Playback: native `libmpv` through `tauri-plugin-libmpv`; playback is already native, while the app shell is WebView-based.
- Backend commands: Rust in `src-tauri/src/lib.rs` and `src-tauri/src/epg.rs`.
- Local state: Tauri app-local JSON state files through `load_app_state` / `save_app_state`.
- Secrets: Xtream passwords are stored through Rust `keyring`, not in app-state JSON.
- EPG cache: Rust downloads, parses, and caches XMLTV data locally.

Important current boundaries:

- Product scope is live TV only.
- No telemetry, cloud backend, account sync, or hosted user data.
- Remote playlist and XMLTV fetches are size-limited and handled outside the browser.
- Xtream passwords are scrubbed from saved source JSON.
- Startup resume only resumes the channel captured from fullscreen playback.

Primary frontend orchestration is currently concentrated in `src/App.tsx`. It coordinates persistence hydration, source loading, playlist snapshots, EPG refreshes, search/group filtering, sidebar modes, player state, fullscreen state, and startup resume.

## 2. TypeScript/Rust To C# Mapping

| Current module | Responsibility | Native target |
| --- | --- | --- |
| `src/App.tsx` | App orchestration, hydration, source loading, sidebar state, EPG refresh, startup playback resume | `MainViewModel`, later split into `ShellViewModel`, `LiveTvViewModel`, `SettingsViewModel`, `PlaybackSessionService` |
| `src/domain/iptv.ts` | `Channel`, `PlaylistImport`, live library types | `Onyx.Native.Core.Models.Channel`, `PlaylistImport` |
| `src/domain/sourceProfiles.ts` | Saved source records, playlist snapshots, source-library index | `SavedPlaylistSource`, future `PlaylistSnapshot`, `SourceLibraryIndex` |
| `src/domain/epg.ts` | EPG source settings, directory/programme models, snapshot/window helpers | `EpgSource`, `EpgProgrammeSummary`, future EPG cache/window models |
| `src/features/playlist/m3u.ts` | Local M3U/M3U8 parser | `M3uPlaylistParser` |
| `src/features/playlist/channelFactory.ts` | Label cleanup, stream normalization, channel IDs, playable protocol filter | `ChannelFactory` |
| `src/features/playlist/remote.ts` | Remote M3U URL bridge to Rust fetch command | Future `RemotePlaylistImportService` |
| `src/features/playlist/xtream.ts` | Xtream live import bridge to Rust command | `LocalPlaylistImportService.ImportXtreamLiveAsync`; future dedicated `XtreamImportService` split |
| `src/features/sources/profiles.ts` | Source creation, readiness, loaded timestamps, secret scrubbing, source-library index merge | `ISourceProfileService`, future source profile view models and cleanup service |
| `src/features/sources/secrets.ts` | Tauri bridge for OS credential store | `ICredentialService`, `WindowsCredentialService` |
| `src/hooks/usePersistentState.ts` | Persistent local JSON state with legacy localStorage migration | `IPersistenceService`, `JsonFilePersistenceService`, future migration reader for existing Tauri state |
| `src/features/epg/api.ts` | Tauri command bridge for EPG cache operations | `IEpgService`, future `XmltvEpgCacheService` |
| `src/features/epg/matching.ts` | EPG channel index, automatic matching, manual mapping lookup/search | Future `EpgMatchingService` |
| `src/features/player/mpv.ts` | libmpv lifecycle, commands, observed properties, margin sync, browser fallback | `MpvPlaybackService` prototype using a child HWND; future full `LibMpvPlaybackService` with events/volume/overlay parity |
| `src/components/ChannelSidebar.tsx` | Left rail, search, group navigation | WinUI `NavigationView`, group/search panel, `LiveTvViewModel` |
| `src/components/ChannelShelf.tsx` | Guide grid, selected programme, incremental channel rendering, row context menu | WinUI virtualized guide view, likely `ItemsRepeater`/`ListViewBase` plus guide row view models |
| `src/components/PlayerPanel.tsx` | Embedded/fullscreen player shell and overlay controls | Native player panel view, overlay command bar, fullscreen window/state service |
| `src/components/SettingsDrawer.tsx` | Library, EPG, and saved source settings container | Native Settings view |
| `src/components/SourceProfilesPanel.tsx` | Saved M3U/Xtream source editor | Native source profile settings |
| `src/components/EpgSettingsPanel.tsx` | XMLTV source settings and refresh UI | Native EPG settings |
| `src/components/ChannelEpgMatchDialog.tsx` | Manual EPG assignment UI | Native content dialog |
| `src-tauri/src/lib.rs` | App JSON state, secure Xtream password commands, remote M3U fetch, Xtream live import | C# persistence, credential, HTTP import services |
| `src-tauri/src/epg.rs` | XMLTV/gzip download, parse, cache, programme snapshots/windows | `XmltvEpgCacheService`, likely backed by SQLite or chunked files |
| `src-tauri/tauri.conf.json` | Tauri release metadata, transparent WebView window, bundled mpv DLLs | Separate native packaging project; do not modify Tauri release config |

## 3. Feature Parity Checklist

Legend:

- `[x]` implemented in the first native prototype.
- `[~]` scaffolded or partially stubbed.
- `[ ]` not implemented yet.

### Source And Library

- `[x]` Side-by-side native project under `src-winui/`.
- `[x]` Local M3U/M3U8 file import.
- `[x]` M3U channel/group parsing.
- `[x]` Stream protocol validation and unavailable-channel marking.
- `[x]` Native virtualized group and channel lists through WinUI `ListView`.
- `[x]` Channel selection starts the native playback path.
- `[x]` Favorites persist locally.
- `[x]` Recents persist locally.
- `[~]` Saved source profile interfaces and local profile storage.
- `[ ]` Remote M3U URL import.
- `[x]` Xtream live import for live TV categories/streams.
- `[ ]` Existing Tauri state migration/import.
- `[ ]` Hidden groups.
- `[ ]` Collapsed groups and collapsed source cards.
- `[ ]` Source-scoped cleanup when a saved source is deleted.
- `[ ]` Cached playlist snapshot restore.
- `[ ]` Active source restore.

### EPG

- `[~]` EPG source and programme summary models.
- `[~]` EPG service interface and stub.
- `[ ]` XMLTV URL settings UI.
- `[ ]` XMLTV download and gzip decode.
- `[ ]` Cached EPG storage.
- `[ ]` Multiple enabled XMLTV sources.
- `[ ]` Automatic EPG matching.
- `[ ]` Manual EPG matching.
- `[ ]` Now/next programme display.
- `[ ]` Programme window loading for guide rows.
- `[ ]` Startup EPG refresh scheduling/staggering.

### Playback

- `[~]` Playback session model.
- `[x]` Playback service interface.
- `[x]` Native libmpv host prototype using a Win32 child surface.
- `[x]` Stop control.
- `[ ]` Player overlay controls.
- `[ ]` Reload/mute/volume controls.
- `[ ]` Volume persistence.
- `[ ]` Resolution/FPS display.
- `[~]` Basic fullscreen window toggle.
- `[ ]` Fullscreen-only startup resume.

### App Shell And Settings

- `[x]` Native Windows 11-style shell.
- `[x]` Left navigation rail.
- `[x]` Live TV view.
- `[x]` Settings placeholder.
- `[x]` Dark Onyx theme resources.
- `[x]` MVVM structure.
- `[ ]` Full settings implementation.
- `[ ]` Keyboard behavior parity, including `Esc` sidebar/fullscreen rules.
- `[ ]` Release packaging.

### Privacy And Security

- `[x]` Native project has no telemetry, cloud service, account sync, WebView2 UI, Electron, Tauri, React, or embedded browser.
- `[x]` Credential service interface added.
- `[x]` Windows credential service uses Windows `PasswordVault`; Xtream passwords are not part of saved source JSON.
- `[~]` Xtream stream URL persistence redaction/encryption; current native prototype does not persist playlist snapshots, but in-memory stream URLs can contain provider credentials.
- `[ ]` Native security review for remote imports and EPG fetch limits.

## 4. Risks

### libmpv Integration

Current Tauri playback uses `tauri-plugin-libmpv`, a transparent Tauri window, and margin synchronization so the native video remains visible behind WebView UI. WinUI needs a different strategy: a native child window, swap chain, composition surface, or dedicated panel hosting approach. This should be prototyped before claiming playback parity.

Mitigation:

- Keep player code behind `IPlaybackService`.
- Do a small libmpv host spike before porting the full overlay.
- Preserve existing mpv DLL release assets until native packaging is ready.
- Keep playback shell controls separate from the low-level video surface.

### Large Guide Virtualization

The current React guide limits initial channel rendering and loads rows in batches. A native guide can still become slow if every channel row and every programme segment is materialized.

Mitigation:

- Use WinUI virtualization (`ListViewBase`, `ItemsRepeater`, or `ItemsView`) for channel/guide rows.
- Keep guide row view models lightweight.
- Load programme windows only for visible or near-visible rows.
- Add performance tests with tens of thousands of channels before replacing the Tauri guide.

### EPG Cache Performance

The Rust EPG cache currently serializes all guide data into local JSON. This is workable now, but native migration is a good point to avoid a single giant JSON file becoming the long-term contract.

Mitigation:

- Consider SQLite for EPG channel/programme storage.
- Index by source URL, channel key, start time, and stop time.
- Keep XMLTV download/decompression size limits.
- Preserve per-guide source metadata and manual mapping scopes.

### Fullscreen Behavior

Current fullscreen behavior is subtle. `Esc` exits fullscreen first; sidebar state has its own `hidden -> groups -> menu` behavior; startup resume is one-shot and only uses the last channel sent fullscreen.

Mitigation:

- Put fullscreen and startup resume in a dedicated `PlaybackSessionService`.
- Add tests around resume state transitions.
- Avoid coupling fullscreen state to ordinary preview browsing.

### Credential Storage

The native project must not write Xtream passwords to JSON. The prototype saves remembered Xtream passwords through Windows `PasswordVault` and stores only source metadata in JSON.

Additional risk: Xtream stream URLs can embed username/password. The existing playlist snapshot can therefore persist credential-bearing stream URLs even when the password field is scrubbed.

Mitigation:

- Store Xtream passwords only in Windows Credential Manager/PasswordVault or DPAPI-protected storage.
- Treat source JSON as non-secret metadata.
- For Xtream channels, persist provider stream IDs and rebuild URLs at playback/import time where feasible.
- If stream URLs must be cached, encrypt the snapshot or redact credential segments.

### Build Tooling

WinUI 3 CLI builds need .NET plus Windows App SDK/Windows SDK build tooling. The prototype enables package-local MSIX tooling and references `Microsoft.Windows.SDK.BuildTools` so it can build from `dotnet build` without modifying the stable Tauri build.

Mitigation:

- Document Visual Studio 2022 or Build Tools prerequisites.
- Keep native app build separate from existing npm/cargo release scripts.
- Do not gate Tauri releases on native app builds until CI has the required Windows workload.

## 5. Phased Migration Plan

### Phase 0: Side-by-side foundation

Status: started.

- Add `src-winui/Onyx.Native/` WinUI app.
- Add `src-winui/Onyx.Native.Core/` for domain, parser, service contracts, and testable logic.
- Add `src-winui/Onyx.Native.Tests/` for parser/domain tests.
- Keep Tauri files and release scripts unchanged.
- Add migration docs and README warning that WinUI is experimental.

Exit criteria:

- Native solution restores.
- Core/tests build.
- WinUI app builds on a machine with WinUI/Windows packaging prerequisites.
- Existing Tauri checks still pass.

### Phase 1: Local M3U vertical slice

Status: started.

- Port M3U parser and channel factory.
- Load local `.m3u` / `.m3u8` through native file picker.
- Show groups and channels in virtualized native controls.
- Select a channel and start the native playback path.
- Persist favorites and recents locally.

Exit criteria:

- Parser unit tests cover metadata, groups, fallback groups, unsupported streams, and skipped entries.
- Large local playlists can be loaded without blocking future guide work.

### Phase 2: Source profiles and remote imports

- Port remote M3U HTTP import with size limits and protocol validation.
- Port Xtream live import with authentication, live categories, live streams, and output extension selection.
- Implement saved source profile UI.
- Store Xtream passwords through `ICredentialService`.
- Add source deletion cleanup.

Exit criteria:

- Saved M3U URL and Xtream live sources can be loaded and reloaded.
- Passwords never appear in source JSON.
- Existing Tauri app still remains the release path.

### Phase 3: Native EPG cache and matching

- Port XMLTV download/decompression/parsing.
- Decide on JSON chunks vs SQLite before importing large guides.
- Port EPG matching and manual mapping scope rules.
- Add EPG settings UI and manual match dialog.
- Add now/next and programme-window loading for visible channel rows.

Exit criteria:

- Multiple XMLTV sources merge for matching.
- Manual mappings preserve playlist/source and guide URL scope.
- Large EPG caches do not freeze startup.

### Phase 4: Native playback

- Prototype libmpv host in WinUI without WebView2.
- Implement playback commands and observed properties.
- Add player overlay controls.
- Add volume persistence.
- Add fullscreen behavior and `Esc` handling.
- Add fullscreen-only startup resume.

Exit criteria:

- Local and remote live streams play through native libmpv.
- Overlay controls match current major behavior.
- Fullscreen behavior matches the Tauri app.

### Phase 5: Performance and parity hardening

- Stress test large playlists and large EPG caches.
- Add virtualization tests and profiling.
- Add migration/import from existing Tauri local state where safe.
- Harden error handling for malformed playlists, remote failures, and corrupted cache files.
- Expand unit tests for parser, source profiles, EPG matching, and playback-session transitions.

Exit criteria:

- Native app meets or exceeds current Tauri responsiveness for large libraries.
- No plaintext credential regression.
- No live-TV scope creep.

### Phase 6: Packaging and release decision

- Add native packaging without changing Tauri release scripts.
- Keep Tauri as stable until native feature parity is validated.
- Release native builds as experimental previews only.
- Decide later whether native becomes the primary release, remains side-by-side, or replaces Tauri after a full parity checklist review.

Exit criteria:

- Native preview installer/package is reproducible.
- Tauri release pipeline remains working.
- Native parity is documented honestly before any stable switch.
