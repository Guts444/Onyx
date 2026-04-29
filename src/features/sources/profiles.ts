import type { Channel } from "../../domain/iptv";
import type {
  PlaylistSnapshot,
  SavedM3uUrlSource,
  SavedPlaylistSource,
  SourceLibraryIndexEntry,
  SavedXtreamSource,
} from "../../domain/sourceProfiles";
import { normalizeStreamReference } from "../playlist/channelFactory.ts";
interface BaseSourceDraft<K extends SavedPlaylistSource["kind"]> {
  id: string;
  kind: K;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoadedAt: string | null;
}

const REDACTED_STREAM_ERROR =
  "This cached Xtream channel will be playable after the saved source refreshes.";

function createBaseSource<K extends SavedPlaylistSource["kind"]>(
  kind: K,
  name: string,
): BaseSourceDraft<K> {
  const timestamp = new Date().toISOString();

  return {
    // 🛡️ Sentinel: Use crypto.randomUUID() instead of Math.random() for secure, guaranteed unique ID generation
    id: `source_${kind}_${crypto.randomUUID()}`,
    kind,
    name,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastLoadedAt: null,
  };
}

export function createM3uUrlSource(url = "", name = "Saved M3U URL"): SavedM3uUrlSource {
  return {
    ...createBaseSource("m3u_url", name),
    url,
  };
}

export function createXtreamSource(
  domain = "",
  username = "",
  password = "",
  name = "Saved Xtream Login",
): SavedXtreamSource {
  return {
    ...createBaseSource("xtream", name),
    domain,
    username,
    password,
  };
}

export function isSourceProfileReady(source: SavedPlaylistSource) {
  if (!source.enabled) {
    return false;
  }

  if (source.kind === "m3u_url") {
    return source.url.trim().length > 0;
  }

  return (
    source.domain.trim().length > 0 &&
    source.username.trim().length > 0 &&
    source.password.length > 0
  );
}

export function markSourceLoaded(source: SavedPlaylistSource) {
  const timestamp = new Date().toISOString();

  return {
    ...source,
    updatedAt: timestamp,
    lastLoadedAt: timestamp,
  };
}

export function updateSourceProfile(
  source: SavedPlaylistSource,
  patch: Partial<SavedPlaylistSource>,
): SavedPlaylistSource {
  return {
    ...source,
    ...patch,
    updatedAt: new Date().toISOString(),
  } as SavedPlaylistSource;
}

export function scrubSourceProfileSecrets(
  sources: Record<string, SavedPlaylistSource>,
): Record<string, SavedPlaylistSource> {
  const scrubbedSources: Record<string, SavedPlaylistSource> = {};

  for (const [sourceId, source] of Object.entries(sources)) {
    scrubbedSources[sourceId] =
      source.kind === "xtream"
        ? {
            ...source,
            password: "",
          }
        : source;
  }

  return scrubbedSources;
}

function redactChannelStream(channel: Channel): Channel {
  return {
    ...channel,
    stream: "",
    originalStream: "",
    isPlayable: false,
    playabilityError: REDACTED_STREAM_ERROR,
  };
}

function normalizeStoredChannel(channel: Channel, streamsRedacted: boolean): Channel {
  if (streamsRedacted) {
    return redactChannelStream(channel);
  }

  const normalizedStream = normalizeStreamReference(channel.stream);

  return {
    ...channel,
    stream: normalizedStream.stream,
    isPlayable: normalizedStream.isPlayable,
    playabilityError: normalizedStream.playabilityError,
  };
}

export function normalizePlaylistSnapshot(snapshot: unknown): PlaylistSnapshot | null {
  if (typeof snapshot !== "object" || snapshot === null) {
    return null;
  }

  const parsedSnapshot = snapshot as PlaylistSnapshot;

  if (!parsedSnapshot.playlist || !Array.isArray(parsedSnapshot.playlist.channels)) {
    return null;
  }

  const streamsRedacted = parsedSnapshot.streamsRedacted === true;
  const channels = parsedSnapshot.playlist.channels.map((channel) =>
    normalizeStoredChannel(channel, streamsRedacted),
  );

  return {
    ...parsedSnapshot,
    playlist: {
      ...parsedSnapshot.playlist,
      channels,
      disabledChannelCount: channels.filter((channel) => !channel.isPlayable).length,
    },
  };
}

export function scrubPlaylistSnapshotSecrets(
  snapshot: PlaylistSnapshot | null,
  sources: Record<string, SavedPlaylistSource>,
): PlaylistSnapshot | null {
  if (!snapshot?.sourceId) {
    return snapshot;
  }

  if (sources[snapshot.sourceId]?.kind === "m3u_url") {
    return {
      ...snapshot,
      streamsRedacted: false,
    };
  }

  const redactedChannels = snapshot.playlist.channels.map(redactChannelStream);

  return {
    ...snapshot,
    streamsRedacted: true,
    playlist: {
      ...snapshot.playlist,
      channels: redactedChannels,
      disabledChannelCount: redactedChannels.length,
    },
  };
}

export function mergeSourceLibraryIndexEntry(
  currentEntry: SourceLibraryIndexEntry | undefined,
  channelIds: string[],
  playlistPreferenceKey: string | null,
): SourceLibraryIndexEntry {
  const nextChannelIds = new Set(currentEntry?.channelIds ?? []);
  const nextPlaylistPreferenceKeys = new Set(currentEntry?.playlistPreferenceKeys ?? []);

  for (const channelId of channelIds) {
    nextChannelIds.add(channelId);
  }

  if (playlistPreferenceKey) {
    nextPlaylistPreferenceKeys.add(playlistPreferenceKey);
  }

  return {
    channelIds: [...nextChannelIds].sort((left, right) => left.localeCompare(right)),
    playlistPreferenceKeys: [...nextPlaylistPreferenceKeys].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

