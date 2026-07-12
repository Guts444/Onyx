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
import { buildCredentialFreeXtreamChannel, materializeChannelForPlayback } from "./materialize.ts";

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

test("snapshot sanitization intentionally strips runtime-only Xtream origin provenance", () => {
  const channel = buildCredentialFreeXtreamChannel(
    { name: "News", stream: "https://cdn.example/live/provider-user/provider-pass/42.ts" },
    "source_xtream",
  );
  const sanitized = sanitizePlaylistSnapshot(snapshot("source_xtream", channel));
  const savedChannel = sanitized.playlist.channels[0];

  assert.equal(JSON.stringify(sanitized).includes("cdn.example"), false);
  assert.equal(
    materializeChannelForPlayback(savedChannel, {
      id: "source_xtream", kind: "xtream", domain: "https://auth.example/base",
      username: "runtime-user", password: "runtime-password",
    }).stream,
    "https://auth.example/base/live/runtime-user/runtime-password/42.ts",
  );
});

test("remote snapshots rebuild allowlisted fields and redact every string metadata field", () => {
  const secretUrl = "https://viewer:super-secret@provider.example/live/viewer/super-secret/42.ts?token=secret-token";
  const input = snapshot("source_remote", {
    ...remoteChannel,
    name: `News ${secretUrl}`, group: `Group ${secretUrl}`, tvgId: `id ${secretUrl}`,
    tvgName: `TV ${secretUrl}`, logo: secretUrl, playabilityError: `Error ${secretUrl}`,
    streamDescriptor: { kind: "direct", persistedSecret: secretUrl } as never,
    arbitrarySecret: secretUrl,
  } as Channel);
  input.sourceId = secretUrl;
  input.selectedChannelId = secretUrl;
  input.savedAt = secretUrl;
  input.playlist.importedAt = secretUrl;
  input.playlist.name = `Playlist ${secretUrl}`;
  input.playlist.groups = [`Group ${secretUrl}`];
  (input.playlist as never as Record<string, unknown>).extra = secretUrl;
  (input as never as Record<string, unknown>).extra = secretUrl;

  const result = sanitizePlaylistSnapshot(input);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal("extra" in result, false);
  assert.equal("extra" in result.playlist, false);
  assert.equal("arbitrarySecret" in result.playlist.channels[0], false);
  assert.deepStrictEqual(result.playlist.channels[0].streamDescriptor, { kind: "remote-m3u" });
});

test("forged persisted Xtream descriptors become display-only and drop extras", () => {
  for (const descriptor of [
    { kind: "xtream", streamType: "LIVE", streamId: "42", container: "ts" },
    { kind: "xtream", streamType: "live", streamId: "../42", container: "ts" },
    { kind: "xtream", streamType: "live", streamId: "42", container: "../ts" },
  ]) {
    const result = sanitizePlaylistSnapshot(snapshot("source_xtream", {
      ...remoteChannel, stream: null, originalStream: null, streamDescriptor: descriptor as never,
    }));
    assert.equal(result.playlist.channels[0].isPlayable, false);
    assert.deepStrictEqual(result.playlist.channels[0].streamDescriptor, { kind: "remote-m3u" });
    assert.equal(isPlaylistSnapshotPlaybackReady(result), false);
  }

  const valid = sanitizePlaylistSnapshot(snapshot("source_xtream", {
    ...remoteChannel, stream: null, originalStream: null,
    streamDescriptor: { kind: "xtream", streamType: "movie", streamId: "42", container: "mkv", secret: "drop-me" } as never,
  }));
  assert.deepStrictEqual(valid.playlist.channels[0].streamDescriptor, {
    kind: "xtream", streamType: "movie", streamId: "42", container: "mkv",
  });
  assert.equal(JSON.stringify(valid).includes("drop-me"), false);
});
