import type { SavedEpgMappingStore } from "../../domain/epg.ts";
import type { Channel } from "../../domain/iptv.ts";
import type { PlaylistSnapshot, SavedPlaylistSource, SourceLibraryIndex } from "../../domain/sourceProfiles.ts";
import {
  buildLegacyChannelIdMap,
  migrateChannelId,
  migrateChannelIdArray,
  migratePlaybackSessionChannelIds,
  migratePlaylistSnapshotChannelIds,
  migrateSavedEpgMappingStore,
  migrateSourceLibraryIndexChannelIds,
  type PlaybackSessionChannelReferences,
} from "../playlist/migration.ts";
import { isSourceProfileReady } from "./profiles.ts";
import { hashString } from "../../utils/hash.ts";

export interface ImportedChannelReferences<T extends PlaybackSessionChannelReferences> {
  favoriteIds: readonly string[];
  recentIds: readonly string[];
  selectedChannelId: string | null;
  preferredChannelId: string | null;
  playbackSession: T;
  sourceLibraryIndex: SourceLibraryIndex;
  playlistSnapshot: PlaylistSnapshot | null;
  savedEpgMappings: SavedEpgMappingStore;
}

export function migrateImportedChannelReferences<T extends PlaybackSessionChannelReferences>(
  channels: readonly Channel[],
  references: ImportedChannelReferences<T>,
) {
  const map = buildLegacyChannelIdMap(channels);
  return {
    favoriteIds: migrateChannelIdArray(references.favoriteIds, map),
    recentIds: migrateChannelIdArray(references.recentIds, map),
    selectedChannelId: migrateChannelId(references.selectedChannelId, map),
    preferredChannelId: migrateChannelId(references.preferredChannelId, map),
    playbackSession: migratePlaybackSessionChannelIds(references.playbackSession, map),
    sourceLibraryIndex: migrateSourceLibraryIndexChannelIds(references.sourceLibraryIndex, map),
    playlistSnapshot: references.playlistSnapshot
      ? migratePlaylistSnapshotChannelIds(references.playlistSnapshot, map)
      : null,
    savedEpgMappings: migrateSavedEpgMappingStore(references.savedEpgMappings, map),
  };
}

export function getSourceOperationFingerprint(source: SavedPlaylistSource) {
  const configuration = source.kind === "m3u_url"
    ? { id: source.id, kind: source.kind, enabled: source.enabled, updatedAt: source.updatedAt, url: source.url }
    : {
        id: source.id,
        kind: source.kind,
        enabled: source.enabled,
        updatedAt: source.updatedAt,
        domain: source.domain,
        username: source.username,
        hasPassword: source.password.length > 0,
      };
  return `source_${hashString(JSON.stringify(configuration))}`;
}

export function getSourceOperationCommitState(
  sources: Record<string, SavedPlaylistSource>,
  sourceId: string,
) {
  const source = sources[sourceId];
  return {
    sourceId,
    fingerprint: source ? getSourceOperationFingerprint(source) : null,
    exists: source !== undefined,
    ready: source ? isSourceProfileReady(source) : false,
  };
}
