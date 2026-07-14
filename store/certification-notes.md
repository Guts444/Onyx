# Microsoft Store certification notes — Onyx-IPTV

Onyx is a client application for user-supplied playlists, streams, Xtream accounts, and XMLTV guides. It does not provide channels, subscriptions, credentials, guide data, or media content, and no login is required.

## Fast functional test

Use these public, noncredentialed certification fixtures from the Onyx repository:

- M3U playlist: https://raw.githubusercontent.com/Guts444/Onyx/main/store/test-content/onyx-demo.m3u
- XMLTV guide: https://raw.githubusercontent.com/Guts444/Onyx/main/store/test-content/onyx-demo.xml

The playlist references Google's public Shaka Player demonstration HLS asset. It is included only to make playback testable during certification and is not bundled with the application.

1. Launch Onyx.
2. Open **Settings**, then **Sources**.
3. Add the M3U URL above and load the source.
4. Open the **Onyx Certification Demo** group.
5. Select **Onyx Demo Stream** and verify that native playback starts.
6. Optional EPG test: open **Settings**, then **EPG**, add the XMLTV URL above, refresh it, and verify the demo programme can be matched to the demo channel.
7. Verify favorites, mute, volume, and fullscreen controls from the player interface.

## Technical notes

- Target: Windows 10/11 desktop x64.
- WebView2 is expected to be present as a Windows system component.
- Native playback uses the bundled `libmpv-2.dll` and `libmpv-wrapper.dll` in the package `lib` directory.
- The `runFullTrust` restricted capability is required for this packaged Tauri desktop application and native libmpv playback.
- Network access is used only for URLs and services configured by the user.
- Remote playlist/guide URLs and Xtream passwords are stored in Windows Credential Manager.
- Onyx has no advertising, telemetry, analytics, account service, cloud backend, or in-app purchases.

## Content and authorization

Onyx does not curate, sell, recommend, or supply IPTV services. Users are responsible for ensuring they are authorized to use every source and service they configure. The Store screenshots contain only neutral application UI and no broadcaster or third-party service branding.
