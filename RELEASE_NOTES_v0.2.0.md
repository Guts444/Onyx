# Onyx v0.2.0

Second public release of Onyx, focused on adding XMLTV EPG support and making channel browsing feel more like a proper IPTV app instead of a raw playlist viewer.

## What's New

- XMLTV EPG URL support, including compressed `.xml.gz` guides
- EPG settings with update now, auto update, and update on startup
- Manual per-channel EPG matching from the channel shelf
- Saved EPG mappings that persist after closing and reopening the app
- Now and next guide info shown in the channel shelf and player overlay

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

- `Onyx_0.2.0_x64_en-US.msi`
- `Onyx_0.2.0_x64-setup.exe`

End users do not need Rust, Node.js, or manual DLL setup when installing from these release files.

## Notes

- Onyx is local-first and does not use telemetry or cloud sync.
- Saved source details, EPG settings, guide mappings, and playback preferences stay on the machine running the app.
- This release is focused on Windows desktop usage.

## Feedback

If you run into a bug or want to suggest an improvement, open an issue on GitHub.
