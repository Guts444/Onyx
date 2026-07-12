import type { SavedEpgMappingStore } from "../../domain/epg";
import type { Channel } from "../../domain/iptv";
import type { LegacyPlaylistSnapshot, SourceLibraryIndex } from "../../domain/sourceProfiles";

export type LegacyChannelIdMap = Readonly<Record<string, string>>;

export interface PlaybackSessionChannelReferences {
  channelId: string | null;
  resumeChannelId: string | null;
}

export function buildLegacyChannelIdMap(channels: readonly Channel[]) {
  const result: Record<string, string> = {};

  for (const channel of channels) {
    for (const legacyId of channel.legacyIds ?? []) {
      if (legacyId && result[legacyId] === undefined) {
        result[legacyId] = channel.id;
      }
    }
  }

  return result;
}

export function migrateChannelId(channelId: string, map: LegacyChannelIdMap): string;
export function migrateChannelId(channelId: null, map: LegacyChannelIdMap): null;
export function migrateChannelId(channelId: string | null, map: LegacyChannelIdMap): string | null;
export function migrateChannelId(channelId: string | null, map: LegacyChannelIdMap) {
  return channelId === null ? null : map[channelId] ?? channelId;
}

export function migrateChannelIdArray(channelIds: readonly string[], map: LegacyChannelIdMap) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const channelId of channelIds) {
    const migratedId = migrateChannelId(channelId, map);
    if (!seen.has(migratedId)) {
      seen.add(migratedId);
      result.push(migratedId);
    }
  }

  return result;
}

export function migratePlaybackSessionChannelIds<T extends PlaybackSessionChannelReferences>(
  session: T,
  map: LegacyChannelIdMap,
): T {
  return {
    ...session,
    channelId: migrateChannelId(session.channelId, map),
    resumeChannelId: migrateChannelId(session.resumeChannelId, map),
  };
}

export function migrateLegacyPlaylistSnapshotChannelIds(
  snapshot: LegacyPlaylistSnapshot,
  map: LegacyChannelIdMap,
): LegacyPlaylistSnapshot {
  return {
    ...snapshot,
    legacySelectedChannelId: migrateChannelId(snapshot.legacySelectedChannelId, map),
  };
}

export function migrateSourceLibraryIndexChannelIds(
  index: SourceLibraryIndex,
  map: LegacyChannelIdMap,
): SourceLibraryIndex {
  return Object.fromEntries(
    Object.entries(index).map(([sourceId, entry]) => [
      sourceId,
      {
        ...entry,
        channelIds: migrateChannelIdArray(entry.channelIds, map),
      },
    ]),
  );
}

export function migrateSavedEpgMappingStore(
  store: SavedEpgMappingStore,
  map: LegacyChannelIdMap,
): SavedEpgMappingStore {
  return Object.fromEntries(
    Object.entries(store).map(([scope, mappings]) => {
      const migratedMappings: Record<string, string> = {};

      for (const [key, value] of Object.entries(mappings)) {
        const channelId = key.startsWith("channel:") ? key.slice("channel:".length) : null;
        if (channelId === null || map[channelId] === undefined) {
          migratedMappings[key] = value;
        }
      }

      for (const [key, value] of Object.entries(mappings)) {
        if (!key.startsWith("channel:")) {
          continue;
        }
        const channelId = key.slice("channel:".length);
        const migratedKey = `channel:${map[channelId] ?? channelId}`;
        if (migratedMappings[migratedKey] === undefined) {
          migratedMappings[migratedKey] = value;
        }
      }

      return [scope, migratedMappings];
    }),
  );
}
