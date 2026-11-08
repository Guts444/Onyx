# Onyx User Guide

Onyx is a Windows IPTV player for sources you already have. It does not provide channels, subscriptions, playlists, credentials, or guide data.

## Quick Start

1. Open **Settings** from the left navigation rail, then select **Sources**. You can also open **User Guide** above Settings and select **Open Sources**.
2. Choose one of the following:
   - **Import .m3u** to load a local `.m3u` or `.m3u8` file.
   - **Add M3U URL** to create a saved remote-playlist profile.
   - **Add Xtream** to create a saved Xtream profile.
3. For a saved profile, enter its details, leave it enabled, and select **Load Now**.
4. Open **Live TV**, optionally use the search field above the group list, select a group, then left-click a channel in the TV guide to start playback. Xtream sources can also expose **Movies** and **TV Shows** in the navigation rail.

Onyx caches the loaded library locally. Enabled saved remote sources can refresh when the app starts. Very large libraries still load, but Onyx does not keep them between launches: a saved URL or Xtream source reloads from the provider at the next start, and an imported file must be imported again. Onyx says so when that happens.

## Navigation And Controls

### Mouse

- **Left-click** navigation items, groups, channels, and buttons.
- **Right-click a channel row** to add or remove it from Favorites, or to assign an EPG listing.
- **Single-click a fullscreen movie or episode** to pause or resume it.
- **Double-click the Live mini player** to open the resizable player window; **double-click the video surface** to switch between the window and fullscreen.
- **Move the pointer over the player** to reveal playback controls.

### Escape key

- In fullscreen, press **Esc** to drop into a resizable window.
- With the Live TV player windowed, press **Esc** to return to the guide. With a movie or episode windowed, **Esc** stops playback and returns to the title, the same as **Quit**.
- An open channel context menu also closes with **Esc**.

Use the visible **Close** button to leave Settings or the EPG matching window.

## Browsing Channels

Open **Live TV** from the navigation rail to browse:

- **All channels**
- **Favorites**
- Any enabled playlist group

The main navigation, groups, and TV guide remain visible together. Use the search field above the groups to find channels by name across the current enabled library; the guide filters as you type. Clear the field to return to the selected group.

For very large groups, Onyx loads more channel rows as you scroll. You can also select **Show more channels** at the bottom.

## Favorites

1. Right-click a channel row.
2. Select **Add Favorite**.
3. Open **Live TV > Favorites** to browse saved favorites.

Right-click the channel again and select **Remove Favorite** to remove it.

## Player Controls

Left-click a channel to begin playback. The guide's mini player carries **Windowed**, **Fullscreen** and **Stop** buttons. They appear for five seconds when a channel starts playing, whenever the pointer is over the mini player, and when keyboard focus reaches them; otherwise they stay transparent so the video is unobstructed. In the player views, move the pointer to reveal:

- **Reload** — reopen the selected stream if playback stalls.
- **Stats** — show the diagnostics overlay.
- **Mute / Unmute**
- **Windowed** (fullscreen player) or **Fullscreen** (windowed player) — switch views without interrupting playback.
- **Guide** — return to the guide while the channel keeps playing in the mini player.
- **Volume**
- Current resolution and frame rate, when available

Double-click the mini player to open the resizable window. In fullscreen, **Esc** or a double-click drops into the window; **Esc** again, or **Guide**, returns to the guide. The window keeps the channel playing throughout, drops its minimum size to 480 x 270 while open, and comes back to its previous size and maximized state when you return to the guide. The windowed view is not remembered between launches. Onyx remembers the current volume and may resume the last playing channel when reopened.

### When a stream drops

Onyx retries a stream that stalls, drops, or ends early up to five times. The waits between attempts grow: **3 s, 10 s, 30 s and 60 s**, about a minute and three quarters in all. While it waits, the player shows a status card at the top of the video with a countdown such as "Retrying in 42 s (4 of 5)" and a **Retry now** button that starts that attempt at once without changing the retry count. Both appear in the guide's mini player and in every player view, including a 480 x 270 window. The card stays above the controls, so the countdown and button are never covered. A stream that never shows a frame gets a single retry before Onyx reports the failure; the failure card also carries a **Reload** button, and the players keep their own **Reload**. A retried movie or episode resumes where it stopped.

Open **Settings > General** to choose where automatic resume starts:

- **Windowed** — resumes in the resizable player window; the default for new installs.
- **Fullscreen** — resumes directly into fullscreen playback.
- **Mini-player** — resumes above the TV guide with navigation still visible.

Existing installs keep the mode they already use. Automatic startup resume remains Live-TV-only. Playing a movie or episode does not replace the saved live channel, and coming back to Live resumes the last channel unless you stopped it.

## Movies And TV Shows

Movies and TV shows are available for enabled Xtream sources when the provider exposes them. They are loaded on demand and never added to the Live TV startup path.

1. Open **Movies** or **TV Shows** from the navigation rail.
2. Select a provider if more than one enabled Xtream source is available.
3. Use the search field above the vertical group list to filter titles in the selected group.
4. Choose a group. Onyx loads one group at a time to avoid downloading the provider-wide catalog during ordinary browsing. Exceptionally large individual groups can still take time and memory to parse. Each group is capped at 20,000 valid titles; Onyx displays a notice when a provider response is truncated at that safety limit.
5. For a TV show, select a season and then an episode.

Movies and episodes open in the resizable player window; Onyx does not place a mini-player underneath the details card. Move the pointer to reveal controls; they hide again after a few idle seconds. Single-click the video to pause or resume, or double-click to switch to fullscreen. Playback includes 30-second rewind and forward skips, timeline seeking, detected resolution, mute, volume, one **Quit** action, and embedded subtitle-track selection when the media contains subtitles. **Esc** leaves fullscreen; once windowed, **Esc** or **Quit** stops playback and returns to the same title with its position saved. External sidecar subtitle URLs are not followed automatically.

Movie and series metadata and catalogs are held in memory for the current session and are not written into the Live TV playlist cache.

## Managing Sources

Open **Settings > Sources**.

### Local M3U or M3U8 file

Select **Import .m3u** and choose the file. To load a changed copy later, import the file again.

### Remote M3U URL

1. Select **Add M3U URL**.
2. Enter a profile name and playlist URL.
3. Keep the profile enabled.
4. Select **Load Now**.

### Xtream

1. Select **Add Xtream**.
2. Enter a profile name, domain, username, and password.
3. Keep the profile enabled.
4. Select **Load Now**.

You can collapse a saved source card by selecting its header. Disabling a profile prevents it from loading. **Delete Source** removes its saved profile, related credentials, and source-specific app data.

Remote M3U URLs and Xtream passwords are stored through Windows Credential Manager rather than in Onyx's ordinary settings files.

### Large playlists

Onyx accepts playlists up to 128 MB, including provider exports that mix live channels with large on-demand catalogs. While a playlist downloads and parses, **Settings > Sources** shows what stage it is in and, once parsing starts, a percentage. Select **Cancel** on the importing or loading row to stop; the library you already had stays open.

Playlists of roughly 100,000 channels or more are too large to keep between launches. They load normally and everything works for the session, but Onyx shows a notice when it happens:

- a saved **M3U URL** or **Xtream** source reloads from the provider the next time Onyx starts;
- an imported **.m3u file** has no saved source to reload, so import the file again.

## Hiding Or Restoring Groups

Open **Settings > Library** after loading a source, then choose **Live TV**, **Movies**, or **TV Shows**.

- Select **Enabled** beside a group to hide it.
- Select **Hidden** to restore it.
- Use **Enable all** or **Disable all** for the entire library.
- Use **Search groups** to find a group in a large playlist.

Hidden groups are excluded from the corresponding sidebar and search. Live TV visibility is saved per library; Movies and TV Shows visibility is saved independently for each Xtream provider.

## Adding An EPG Guide

Onyx accepts one or more XMLTV guide URLs.

1. Open **Settings > EPG**.
2. Select **Add EPG URL**.
3. Paste the XMLTV URL.
4. Select **Apply URL**.
5. Keep the guide enabled and select **Update Now**.

After a successful update, Onyx caches the guide locally and automatically matches channels where possible. You can configure each guide to update on startup or at a chosen interval while Onyx is open.

## Correcting An EPG Match

You must add, enable, and update at least one EPG guide first.

1. Right-click the channel row.
2. Select **Assign EPG**.
3. Search by channel name, `tvg-name`, or XMLTV channel ID.
4. Select **Apply Match** beside the correct listing.

To return to automatic matching, reopen the matcher and select **Clear Manual Match**.

## Troubleshooting

### A channel does not play

- Try **Reload** or select the channel again.
- Confirm the source is current and the channel URL is still valid.
- For a saved remote source, open **Settings > Sources** and select **Load Now**.
- If only some channels fail, the source may contain unavailable or unsupported stream entries.

### A source does not load

- Onyx now shows the actual reason, for example `The request failed with HTTP 403.`, `The response is larger than the 128 MB import limit.`, or a connection or TLS failure. The message can be forwarded as-is; Onyx removes credentials and URLs from it.
- For a saved profile, check the domain or URL in **Settings > Sources** and select **Load Now** again.

### The guide is empty or incorrect

- Open **Settings > EPG** and confirm the guide is enabled.
- Select **Update Now** and check the status shown in the EPG panel.
- Right-click the affected channel and assign the correct EPG listing manually.

### A group or channel is missing

- Open **Settings > Library** and restore any hidden groups.
- Clear the channel search or choose **All channels** in Live TV.

### Reporting a problem

Open a [GitHub issue](https://github.com/Guts444/Onyx/issues) with:

- your Onyx version
- whether it came from the Microsoft Store or GitHub Releases
- what you expected and what happened
- the exact error message, if one appeared

Do not include playlist URLs, Xtream credentials, EPG URLs, or screenshots that expose them.

## Privacy

Onyx has no advertising, analytics, telemetry, account sync, or developer-operated cloud backend. See the full [Privacy Policy](../PRIVACY.md) for storage and network details.
