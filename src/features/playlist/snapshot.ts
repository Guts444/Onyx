import type { Channel, StreamDescriptor } from "../../domain/iptv";
import { validateXtreamStreamDescriptor } from "../../domain/iptv.ts";
import type { PlaylistSnapshot } from "../../domain/sourceProfiles";
import { redactCredentials } from "./redaction.ts";

export const DISPLAY_ONLY_ERROR = "Refresh this saved source before playback.";

export function isDisplayOnlyChannel(channel: Channel) {
  return channel.stream === null && channel.originalStream === null &&
    channel.streamDescriptor?.kind === "remote-m3u" && !channel.isPlayable;
}

export function isPlaylistSnapshotPlaybackReady(snapshot: PlaylistSnapshot) {
  return snapshot.playlist.channels.some((channel) =>
    (channel.isPlayable && channel.stream !== null) ||
    (channel.isPlayable && validateXtreamStreamDescriptor(channel.streamDescriptor) !== null),
  );
}

export function shouldRefreshPlaylistSnapshot(snapshot: PlaylistSnapshot) {
  return snapshot.sourceId !== null && !isPlaylistSnapshotPlaybackReady(snapshot);
}

function metadata(value: unknown, fallback = "") {
  return redactCredentials(typeof value === "string" ? value : fallback);
}

function optionalMetadata(value: unknown) {
  return value === null ? null : metadata(value);
}

function allowedLegacyIds(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string").map((item) => metadata(item));
}

function rebuildRemoteChannel(channel: Channel): Channel {
  const descriptor = validateXtreamStreamDescriptor(channel.streamDescriptor);
  const canMaterialize = descriptor !== null && channel.stream === null && channel.originalStream === null;
  const streamDescriptor: StreamDescriptor = canMaterialize ? descriptor : { kind: "remote-m3u" };
  return {
    id: metadata(channel.id),
    ...(channel.legacyIds === undefined ? {} : { legacyIds: allowedLegacyIds(channel.legacyIds) }),
    name: metadata(channel.name, "Unnamed channel"),
    group: metadata(channel.group, "Ungrouped"),
    stream: null,
    originalStream: null,
    streamDescriptor,
    isPlayable: canMaterialize && channel.isPlayable === true,
    playabilityError: canMaterialize
      ? optionalMetadata(channel.playabilityError)
      : DISPLAY_ONLY_ERROR,
    logo: optionalMetadata(channel.logo),
    tvgId: optionalMetadata(channel.tvgId),
    tvgName: optionalMetadata(channel.tvgName),
  };
}

export function sanitizePlaylistSnapshot(snapshot: PlaylistSnapshot): PlaylistSnapshot {
  if (snapshot.sourceId === null) return snapshot;

  const channels = snapshot.playlist.channels.map(rebuildRemoteChannel);
  return {
    sourceId: metadata(snapshot.sourceId),
    playlist: {
      name: metadata(snapshot.playlist.name, "Channels"),
      channels,
      groups: Array.isArray(snapshot.playlist.groups)
        ? snapshot.playlist.groups.map((group) => metadata(group))
        : [],
      importedAt: metadata(snapshot.playlist.importedAt),
      disabledChannelCount: channels.filter((channel) => !channel.isPlayable).length,
      skippedEntryCount: Number.isFinite(snapshot.playlist.skippedEntryCount)
        ? snapshot.playlist.skippedEntryCount
        : 0,
    },
    selectedChannelId: optionalMetadata(snapshot.selectedChannelId),
    savedAt: metadata(snapshot.savedAt),
  };
}
