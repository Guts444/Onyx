import { test } from "node:test";
import assert from "node:assert";
import type { Channel } from "../../domain/iptv.ts";
import type { PlaylistSnapshot, SavedPlaylistSource } from "../../domain/sourceProfiles.ts";
import {
  getSourceOperationCommitState,
  getSourceOperationFingerprint,
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
  sourceId: "source-a",
  playlist: { name: "old", channels: [], groups: [], importedAt: "then", disabledChannelCount: 0, skippedEntryCount: 0 },
  selectedChannelId: "old-a",
  savedAt: "then",
} as PlaylistSnapshot;

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
  assert.equal(migrated.playlistSnapshot?.selectedChannelId, "new-a");
  assert.deepStrictEqual(migrated.savedEpgMappings.scope, {
    "channel:unknown": "guide-b",
    "tvg-id:x": "guide-c",
    "channel:new-a": "guide-a",
  });
});

test("source operation commit state uses current existence, readiness, and a secret-free configuration fingerprint", () => {
  const fingerprint = getSourceOperationFingerprint(source);
  assert.equal(fingerprint.includes(source.url), false);
  assert.deepStrictEqual(getSourceOperationCommitState({ "source-a": source }, "source-a"), {
    sourceId: "source-a",
    fingerprint,
    exists: true,
    ready: true,
  });
  assert.deepStrictEqual(getSourceOperationCommitState({}, "source-a"), {
    sourceId: "source-a",
    fingerprint: null,
    exists: false,
    ready: false,
  });
});
