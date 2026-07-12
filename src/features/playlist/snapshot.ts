import type { Channel } from "../../domain/iptv";
import type { PlaylistSnapshot } from "../../domain/sourceProfiles";
import { redactCredentials } from "./redaction.ts";

export const DISPLAY_ONLY_ERROR = "Refresh this saved source before playback.";

export function isDisplayOnlyChannel(channel: Channel) {
  return (
    channel.stream === null &&
    channel.originalStream === null &&
    channel.streamDescriptor?.kind === "remote-m3u" &&
    !channel.isPlayable
  );
}

export function isPlaylistSnapshotPlaybackReady(snapshot: PlaylistSnapshot) {
  return snapshot.playlist.channels.some(
    (channel) =>
      (channel.isPlayable && channel.stream !== null) ||
      (channel.isPlayable && channel.streamDescriptor?.kind === "xtream"),
  );
}

export function shouldRefreshPlaylistSnapshot(snapshot: PlaylistSnapshot) {
  return snapshot.sourceId !== null && !isPlaylistSnapshotPlaybackReady(snapshot);
}

export function sanitizePlaylistSnapshot(snapshot: PlaylistSnapshot): PlaylistSnapshot {
  if (snapshot.sourceId === null) {
    return snapshot;
  }

  const channels = snapshot.playlist.channels.map((channel) => {
    const sanitizedDisplayFields = {
      logo: channel.logo === null ? null : redactCredentials(channel.logo),
      playabilityError:
        channel.playabilityError === null ? null : redactCredentials(channel.playabilityError),
    };

    if (
      channel.stream === null &&
      channel.originalStream === null &&
      channel.streamDescriptor?.kind === "xtream"
    ) {
      return {
        ...channel,
        ...sanitizedDisplayFields,
      };
    }

    return {
      ...channel,
      ...sanitizedDisplayFields,
      stream: null,
      originalStream: null,
      streamDescriptor: { kind: "remote-m3u" as const },
      isPlayable: false,
      playabilityError: DISPLAY_ONLY_ERROR,
    };
  });

  return {
    ...snapshot,
    playlist: {
      ...snapshot.playlist,
      channels,
      disabledChannelCount: channels.filter((channel) => !channel.isPlayable).length,
    },
  };
}
