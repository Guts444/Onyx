import type { SavedEpgMappingStore } from "../../domain/epg.ts";
import type { Channel } from "../../domain/iptv.ts";
import type {
  LegacyPlaylistSnapshot,
  PlaylistCacheSnapshot,
  SavedPlaylistSource,
  SourceLibraryIndex,
} from "../../domain/sourceProfiles.ts";
import {
  buildLegacyChannelIdMap,
  migrateChannelId,
  migrateChannelIdArray,
  migratePlaybackSessionChannelIds,
  migrateLegacyPlaylistSnapshotChannelIds,
  migrateSavedEpgMappingStore,
  migrateSourceLibraryIndexChannelIds,
  type PlaybackSessionChannelReferences,
} from "../playlist/migration.ts";
import { isSourceProfileReady } from "./profiles.ts";

export interface ImportedChannelReferences<T extends PlaybackSessionChannelReferences> {
  favoriteIds: readonly string[];
  recentIds: readonly string[];
  selectedChannelId: string | null;
  preferredChannelId: string | null;
  playbackSession: T;
  sourceLibraryIndex: SourceLibraryIndex;
  playlistSnapshot: PlaylistCacheSnapshot | LegacyPlaylistSnapshot | null;
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
    playlistSnapshot: references.playlistSnapshot && "legacySelectedChannelId" in references.playlistSnapshot
      ? migrateLegacyPlaylistSnapshotChannelIds(references.playlistSnapshot, map)
      : references.playlistSnapshot,
    savedEpgMappings: migrateSavedEpgMappingStore(references.savedEpgMappings, map),
  };
}

export function migrateStartupPlaybackSession<T extends PlaybackSessionChannelReferences>(
  channels: readonly Channel[],
  session: T,
) {
  return migratePlaybackSessionChannelIds(session, buildLegacyChannelIdMap(channels));
}

export type StartupSourceRefreshResult = "pending" | "succeeded" | "failed";
export type StartupResumeReadiness = "ready" | "wait-for-refresh" | "unavailable";
export type StartupResumeOutcome = "resume" | "keep-intent" | "clear-intent";

export function resolveStartupResumeReadiness(
  resumeSourceId: string | null,
  cachedPlaylistPlaybackReady: boolean,
  refreshResult: StartupSourceRefreshResult,
): StartupResumeReadiness {
  if (resumeSourceId === null || cachedPlaylistPlaybackReady || refreshResult === "succeeded") {
    return "ready";
  }
  return refreshResult === "pending" ? "wait-for-refresh" : "unavailable";
}

/**
 * Decides what happens to a stored resume intent once startup restore has run
 * out of ways to play it. A refresh that failed or was cancelled must never
 * erase the intent: the next successful launch should still resume. Only a
 * channel that no longer exists clears it.
 */
export function resolveStartupResumeOutcome(input: {
  readiness: StartupResumeReadiness;
  channelAvailable: boolean;
}): StartupResumeOutcome {
  if (input.readiness !== "ready") {
    return "keep-intent";
  }
  return input.channelAvailable ? "resume" : "clear-intent";
}

export function createStartupSourceRestoreState() {
  const attemptedRevisions = new Set<string>();
  let pendingRevision: string | null = null;

  return {
    plan(revision: string) {
      if (attemptedRevisions.has(revision) || pendingRevision === revision) {
        return false;
      }
      pendingRevision = revision;
      return true;
    },
    begin(revision: string) {
      if (pendingRevision !== revision || attemptedRevisions.has(revision)) {
        return false;
      }
      pendingRevision = null;
      attemptedRevisions.add(revision);
      return true;
    },
    cancelPending(revision: string) {
      if (pendingRevision === revision) {
        pendingRevision = null;
      }
    },
    /**
     * Records a revision as handled without a startup refresh, so a manual
     * load does not trigger the startup effect to download the same source a
     * second time.
     */
    markAttempted(revision: string) {
      if (pendingRevision === revision) {
        pendingRevision = null;
      }
      attemptedRevisions.add(revision);
    },
    hasPending(revision: string) {
      return pendingRevision === revision;
    },
    hasAttempted(revision: string) {
      return attemptedRevisions.has(revision);
    },
  };
}

export function createSourceRevisionTracker() {
  const revisions = new Map<string, string>();

  const issueRevision = () => `source-revision:${crypto.randomUUID()}`;

  return {
    current(sourceId: string) {
      const existing = revisions.get(sourceId);
      if (existing) return existing;
      const revision = issueRevision();
      revisions.set(sourceId, revision);
      return revision;
    },
    bump(sourceId: string) {
      const revision = issueRevision();
      revisions.set(sourceId, revision);
      return revision;
    },
  };
}

export function getSourceOperationCommitState(
  sources: Record<string, SavedPlaylistSource>,
  sourceId: string,
  revision: string,
) {
  const source = sources[sourceId];
  return {
    sourceId,
    fingerprint: revision,
    exists: source !== undefined,
    ready: source ? isSourceProfileReady(source) : false,
  };
}
