import { test } from "node:test";
import assert from "node:assert";
import type {
  PlaylistSnapshot,
  SavedPlaylistSource,
  SourceLibraryIndexEntry,
} from "../../domain/sourceProfiles.ts";
import {
  mergeSourceLibraryIndexEntry,
  scrubPlaylistSnapshotSecrets,
  scrubSourceProfileSecrets,
} from "./profiles.ts";

const savedSources: Record<string, SavedPlaylistSource> = {
  source_m3u_url_1: {
    id: "source_m3u_url_1",
    kind: "m3u_url",
    name: "M3U",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastLoadedAt: null,
    url: "https://example.com/list.m3u",
  },
  source_xtream_1: {
    id: "source_xtream_1",
    kind: "xtream",
    name: "Xtream",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastLoadedAt: null,
    domain: "example.com",
    username: "user",
    password: "secret-password",
  },
};

test("scrubSourceProfileSecrets removes Xtream passwords before persistence", () => {
  assert.deepStrictEqual(scrubSourceProfileSecrets(savedSources), {
    ...savedSources,
    source_xtream_1: {
      ...savedSources.source_xtream_1,
      password: "",
    },
  });
});

test("scrubPlaylistSnapshotSecrets skips Xtream snapshots before persistence", () => {
  const snapshot: PlaylistSnapshot = {
    sourceId: "source_xtream_1",
    selectedChannelId: "channel_1",
    savedAt: "2026-01-01T00:00:00.000Z",
    playlist: {
      name: "Xtream playlist",
      importedAt: "2026-01-01T00:00:00.000Z",
      disabledChannelCount: 0,
      skippedEntryCount: 0,
      groups: ["News"],
      channels: [
        {
          id: "channel_1",
          name: "News",
          group: "News",
          stream: "https://example.com/live/user/secret-password/1.ts",
          originalStream: "https://example.com/live/user/secret-password/1.ts",
          isPlayable: true,
          playabilityError: null,
          logo: null,
          tvgId: null,
          tvgName: null,
        },
      ],
    },
  };

  assert.strictEqual(scrubPlaylistSnapshotSecrets(snapshot, savedSources), null);
  const m3uSnapshot = { ...snapshot, sourceId: "source_m3u_url_1" };
  assert.strictEqual(scrubPlaylistSnapshotSecrets(m3uSnapshot, savedSources), m3uSnapshot);
});

test("mergeSourceLibraryIndexEntry unions known channel ids and playlist keys", () => {
  const currentEntry: SourceLibraryIndexEntry = {
    channelIds: ["channel_2", "channel_1"],
    playlistPreferenceKeys: ["library_b"],
  };

  assert.deepStrictEqual(
    mergeSourceLibraryIndexEntry(currentEntry, ["channel_3", "channel_1"], "library_a"),
    {
      channelIds: ["channel_1", "channel_2", "channel_3"],
      playlistPreferenceKeys: ["library_a", "library_b"],
    },
  );
});
