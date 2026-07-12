import { test } from "node:test";
import assert from "node:assert";
import type { Channel } from "../../domain/iptv.ts";
import {
  buildLegacyChannelIdMap,
  migrateChannelId,
  migrateChannelIdArray,
  migratePlaybackSessionChannelIds,
  migrateLegacyPlaylistSnapshotChannelIds,
  migrateSavedEpgMappingStore,
  migrateSourceLibraryIndexChannelIds,
} from "./migration.ts";

function channel(id: string, legacyIds?: string[]): Channel {
  return {
    id,
    legacyIds,
    name: id,
    group: "Live",
    stream: null,
    originalStream: null,
    isPlayable: false,
    playabilityError: "display only",
    logo: null,
    tvgId: null,
    tvgName: null,
  };
}

test("buildLegacyChannelIdMap uses available legacy IDs and keeps the first deterministic match", () => {
  const map = buildLegacyChannelIdMap([
    channel("channel_new_a", ["channel_old_a", "channel_old_shared"]),
    channel("channel_new_b", ["channel_old_b", "channel_old_shared"]),
    channel("channel_new_c"),
  ]);

  assert.deepStrictEqual(map, {
    channel_old_a: "channel_new_a",
    channel_old_shared: "channel_new_a",
    channel_old_b: "channel_new_b",
  });
});

test("channel ID migration preserves unknown references and deterministically deduplicates arrays", () => {
  const map = { old_a: "new", old_b: "new" };

  assert.equal(migrateChannelId("old_a", map), "new");
  assert.equal(migrateChannelId("unknown", map), "unknown");
  assert.equal(migrateChannelId(null, map), null);
  assert.deepStrictEqual(
    migrateChannelIdArray(["old_a", "unknown", "old_b", "new", "unknown"], map),
    ["new", "unknown"],
  );
});

test("playback session migration updates current and resume channel references", () => {
  const session = {
    sourceId: "source_a",
    channelId: "old_a",
    shouldResume: true,
    resumeSourceId: "source_a",
    resumeChannelId: "old_b",
    resumeInFullscreen: false,
  };

  assert.deepStrictEqual(migratePlaybackSessionChannelIds(session, { old_a: "new_a", old_b: "new_b" }), {
    ...session,
    channelId: "new_a",
    resumeChannelId: "new_b",
  });
});

test("legacy playlist snapshot migration updates only the transient selected channel reference", () => {
  const playlistSnapshot = {
    version: 1 as const,
    cacheId: "legacy-cache",
    sourceId: "source_a",
    playlist: {
      name: "Channels",
      channels: [channel("new_a", ["old_a"])],
      groups: ["Live"],
      importedAt: "2026-07-12T00:00:00.000Z",
      disabledChannelCount: 1,
      skippedEntryCount: 0,
    },
    legacySelectedChannelId: "old_a",
    savedAt: "2026-07-12T00:00:01.000Z",
  };

  assert.deepStrictEqual(migrateLegacyPlaylistSnapshotChannelIds(playlistSnapshot, { old_a: "new_a" }), {
    ...playlistSnapshot,
    legacySelectedChannelId: "new_a",
  });
});

test("source library migration updates channelIds without disturbing preference keys", () => {
  const result = migrateSourceLibraryIndexChannelIds(
    {
      source_a: {
        channelIds: ["old_a", "keep", "old_b"],
        playlistPreferenceKeys: ["library_one"],
      },
      source_b: {
        channelIds: ["keep_b"],
        playlistPreferenceKeys: ["library_two"],
      },
    },
    { old_a: "new", old_b: "new" },
  );

  assert.deepStrictEqual(result, {
    source_a: {
      channelIds: ["new", "keep"],
      playlistPreferenceKeys: ["library_one"],
    },
    source_b: {
      channelIds: ["keep_b"],
      playlistPreferenceKeys: ["library_two"],
    },
  });
});

test("EPG mapping migration changes only channel:<id> keys and preserves canonical entries", () => {
  const result = migrateSavedEpgMappingStore(
    {
      scope_a: {
        "channel:old_a": "guide-from-old",
        "channel:new_a": "guide-canonical",
        "name:news": "guide-name",
        "tvg-id:news.example": "guide-tvg",
        unrelated: "guide-other",
      },
    },
    { old_a: "new_a" },
  );

  assert.deepStrictEqual(result, {
    scope_a: {
      "channel:new_a": "guide-canonical",
      "name:news": "guide-name",
      "tvg-id:news.example": "guide-tvg",
      unrelated: "guide-other",
    },
  });
});
