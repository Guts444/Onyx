import type { Channel, PlaylistImport, StreamDescriptor } from "../../domain/iptv";
import { validateXtreamStreamDescriptor } from "../../domain/iptv.ts";
import type {
  LegacyPlaylistSnapshot,
  PlaylistCacheSnapshot,
  PlaylistSelectionState,
} from "../../domain/sourceProfiles";
import { buildLegacyChannelIdMap, migrateChannelId } from "./migration.ts";
import { redactCredentials } from "./redaction.ts";

export const DISPLAY_ONLY_ERROR = "Refresh this saved source before playback.";
const MAX_SELECTION_FIELD_LENGTH = 512;

export function isDisplayOnlyChannel(channel: Channel) {
  return channel.stream === null && channel.originalStream === null &&
    channel.streamDescriptor?.kind === "remote-m3u" && !channel.isPlayable;
}

export function isPlaylistCachePlaybackReady(snapshot: PlaylistCacheSnapshot) {
  return snapshot.playlist.channels.some((channel) =>
    (channel.isPlayable && channel.stream !== null) ||
    (channel.isPlayable && validateXtreamStreamDescriptor(channel.streamDescriptor) !== null),
  );
}

export function shouldRefreshPlaylistCache(snapshot: PlaylistCacheSnapshot) {
  return snapshot.sourceId !== null && !isPlaylistCachePlaybackReady(snapshot);
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

export function createPlaylistCacheSnapshot(
  sourceId: string | null,
  playlist: PlaylistImport,
  cacheId: string = crypto.randomUUID(),
  savedAt = new Date().toISOString(),
): PlaylistCacheSnapshot {
  return { version: 1, cacheId, sourceId, playlist, savedAt };
}

function legacyCacheId(value: Record<string, unknown>, playlist: PlaylistImport) {
  const sourceId = typeof value.sourceId === "string" ? value.sourceId : "local";
  const savedAt = typeof value.savedAt === "string" ? value.savedAt : "unknown";
  const first = playlist.channels[0]?.id ?? "empty";
  const last = playlist.channels[playlist.channels.length - 1]?.id ?? "empty";
  let hash = 0;
  for (const character of `${sourceId}\u0001${savedAt}\u0001${playlist.importedAt}\u0001${playlist.channels.length}\u0001${first}\u0001${last}`) {
    hash = (hash << 5) - hash + character.charCodeAt(0);
    hash |= 0;
  }
  return `legacy-${Math.abs(hash).toString(36)}`;
}

export function revivePlaylistCacheSnapshot(value: unknown): PlaylistCacheSnapshot | LegacyPlaylistSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.sourceId !== null && typeof raw.sourceId !== "string") return null;
  if (raw.version !== undefined && raw.version !== 1) return null;
  if (typeof raw.savedAt !== "string" || typeof raw.playlist !== "object" || raw.playlist === null) return null;
  const playlist = raw.playlist as PlaylistImport;
  if (!Array.isArray(playlist.channels) || !Array.isArray(playlist.groups)) return null;
  const sourceId = raw.sourceId as string | null;

  const cacheId = raw.version === 1 && typeof raw.cacheId === "string" && raw.cacheId.length <= MAX_SELECTION_FIELD_LENGTH
    ? raw.cacheId
    : legacyCacheId(raw, playlist);
  const cache: PlaylistCacheSnapshot = {
    version: 1,
    cacheId,
    sourceId,
    playlist,
    savedAt: raw.savedAt,
  };
  if ("selectedChannelId" in raw || "legacySelectedChannelId" in raw) {
    const selected = "legacySelectedChannelId" in raw ? raw.legacySelectedChannelId : raw.selectedChannelId;
    return {
      ...cache,
      legacySelectedChannelId: typeof selected === "string" ? selected : null,
    };
  }
  return cache;
}

export function sanitizePlaylistCacheSnapshot(snapshot: PlaylistCacheSnapshot): PlaylistCacheSnapshot {
  if (snapshot.sourceId === null) {
    return {
      version: 1,
      cacheId: metadata(snapshot.cacheId),
      sourceId: null,
      playlist: snapshot.playlist,
      savedAt: metadata(snapshot.savedAt),
    };
  }

  const channels = snapshot.playlist.channels.map(rebuildRemoteChannel);
  return {
    version: 1,
    cacheId: metadata(snapshot.cacheId),
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
    savedAt: metadata(snapshot.savedAt),
  };
}

export function serializePlaylistCacheSnapshot(snapshot: PlaylistCacheSnapshot | null) {
  return snapshot === null ? null : sanitizePlaylistCacheSnapshot(snapshot);
}

/** Compatibility wrapper for callers that still provide a pre-split snapshot shape. */
export function sanitizePlaylistSnapshot(value: unknown): PlaylistCacheSnapshot {
  const revived = revivePlaylistCacheSnapshot(value);
  if (revived === null) throw new Error("The playlist snapshot is invalid.");
  return sanitizePlaylistCacheSnapshot(revived);
}

export function createPlaylistSelectionState(
  cache: PlaylistCacheSnapshot,
  selectedChannelId: string | null,
): PlaylistSelectionState {
  return {
    version: 1,
    cacheId: cache.cacheId,
    sourceId: cache.sourceId,
    selectedChannelId,
  };
}

function isBoundedStringOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= MAX_SELECTION_FIELD_LENGTH);
}

export function revivePlaylistSelectionState(value: unknown): PlaylistSelectionState | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    typeof raw.cacheId !== "string" || raw.cacheId.length === 0 || raw.cacheId.length > MAX_SELECTION_FIELD_LENGTH ||
    !isBoundedStringOrNull(raw.sourceId) ||
    !isBoundedStringOrNull(raw.selectedChannelId)
  ) return null;
  return {
    version: 1,
    cacheId: raw.cacheId,
    sourceId: raw.sourceId,
    selectedChannelId: raw.selectedChannelId,
  };
}

export function serializePlaylistSelectionState(state: PlaylistSelectionState | null) {
  return state === null ? null : {
    version: 1,
    cacheId: state.cacheId,
    sourceId: state.sourceId,
    selectedChannelId: state.selectedChannelId,
  };
}

export function createPlaylistPersistenceCoordinator(
  writeCache: (cache: PlaylistCacheSnapshot | null) => void,
  writeSelection: (selection: PlaylistSelectionState | null) => void,
) {
  return {
    replace(cache: PlaylistCacheSnapshot, selectedChannelId: string | null) {
      writeCache(cache);
      writeSelection(createPlaylistSelectionState(cache, selectedChannelId));
    },
    select(cache: PlaylistCacheSnapshot, selectedChannelId: string | null) {
      writeSelection(createPlaylistSelectionState(cache, selectedChannelId));
    },
    clear() {
      writeCache(null);
      writeSelection(null);
    },
  };
}

export function resolvePlaylistSelectionHydration(
  cache: PlaylistCacheSnapshot | LegacyPlaylistSnapshot,
  persistedSelection: PlaylistSelectionState | null,
  userSelectionChanged: boolean,
  currentSelectedChannelId: string | null,
) {
  const channelIds = new Set(cache.playlist.channels.map((channel) => channel.id));
  const legacyMap = buildLegacyChannelIdMap(cache.playlist.channels);
  const migrateValid = (channelId: string | null | undefined) => {
    if (channelId == null) return null;
    const migrated = migrateChannelId(channelId, legacyMap);
    return channelIds.has(migrated) ? migrated : null;
  };

  let selectedChannelId = userSelectionChanged ? migrateValid(currentSelectedChannelId) : null;
  if (selectedChannelId === null && !userSelectionChanged) {
    const selectionMatches = persistedSelection?.cacheId === cache.cacheId &&
      persistedSelection.sourceId === cache.sourceId;
    selectedChannelId = selectionMatches
      ? migrateValid(persistedSelection.selectedChannelId)
      : null;
    if (selectedChannelId === null && "legacySelectedChannelId" in cache) {
      selectedChannelId = migrateValid(cache.legacySelectedChannelId);
    }
  }
  selectedChannelId ??= cache.playlist.channels[0]?.id ?? null;
  return {
    selectedChannelId,
    selectionState: createPlaylistSelectionState(cache, selectedChannelId),
  };
}
