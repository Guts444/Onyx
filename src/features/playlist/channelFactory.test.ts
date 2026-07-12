import { test } from "node:test";
import assert from "node:assert";
import {
  buildChannel,
  canonicalizeStreamIdentity,
  createLegacyChannelId,
  createLocalM3uSourceIdentity,
  normalizeStreamReference,
} from "./channelFactory.ts";
import { sanitizePlaylistSnapshot } from "./snapshot.ts";
import {
  createXtreamStreamDescriptor,
  buildCredentialFreeXtreamChannel,
  materializeChannelForPlayback,
} from "./materialize.ts";

const REMOTE_SOURCE = {
  sourceId: "source_remote_primary",
  trust: "remote" as const,
};

const TRUSTED_LOCAL_SOURCE = {
  sourceId: "local-file:channels.m3u",
  trust: "trusted-local" as const,
};

test("normalizeStreamReference rejects local targets by default", () => {
  const localTargets = [
    "C:\\media\\video.mp4",
    "C:/media/video.mp4",
    "d:\\Movies\\movie.mkv",
    "\\\\SERVER\\Share\\video.mp4",
    "file:///home/user/video.mp4",
  ];

  for (const stream of localTargets) {
    const result = normalizeStreamReference(stream);
    assert.equal(result.stream, stream);
    assert.equal(result.isPlayable, false);
    assert.match(result.playabilityError ?? "", /local stream target/i);
  }
});

test("normalizeStreamReference rejects local targets for an explicit remote source", () => {
  const localTargets = [
    "C:\\media\\video.mp4",
    "\\\\SERVER\\Share\\video.mp4",
    "file:///C:/media/video.mp4",
  ];

  for (const stream of localTargets) {
    const result = normalizeStreamReference(stream, REMOTE_SOURCE);
    assert.equal(result.isPlayable, false);
    assert.match(result.playabilityError ?? "", /local stream target/i);
  }
});

test("normalizeStreamReference allows local targets for trusted local imports", () => {
  const localTargets = [
    "C:\\media\\video.mp4",
    "C:/media/video.mp4",
    "d:\\Movies\\movie.mkv",
    "\\\\SERVER\\Share\\video.mp4",
    "file:///home/user/video.mp4",
  ];

  for (const stream of localTargets) {
    const result = normalizeStreamReference(stream, TRUSTED_LOCAL_SOURCE);
    assert.equal(result.isPlayable, true);
    assert.equal(result.playabilityError, null);
  }
});

test("normalizeStreamReference correctly handles valid remote protocols", () => {
  const validStreams = [
    { input: "http://example.com/stream.m3u8", expected: "http://example.com/stream.m3u8" },
    { input: "https://example.com/stream.m3u8", expected: "https://example.com/stream.m3u8" },
    { input: "rtsp://192.168.1.100:554/stream", expected: "rtsp://192.168.1.100:554/stream" },
    { input: "rtmp://example.com/live", expected: "rtmp://example.com/live" },
    { input: "rtmps://example.com/live", expected: "rtmps://example.com/live" },
    { input: "udp://@239.0.0.1:1234", expected: "udp://239.0.0.1:1234" },
    { input: "tcp://192.168.1.1:1234", expected: "tcp://192.168.1.1:1234" },
    { input: "mms://example.com/stream", expected: "mms://example.com/stream" },
    { input: "mmsh://example.com/stream", expected: "mmsh://example.com/stream" },
    { input: "rtp://127.0.0.1:1234", expected: "rtp://127.0.0.1:1234" },
    { input: "srt://example.com:1234", expected: "srt://example.com:1234" },
  ];

  for (const { input, expected } of validStreams) {
    const result = normalizeStreamReference(input);
    assert.deepStrictEqual(result, {
      stream: expected,
      isPlayable: true,
      playabilityError: null,
    });
  }
});

test("normalizeStreamReference rejects unsupported protocols", () => {
  const unsupportedStreams = [
    "ftp://example.com/video.mp4",
    "smb://192.168.1.100/share/video.mp4",
    "sftp://example.com/video",
  ];

  for (const stream of unsupportedStreams) {
    const parsedUrl = new URL(stream);
    const result = normalizeStreamReference(stream);
    assert.deepStrictEqual(result, {
      stream,
      isPlayable: false,
      playabilityError: `Unsupported stream protocol: ${parsedUrl.protocol}`,
    });
  }
});

test("normalizeStreamReference rejects malformed URLs and random strings", () => {
  const malformedStreams = ["not a url", "just_a_string", ""];

  for (const stream of malformedStreams) {
    const result = normalizeStreamReference(stream);
    assert.deepStrictEqual(result, {
      stream,
      isPlayable: false,
      playabilityError: "Unsupported stream format or malformed URL.",
    });
  }
});

test("normalizeStreamReference handles single-slash URLs consistently", () => {
  // `new URL("http:/missing.slash")` normalizes to `http://missing.slash/` in Node and browsers.
  const result = normalizeStreamReference("http:/missing.slash");
  assert.deepStrictEqual(result, {
    stream: "http://missing.slash/",
    isPlayable: true,
    playabilityError: null,
  });
});

test("normalizeStreamReference trims whitespace before processing", () => {
  const remoteResult = normalizeStreamReference("  http://example.com/stream.m3u8  ");
  assert.deepStrictEqual(remoteResult, {
    stream: "http://example.com/stream.m3u8",
    isPlayable: true,
    playabilityError: null,
  });

  const localResult = normalizeStreamReference(
    "\tC:\\media\\video.mp4\n",
    TRUSTED_LOCAL_SOURCE,
  );
  assert.deepStrictEqual(localResult, {
    stream: "C:\\media\\video.mp4",
    isPlayable: true,
    playabilityError: null,
  });
});

test("buildChannel creates deterministic standards-compatible source-aware IDs", () => {
  const seed = {
    name: "News",
    group: "Live",
    stream: "https://example.com/live.m3u8",
  };

  const first = buildChannel(seed, REMOTE_SOURCE);
  const repeated = buildChannel(seed, REMOTE_SOURCE);
  const otherSource = buildChannel(seed, {
    ...REMOTE_SOURCE,
    sourceId: "source_remote_backup",
  });

  assert.equal(first.id, repeated.id);
  assert.notEqual(first.id, otherSource.id);
  assert.match(first.id, /^channel_[0-9a-f]{64}$/);
  assert.equal(
    first.id,
    "channel_18013436aecfd18d8d0c81f11232f292045f205a34df8440966e8fe6f2dd4eb8",
  );
});

test("buildChannel identity survives Xtream credential rotation", () => {
  const before = buildChannel(
    {
      name: "News",
      group: "Live",
      stream: "https://provider.example/live/old-user/old-password/42.ts",
    },
    REMOTE_SOURCE,
  );
  const after = buildChannel(
    {
      name: "Renamed News",
      group: "Updated Group",
      stream: "https://provider.example/live/new-user/new-password/42.ts",
    },
    REMOTE_SOURCE,
  );

  assert.equal(before.id, after.id);
});

test("malformed Xtream paths produce stable credential-free opaque identities", () => {
  const malformedPaths = [
    (user: string, password: string) => `l%ZZive/${user}/${password}/42.ts`,
    (user: string, password: string) => `%256cive/${user}/${password}/42.ts`,
    (user: string, password: string) => `live%252fadmin/${user}/${password}/42.ts`,
    (user: string, password: string) => `live%255cadmin/${user}/${password}/42.ts`,
    (user: string, password: string) => `live/${user}/${password}/../42.ts`,
  ];

  for (const buildPath of malformedPaths) {
    const before = canonicalizeStreamIdentity(
      `https://old-login:old-userinfo-secret@provider.example/${buildPath("old-user", "old-password")}?token=old-token`,
    );
    const after = canonicalizeStreamIdentity(
      `https://new-login:new-userinfo-secret@provider.example/${buildPath("new-user", "new-password")}?token=new-token`,
    );

    assert.equal(before, after);
    assert.match(before, /^opaque-stream:[0-9a-f]{64}$/);
    for (const secret of ["old-login", "old-userinfo-secret", "old-user", "old-password", "old-token"]) {
      assert.equal(before.includes(secret), false, `identity retained ${secret}`);
    }
  }
});

test("buildChannel identity redacts rotating URL credentials but distinguishes streams", () => {
  const first = buildChannel(
    {
      name: "News",
      stream: "https://user:password@example.com/watch/42?token=first&username=old&password=old",
    },
    REMOTE_SOURCE,
  );
  const rotated = buildChannel(
    {
      name: "News renamed",
      stream: "https://new:secret@example.com/watch/42?token=second&username=new&password=new",
    },
    REMOTE_SOURCE,
  );
  const otherStream = buildChannel(
    {
      name: "News",
      stream: "https://user:password@example.com/watch/43?token=first",
    },
    REMOTE_SOURCE,
  );

  assert.equal(first.id, rotated.id);
  assert.notEqual(first.id, otherStream.id);
});

test("buildChannel identity encoding keeps field boundaries unambiguous", () => {
  const first = buildChannel(
    { name: "baz", group: "q", stream: "r" },
    { sourceId: "foo\u0001bar", trust: "remote" },
  );
  const second = buildChannel(
    { name: "bar", group: "baz", stream: "q\u0001r" },
    { sourceId: "foo", trust: "remote" },
  );

  assert.notEqual(first.id, second.id);
});

test("buildChannel IDs remain unique for a large deterministic fixture", () => {
  const ids = new Set<string>();
  const fixtureSize = 10_000;

  for (let index = 0; index < fixtureSize; index += 1) {
    const channel = buildChannel(
      {
        name: `Channel ${index % 137}`,
        group: `Group ${index % 29}`,
        stream: `https://example.com/live/${index}.m3u8`,
      },
      {
        sourceId: `source_${index % 17}`,
        trust: "remote",
      },
    );
    ids.add(channel.id);
  }

  assert.equal(ids.size, fixtureSize);
});

test("createLocalM3uSourceIdentity is content-aware and does not expose the file name", () => {
  const first = createLocalM3uSourceIdentity("Private Channels.m3u", "#EXTM3U\nhttps://one");
  const repeated = createLocalM3uSourceIdentity("Private Channels.m3u", "#EXTM3U\nhttps://one");
  const sameNameDifferentContent = createLocalM3uSourceIdentity(
    "Private Channels.m3u",
    "#EXTM3U\nhttps://two",
  );

  assert.equal(first, repeated);
  assert.notEqual(first, sameNameDifferentContent);
  assert.match(first, /^local-file_[0-9a-f]{64}$/);
  assert.equal(first.includes("Private Channels"), false);
});

test("createLegacyChannelId preserves the previous deterministic ID mapping", () => {
  assert.equal(
    createLegacyChannelId("News", "Live", "https://example.com/live.m3u8"),
    "channel_q9ejz7",
  );
});

test("saved remote playlist snapshots serialize without stream credentials", () => {
  const channel = buildChannel(
    {
      name: "Private News",
      stream: "https://viewer:super-secret@provider.example/live/viewer/super-secret/42.ts?token=secret-token",
      originalStream: "https://provider.example/watch.m3u8?username=viewer&password=super-secret",
    },
    REMOTE_SOURCE,
  );

  const sanitized = sanitizePlaylistSnapshot({
    sourceId: REMOTE_SOURCE.sourceId,
    playlist: {
      name: "Remote library",
      channels: [channel],
      groups: ["Ungrouped"],
      importedAt: "2026-07-12T00:00:00.000Z",
      disabledChannelCount: 0,
      skippedEntryCount: 0,
    },
    selectedChannelId: channel.id,
    savedAt: "2026-07-12T00:00:01.000Z",
  });
  const serialized = JSON.stringify(sanitized);

  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("viewer"), false);
  assert.equal(sanitized.playlist.channels[0].stream, null);
  assert.equal(sanitized.playlist.channels[0].originalStream, null);
  assert.equal(sanitized.playlist.channels[0].isPlayable, false);
  assert.match(sanitized.playlist.channels[0].playabilityError ?? "", /refresh/i);
});

test("Xtream descriptors materialize a playable URL only from runtime source secrets", () => {
  const descriptor = createXtreamStreamDescriptor(
    "https://provider.example/live/old-user/old-password/42.ts",
  );
  assert.deepStrictEqual(descriptor, {
    kind: "xtream",
    streamType: "live",
    streamId: "42",
    container: "ts",
  });

  const channel = {
    ...buildChannel(
      { name: "News", stream: "https://provider.example/live/old-user/old-password/42.ts" },
      REMOTE_SOURCE,
    ),
    stream: null,
    originalStream: null,
    streamDescriptor: descriptor,
  };
  const materialized = materializeChannelForPlayback(channel, {
    id: REMOTE_SOURCE.sourceId,
    kind: "xtream",
    domain: "https://provider.example/",
    username: "runtime-user",
    password: "runtime-password",
  });

  assert.equal(
    materialized.stream,
    "https://provider.example/live/runtime-user/runtime-password/42.ts",
  );
  assert.equal(channel.stream, null);
});

test("Xtream imports retain only a non-secret stream descriptor", () => {
  const channel = buildCredentialFreeXtreamChannel(
    {
      name: "News",
      group: "Live",
      stream: "https://provider.example/live/plain-user/plain-password/42.ts",
      logo: null,
      tvgId: "news.example",
      tvgName: "News",
    },
    REMOTE_SOURCE.sourceId,
  );
  const serialized = JSON.stringify(channel);

  assert.equal(channel.stream, null);
  assert.equal(channel.originalStream, null);
  assert.equal(channel.isPlayable, true);
  assert.deepStrictEqual(channel.streamDescriptor, {
    kind: "xtream",
    streamType: "live",
    streamId: "42",
    container: "ts",
  });
  assert.equal(serialized.includes("plain-user"), false);
  assert.equal(serialized.includes("plain-password"), false);
});
