import type { Channel, PlaylistImport, StreamDescriptor } from "../../domain/iptv";
import { validateXtreamStreamDescriptor } from "../../domain/iptv.ts";
import type {
  LegacyPlaylistSnapshot,
  PlaylistCacheSnapshot,
  PlaylistSelectionState,
} from "../../domain/sourceProfiles";
import { buildLegacyChannelIdMap, migrateChannelId } from "./migration.ts";
import { redactCredentials } from "./redaction.ts";
import { throwIfAborted, yieldToEventLoop } from "./cooperative.ts";


export const DISPLAY_ONLY_ERROR = "Refresh this saved source before playback.";
const MAX_SELECTION_FIELD_LENGTH = 512;
const ASCII_ONLY = /^[\u0000-\u007F]*$/;

/**
 * Policy ceiling for what Onyx is willing to persist as a playlist snapshot.
 * It sits below the Rust key limit (see `persistence.rs`) with margin, because
 * the estimate is not the exact serialization. Above it the library still
 * loads and runs for the session, but it is deliberately not cached.
 */
export const MAX_PERSISTED_SNAPSHOT_BYTES = 40 * 1024 * 1024;
const SNAPSHOT_ENVELOPE_HEADROOM_BYTES = 4096;

function utf8ByteLength(value: string) {
  if (ASCII_ONLY.test(value)) {
    return value.length;
  }
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // A high surrogate pairs with the next code unit into one 4-byte scalar.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * JSON size estimate. It adds one comma per object/array entry and counts
 * strings as UTF-8 bytes plus quotes, so it tracks `JSON.stringify(...).length`
 * without materializing the multi-hundred-megabyte string. It does not account
 * for JSON escapes: a quote, a backslash or a control character costs one to
 * five extra bytes each, so a string-dense snapshot can come out slightly low.
 * The persistence policy ceiling sits well under the Rust snapshot cap to
 * absorb that gap.
 */
function jsonByteEstimate(value: unknown): number {
  if (typeof value === "string") return utf8ByteLength(value) + 2;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (value === null || value === undefined) return 4;
  if (Array.isArray(value)) {
    let total = 2;
    for (let index = 0; index < value.length; index += 1) total += jsonByteEstimate(value[index]) + 1;
    return total;
  }
  if (typeof value === "object") {
    let total = 2;
    for (const key in value as Record<string, unknown>) {
      total += utf8ByteLength(key) + 3 + jsonByteEstimate((value as Record<string, unknown>)[key]) + 1;
    }
    return total;
  }
  return 0;
}

export function estimateSerializedSnapshotBytes(snapshot: PlaylistCacheSnapshot) {
  return SNAPSHOT_ENVELOPE_HEADROOM_BYTES + jsonByteEstimate(snapshot);
}

export function isSnapshotWithinPersistLimit(
  snapshot: PlaylistCacheSnapshot,
  limit = MAX_PERSISTED_SNAPSHOT_BYTES,
) {
  return estimateSerializedSnapshotBytes(snapshot) <= limit;
}

/**
 * The stored stand-in for a library too large to cache. It keeps the identity
 * (`cacheId`, `sourceId`, `savedAt`) so selection and deletion keep working,
 * and carries no channels, so nothing stale can be restored as a library.
 */
export function createPlaceholderPlaylistSnapshot(snapshot: PlaylistCacheSnapshot): PlaylistCacheSnapshot {
  return {
    version: 1,
    cacheId: snapshot.cacheId,
    sourceId: snapshot.sourceId,
    playlist: {
      name: snapshot.playlist.name,
      channels: [],
      groups: [],
      importedAt: snapshot.playlist.importedAt,
      disabledChannelCount: 0,
      skippedEntryCount: 0,
    },
    savedAt: snapshot.savedAt,
  };
}

/**
 * The single storage policy for playlist snapshots. Every writer reaches this
 * through the persistent-state serializer, so no path can push an oversized
 * snapshot across IPC or onto disk.
 */
export function prepareSanitizedSnapshotForStorage(
  sanitized: PlaylistCacheSnapshot,
  limit = MAX_PERSISTED_SNAPSHOT_BYTES,
) {
  return isSnapshotWithinPersistLimit(sanitized, limit)
    ? { snapshot: sanitized, persisted: true }
    : { snapshot: createPlaceholderPlaylistSnapshot(sanitized), persisted: false };
}

export function preparePlaylistSnapshotForStorage(
  snapshot: PlaylistCacheSnapshot,
  limit = MAX_PERSISTED_SNAPSHOT_BYTES,
) {
  return prepareSanitizedSnapshotForStorage(sanitizePlaylistCacheSnapshot(snapshot), limit);
}

/**
 * Cooperative variant for the import path: sanitize with progress and cancel,
 * then apply the same storage policy the synchronous serializer enforces.
 */
export async function preparePlaylistSnapshotForStorageInChunks(
  snapshot: PlaylistCacheSnapshot,
  options: SnapshotSanitizeOptions = {},
) {
  const sanitized = await sanitizePlaylistCacheSnapshotInChunks(snapshot, options);
  throwIfAborted(options.signal);
  return prepareSanitizedSnapshotForStorage(sanitized);
}

export function isDisplayOnlyChannel(channel: Channel) {
  return channel.stream === null && channel.originalStream === null &&
    channel.streamDescriptor?.kind === "remote-m3u" && !channel.isPlayable;
}

export function isChannelPlaybackReady(channel: Channel) {
  return (channel.isPlayable && channel.stream !== null) ||
    (channel.isPlayable && validateXtreamStreamDescriptor(channel.streamDescriptor) !== null);
}

export function isPlaylistCachePlaybackReady(snapshot: PlaylistCacheSnapshot) {
  return snapshot.playlist.channels.some(isChannelPlaybackReady);
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

interface SanitizedSnapshotHeader {
  cacheId: string;
  sourceId: string;
  playlistName: string;
  groups: string[];
  importedAt: string;
  skippedEntryCount: number;
  savedAt: string;
}

function createSanitizedSnapshotHeader(snapshot: PlaylistCacheSnapshot): SanitizedSnapshotHeader {
  return {
    cacheId: metadata(snapshot.cacheId),
    sourceId: metadata(snapshot.sourceId ?? ""),
    playlistName: metadata(snapshot.playlist.name, "Channels"),
    groups: Array.isArray(snapshot.playlist.groups)
      ? snapshot.playlist.groups.map((group) => metadata(group))
      : [],
    importedAt: metadata(snapshot.playlist.importedAt),
    skippedEntryCount: Number.isFinite(snapshot.playlist.skippedEntryCount)
      ? snapshot.playlist.skippedEntryCount
      : 0,
    savedAt: metadata(snapshot.savedAt),
  };
}

function createSanitizedSnapshot(
  header: SanitizedSnapshotHeader,
  channels: Channel[],
  disabledChannelCount: number,
): PlaylistCacheSnapshot {
  return {
    version: 1,
    cacheId: header.cacheId,
    sourceId: header.sourceId,
    playlist: {
      name: header.playlistName,
      channels,
      groups: header.groups,
      importedAt: header.importedAt,
      disabledChannelCount,
      skippedEntryCount: header.skippedEntryCount,
    },
    savedAt: header.savedAt,
  };
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
  return createSanitizedSnapshot(
    createSanitizedSnapshotHeader(snapshot),
    channels,
    channels.filter((channel) => !channel.isPlayable).length,
  );
}

export interface SnapshotSanitizeOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  sliceBudgetMs?: number;
}

/**
 * Same sanitization, sliced so a library with hundreds of thousands of
 * channels can be prepared with progress and a working cancel instead of one
 * multi-second block. Local snapshots are already O(1) and delegate.
 */
export async function sanitizePlaylistCacheSnapshotInChunks(
  snapshot: PlaylistCacheSnapshot,
  options: SnapshotSanitizeOptions = {},
): Promise<PlaylistCacheSnapshot> {
  if (snapshot.sourceId === null) {
    options.onProgress?.(1);
    return sanitizePlaylistCacheSnapshot(snapshot);
  }

  const { signal, onProgress, sliceBudgetMs = 8 } = options;
  const header = createSanitizedSnapshotHeader(snapshot);
  const source = snapshot.playlist.channels;
  const channels: Channel[] = [];
  let disabledChannelCount = 0;
  let index = 0;
  let lastReported = 0;

  while (index < source.length) {
    const sliceStartedAt = performance.now();
    do {
      const channel = rebuildRemoteChannel(source[index]);
      if (!channel.isPlayable) disabledChannelCount += 1;
      channels.push(channel);
      index += 1;
    } while (index < source.length && performance.now() - sliceStartedAt < sliceBudgetMs);

    const fraction = index / source.length;
    if (onProgress && fraction - lastReported >= 0.02) {
      lastReported = fraction;
      onProgress(fraction);
    }
    throwIfAborted(signal);
    await yieldToEventLoop();
  }

  onProgress?.(1);
  return createSanitizedSnapshot(header, channels, disabledChannelCount);
}

export function serializePlaylistCacheSnapshot(snapshot: PlaylistCacheSnapshot | null) {
  return snapshot === null ? null : preparePlaylistSnapshotForStorage(snapshot).snapshot;
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
    // A placeholder snapshot deliberately carries no channels, so membership
    // cannot be checked. The persisted selection is the only record of the
    // resume intent, and it is scoped to this exact cache, so it is kept.
    const isPlaceholder = cache.playlist.channels.length === 0;
    selectedChannelId = selectionMatches
      ? isPlaceholder && persistedSelection.selectedChannelId !== null
        ? persistedSelection.selectedChannelId
        : migrateValid(persistedSelection.selectedChannelId)
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
