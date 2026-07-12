import { test } from "node:test";
import assert from "node:assert";
import type { Channel } from "../../domain/iptv.ts";
import type { LegacyPlaylistSnapshot, SavedPlaylistSource } from "../../domain/sourceProfiles.ts";
import {
  createSourceRevisionTracker,
  createStartupSourceRestoreState,
  getSourceOperationCommitState,
  migrateStartupPlaybackSession,
  migrateImportedChannelReferences,
} from "./appIntegration.ts";

const source: SavedPlaylistSource = {
  id: "source-a",
  kind: "m3u_url",
  name: "Provider",
  enabled: true,
  createdAt: "created",
  updatedAt: "updated",
  lastLoadedAt: null,
  url: "https://provider.example/list.m3u",
};

const channels = [{ id: "new-a", legacyIds: ["old-a"] }] as Channel[];
const snapshot = {
  version: 1,
  cacheId: "legacy-cache",
  sourceId: "source-a",
  playlist: { name: "old", channels: [], groups: [], importedAt: "then", disabledChannelCount: 0, skippedEntryCount: 0 },
  legacySelectedChannelId: "old-a",
  savedAt: "then",
} as LegacyPlaylistSnapshot;

test("an imported playlist migrates every App channel reference while preserving unknown IDs", () => {
  const migrated = migrateImportedChannelReferences(channels, {
    favoriteIds: ["old-a", "unknown"],
    recentIds: ["old-a", "unknown"],
    selectedChannelId: "old-a",
    preferredChannelId: "old-a",
    playbackSession: { channelId: "old-a", resumeChannelId: "unknown", marker: true },
    sourceLibraryIndex: {
      "source-a": { channelIds: ["old-a", "unknown"], playlistPreferenceKeys: ["library"] },
    },
    playlistSnapshot: snapshot,
    savedEpgMappings: { scope: { "channel:old-a": "guide-a", "channel:unknown": "guide-b", "tvg-id:x": "guide-c" } },
  });

  assert.deepStrictEqual(migrated.favoriteIds, ["new-a", "unknown"]);
  assert.deepStrictEqual(migrated.recentIds, ["new-a", "unknown"]);
  assert.equal(migrated.selectedChannelId, "new-a");
  assert.equal(migrated.preferredChannelId, "new-a");
  assert.deepStrictEqual(migrated.playbackSession, { channelId: "new-a", resumeChannelId: "unknown", marker: true });
  assert.deepStrictEqual(migrated.sourceLibraryIndex["source-a"].channelIds, ["new-a", "unknown"]);
  assert.equal(
    migrated.playlistSnapshot && "legacySelectedChannelId" in migrated.playlistSnapshot
      ? migrated.playlistSnapshot.legacySelectedChannelId
      : null,
    "new-a",
  );
  assert.deepStrictEqual(migrated.savedEpgMappings.scope, {
    "channel:unknown": "guide-b",
    "tvg-id:x": "guide-c",
    "channel:new-a": "guide-a",
  });
});

test("startup playback resume keeps its target when an imported playlist replaces a legacy channel ID", () => {
  const startupSession = {
    sourceId: "source-a",
    channelId: "old-a",
    shouldResume: true,
    resumeSourceId: "source-a",
    resumeChannelId: "old-a",
    resumeInFullscreen: false,
  };

  const migrated = migrateStartupPlaybackSession(channels, startupSession);

  assert.deepStrictEqual(migrated, {
    ...startupSession,
    channelId: "new-a",
    resumeChannelId: "new-a",
  });
});

test("canceling a delayed startup restore clears pending state without consuming its attempt", () => {
  const restore = createStartupSourceRestoreState();

  assert.equal(restore.plan("revision-a"), true);
  assert.equal(restore.hasPending("revision-a"), true);
  assert.equal(restore.hasAttempted("revision-a"), false);

  restore.cancelPending("revision-a");

  assert.equal(restore.hasPending("revision-a"), false);
  assert.equal(restore.hasAttempted("revision-a"), false);
});

test("a changed valid source revision can start once after an earlier delayed restore is canceled", () => {
  const restore = createStartupSourceRestoreState();
  restore.plan("revision-a");
  restore.cancelPending("revision-a");

  assert.equal(restore.plan("revision-b"), true);
  assert.equal(restore.begin("revision-b"), true);
  assert.equal(restore.hasAttempted("revision-b"), true);
  assert.equal(restore.plan("revision-b"), false);
  assert.equal(restore.begin("revision-b"), false);
});

test("source revisions are opaque, stable until mutation, and bumped across deletion or recreation", () => {
  const revisions = createSourceRevisionTracker();
  const first = revisions.current(source.id);

  assert.equal(revisions.current(source.id), first);
  assert.equal(first.includes(source.id), false);
  assert.equal(first.includes(source.url), false);

  const edited = revisions.bump(source.id);
  assert.notEqual(edited, first);
  assert.equal(revisions.current(source.id), edited);

  const recreated = revisions.bump(source.id);
  assert.notEqual(recreated, edited);
});

test("source operation commit state uses an explicit revision without deriving identity from secrets", () => {
  const revisions = createSourceRevisionTracker();
  const revision = revisions.current(source.id);
  const xtream: SavedPlaylistSource = {
    ...source,
    kind: "xtream",
    domain: "https://secret-domain.example",
    username: "secret-user",
    password: "secret-password",
  };

  assert.equal(JSON.stringify({ revision }).includes(xtream.domain), false);
  assert.equal(JSON.stringify({ revision }).includes(xtream.username), false);
  assert.equal(JSON.stringify({ revision }).includes(xtream.password), false);
  assert.deepStrictEqual(getSourceOperationCommitState({ "source-a": xtream }, "source-a", revision), {
    sourceId: "source-a",
    fingerprint: revision,
    exists: true,
    ready: true,
  });
  assert.deepStrictEqual(getSourceOperationCommitState({}, "source-a", revision), {
    sourceId: "source-a",
    fingerprint: revision,
    exists: false,
    ready: false,
  });
});
