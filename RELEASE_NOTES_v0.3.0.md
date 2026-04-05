# Onyx v0.3.0

Third public release of Onyx, focused on turning EPG support into something that works better for real-world setups with multiple countries, providers, or backup guide feeds.

## What's New

- Support for saving multiple XMLTV EPG sources at the same time
- Per-guide enable, disable, remove, update now, auto update, and update on startup controls
- Enabled guides are merged together when matching channels, so one channel list can pull from multiple guide sources
- Cached guide data is stored per XMLTV source
- EPG settings layout is more compact, and the channel shelf gives more room back to the channel list

## Existing Features

- Native IPTV playback through `libmpv`
- Local playlist import for `.m3u` and `.m3u8`
- Remote M3U URL import
- Xtream live login import
- Saved source profiles restored on startup
- Pinned Favorites group
- Library-wide Recents view
- Group visibility controls and group search
- Resume last playing channel and volume on startup

## Downloads

Windows installers are attached to this release:

- `Onyx_0.3.0_x64_en-US.msi`
- `Onyx_0.3.0_x64-setup.exe`

End users do not need Rust, Node.js, or manual DLL setup when installing from these release files.

## Notes

- Onyx is local-first and does not use telemetry or cloud sync.
- Saved source details, EPG source settings, guide mappings, and playback preferences stay on the machine running the app.
- This release is focused on Windows desktop usage.

## Feedback

If you run into a bug or want to suggest an improvement, open an issue on GitHub.
