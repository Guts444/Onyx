import { test } from "node:test";
import assert from "node:assert";
import type { Channel } from "../../domain/iptv.ts";
import type { PlaylistSnapshot } from "../../domain/sourceProfiles.ts";
import {
  isDisplayOnlyChannel,
  isPlaylistSnapshotPlaybackReady,
  sanitizePlaylistSnapshot,
  shouldRefreshPlaylistSnapshot,
} from "./snapshot.ts";

function snapshot(sourceId: string | null, channel: Channel): PlaylistSnapshot {
  return {
    sourceId,
    playlist: {
      name: "Channels",
      channels: [channel],
      groups: [channel.group],
      importedAt: "2026-07-12T00:00:00.000Z",
      disabledChannelCount: 0,
      skippedEntryCount: 0,
    },
    selectedChannelId: channel.id,
    savedAt: "2026-07-12T00:00:01.000Z",
  };
}

const remoteChannel: Channel = {
  id: "remote",
  legacyIds: ["legacy_remote"],
  name: "Remote",
  group: "Live",
  stream: "https://viewer:secret@provider.example/live/viewer/secret/42.ts",
  originalStream: "https://provider.example/watch?token=secret",
  isPlayable: true,
  playabilityError: null,
  logo: null,
  tvgId: null,
  tvgName: null,
};

test("remote M3U snapshots become credential-free display-only caches", () => {
  const result = sanitizePlaylistSnapshot(snapshot("source_remote", remoteChannel));
  const savedChannel = result.playlist.channels[0];

  assert.equal(savedChannel.stream, null);
  assert.equal(savedChannel.originalStream, null);
  assert.deepStrictEqual(savedChannel.streamDescriptor, { kind: "remote-m3u" });
  assert.equal(savedChannel.isPlayable, false);
  assert.equal(result.playlist.disabledChannelCount, 1);
  assert.match(savedChannel.playabilityError ?? "", /refresh/i);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(isDisplayOnlyChannel(savedChannel), true);
  assert.equal(isPlaylistSnapshotPlaybackReady(result), false);
  assert.equal(shouldRefreshPlaylistSnapshot(result), true);
});

test("remote snapshots redact credential-bearing display metadata and errors", () => {
  const result = sanitizePlaylistSnapshot(
    snapshot("source_remote", {
      ...remoteChannel,
      logo: "https://art-user:art-pass@provider.example/logo.png?token=art-token",
      playabilityError:
        "Failed to open https://stream-user:stream-pass@provider.example/live/stream-user/stream-pass/42.ts?token=stream-token",
    }),
  );
  const serialized = JSON.stringify(result);

  for (const secret of ["art-user", "art-pass", "art-token", "stream-user", "stream-pass", "stream-token"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(result.playlist.channels[0].logo ?? "", /redacted/);
});

test("local one-off snapshots retain trusted local playback targets", () => {
  const local = { ...remoteChannel, id: "local", stream: "C:\\media\\movie.mkv", originalStream: "C:\\media\\movie.mkv" };
  const input = snapshot(null, local);
  const result = sanitizePlaylistSnapshot(input);

  assert.equal(result, input);
  assert.equal(result.playlist.channels[0].stream, "C:\\media\\movie.mkv");
  assert.equal(isPlaylistSnapshotPlaybackReady(result), true);
  assert.equal(shouldRefreshPlaylistSnapshot(result), false);
});

test("credential-free Xtream descriptors remain runtime-materializable in snapshots", () => {
  const xtream: Channel = {
    ...remoteChannel,
    id: "xtream",
    stream: null,
    originalStream: null,
    streamDescriptor: { kind: "xtream", streamType: "live", streamId: "42", container: "ts" },
  };
  const result = sanitizePlaylistSnapshot(snapshot("source_xtream", xtream));
  const savedChannel = result.playlist.channels[0];

  assert.equal(savedChannel.isPlayable, true);
  assert.equal(isDisplayOnlyChannel(savedChannel), false);
  assert.equal(isPlaylistSnapshotPlaybackReady(result), true);
  assert.equal(shouldRefreshPlaylistSnapshot(result), false);
});
