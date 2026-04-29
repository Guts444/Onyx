import { test } from "node:test";
import assert from "node:assert";
import type {
  PlaylistSnapshot,
  SavedPlaylistSource,
  SourceLibraryIndexEntry,
} from "../../domain/sourceProfiles.ts";
import {
  mergeSourceLibraryIndexEntry,
  normalizePlaylistSnapshot,
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

test("scrubPlaylistSnapshotSecrets redacts Xtream snapshot streams before persistence", () => {
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

  assert.deepStrictEqual(scrubPlaylistSnapshotSecrets(snapshot, savedSources), {
    ...snapshot,
    streamsRedacted: true,
    playlist: {
      ...snapshot.playlist,
      disabledChannelCount: 1,
      channels: [
        {
          ...snapshot.playlist.channels[0],
          stream: "",
          originalStream: "",
          isPlayable: false,
          playabilityError:
            "This cached Xtream channel will be playable after the saved source refreshes.",
        },
      ],
    },
  });
  const m3uSnapshot = { ...snapshot, sourceId: "source_m3u_url_1" };
  assert.deepStrictEqual(scrubPlaylistSnapshotSecrets(m3uSnapshot, savedSources), {
    ...m3uSnapshot,
    streamsRedacted: false,
  });
});

test("scrubPlaylistSnapshotSecrets redacts unknown saved-source snapshots conservatively", () => {
  const snapshot: PlaylistSnapshot = {
    sourceId: "source_missing",
    selectedChannelId: "channel_1",
    savedAt: "2026-01-01T00:00:00.000Z",
    playlist: {
      name: "Unknown saved source",
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

  assert.strictEqual(
    scrubPlaylistSnapshotSecrets(snapshot, savedSources)?.playlist.channels[0]?.stream,
    "",
  );
});

test("normalizePlaylistSnapshot rechecks persisted channel stream safety", () => {
  const snapshot: PlaylistSnapshot = {
    sourceId: null,
    selectedChannelId: "channel_1",
    savedAt: "2026-01-01T00:00:00.000Z",
    playlist: {
      name: "Cached local path",
      importedAt: "2026-01-01T00:00:00.000Z",
      disabledChannelCount: 0,
      skippedEntryCount: 0,
      groups: ["Local"],
      channels: [
        {
          id: "channel_1",
          name: "Local File",
          group: "Local",
          stream: "C:\\Users\\Spectre\\secret.ts",
          originalStream: "C:\\Users\\Spectre\\secret.ts",
          isPlayable: true,
          playabilityError: null,
          logo: null,
          tvgId: null,
          tvgName: null,
        },
      ],
    },
  };

  const normalizedSnapshot = normalizePlaylistSnapshot(snapshot);

  assert.strictEqual(normalizedSnapshot?.playlist.channels[0]?.isPlayable, false);
  assert.strictEqual(normalizedSnapshot?.playlist.disabledChannelCount, 1);
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
