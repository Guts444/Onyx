import { test } from "node:test";
import assert from "node:assert";
import {
  buildCredentialFreeXtreamChannel,
  materializeChannelForPlayback,
  validateXtreamStreamDescriptor,
} from "./materialize.ts";

test("credential-free Xtream channels materialize only from runtime credentials", () => {
  const channel = buildCredentialFreeXtreamChannel(
    {
      name: "News",
      group: "Live",
      stream: "https://old-user:old-pass@provider.example/live/old-user/old-pass/42.ts?token=old-token",
      tvgId: "news.example",
    },
    "source_xtream",
  );

  assert.equal(channel.stream, null);
  assert.equal(channel.originalStream, null);
  assert.equal(JSON.stringify(channel).includes("old-user"), false);
  assert.equal(JSON.stringify(channel).includes("old-pass"), false);
  assert.equal(JSON.stringify(channel).includes("old-token"), false);

  const result = materializeChannelForPlayback(channel, {
    id: "source_xtream",
    kind: "xtream",
    domain: "https://provider.example/base/",
    username: "runtime user",
    password: "runtime/pass",
  });

  assert.equal(result.stream, "https://provider.example/live/runtime%20user/runtime%2Fpass/42.ts");
  assert.equal(channel.stream, null);
});

test("materialization preserves a provider-selected stream origin without credentials", () => {
  const channel = buildCredentialFreeXtreamChannel(
    {
      name: "News",
      stream: "https://stream-cdn.example:8443/live/old-user/old-pass/42.ts",
    },
    "source_xtream",
  );

  assert.equal(JSON.stringify(channel).includes("old-user"), false);
  assert.equal(JSON.stringify(channel).includes("old-pass"), false);
  assert.equal(JSON.stringify(channel).includes("stream-cdn.example"), false);
  assert.deepStrictEqual(channel.streamDescriptor, {
    kind: "xtream", streamType: "live", streamId: "42", container: "ts",
  });

  const result = materializeChannelForPlayback(channel, {
    id: "source_xtream",
    kind: "xtream",
    domain: "https://auth.example/base",
    username: "runtime-user",
    password: "runtime-password",
  });

  assert.equal(
    result.stream,
    "https://stream-cdn.example:8443/live/runtime-user/runtime-password/42.ts",
  );
});

test("channel object spreads preserve trusted runtime-only Xtream origins", () => {
  const channel = buildCredentialFreeXtreamChannel(
    { name: "News", stream: "https://cdn.example/live/provider-user/provider-pass/42.ts" },
    "source_xtream",
  );

  const result = materializeChannelForPlayback({ ...channel }, {
    id: "source_xtream", kind: "xtream", domain: "https://auth.example/base",
    username: "runtime-user", password: "runtime-password",
  });

  assert.equal(result.stream, "https://cdn.example/live/runtime-user/runtime-password/42.ts");
});

test("serialized Xtream descriptors lose runtime provenance and fall back to the source domain", () => {
  const channel = buildCredentialFreeXtreamChannel(
    { name: "News", stream: "https://cdn.example/live/provider-user/provider-pass/42.ts" },
    "source_xtream",
  );
  const restored = JSON.parse(JSON.stringify(channel));

  const result = materializeChannelForPlayback(restored, {
    id: "source_xtream", kind: "xtream", domain: "https://auth.example/base",
    username: "runtime-user", password: "runtime-password",
  });

  assert.equal(result.stream, "https://auth.example/base/live/runtime-user/runtime-password/42.ts");
});

test("forged descriptor origins cannot redirect runtime credentials", () => {
  const channel = buildCredentialFreeXtreamChannel(
    { name: "News", stream: "https://cdn.example/live/provider-user/provider-pass/42.ts" },
    "source_xtream",
  );
  const forged = {
    ...channel,
    streamDescriptor: {
      ...channel.streamDescriptor!,
      origin: "https://attacker.example",
      password: "persisted-secret",
    } as never,
  };

  const result = materializeChannelForPlayback(forged, {
    id: "source_xtream", kind: "xtream", domain: "https://auth.example/base",
    username: "runtime-user", password: "runtime-password",
  });

  assert.equal(result.stream, "https://auth.example/base/live/runtime-user/runtime-password/42.ts");
  assert.equal(JSON.stringify(result.streamDescriptor).includes("attacker"), false);
  assert.equal(JSON.stringify(result.streamDescriptor).includes("persisted-secret"), false);
});

test("materialization rejects display-only channels before the player boundary", () => {
  assert.throws(
    () =>
      materializeChannelForPlayback(
        {
          id: "display-only",
          name: "Cached News",
          group: "Live",
          stream: "ftp://provider.example/channel",
          originalStream: "ftp://provider.example/channel",
          streamDescriptor: { kind: "direct" },
          isPlayable: false,
          playabilityError: "Unsupported stream protocol: ftp:",
          logo: null,
          tvgId: null,
          tvgName: null,
        },
        { id: "source_remote", kind: "m3u_url" },
      ),
    /unsupported stream protocol/i,
  );
});

test("materialization rejects missing credentials without leaking channel details", () => {
  const channel = buildCredentialFreeXtreamChannel(
    { name: "News", stream: "https://provider.example/live/user/password/42.ts" },
    "source_xtream",
  );

  assert.throws(
    () => materializeChannelForPlayback(channel, { id: "source_xtream", kind: "xtream", domain: "https://provider.example" }),
    /credentials are unavailable/i,
  );
});

test("Xtream descriptor validation reconstructs only strict allowlisted fields", () => {
  assert.deepStrictEqual(
    validateXtreamStreamDescriptor({
      kind: "xtream", streamType: "live", streamId: "channel_42-abc", container: "ts",
      origin: "https://attacker.example", password: "persisted-secret",
    }),
    { kind: "xtream", streamType: "live", streamId: "channel_42-abc", container: "ts" },
  );

  for (const streamId of ["", ".", "..", "../42", "a/b", "a\\b", "%2f", "%5C", "a\u0000b"]) {
    assert.equal(validateXtreamStreamDescriptor({ kind: "xtream", streamType: "live", streamId, container: null }), null, streamId);
  }
  for (const container of ["", ".ts", "../ts", "t/s", "t%73", "way-too-long-container"]) {
    assert.equal(validateXtreamStreamDescriptor({ kind: "xtream", streamType: "live", streamId: "42", container }), null, container);
  }
  assert.equal(validateXtreamStreamDescriptor({ kind: "xtream", streamType: "LIVE", streamId: "42", container: "ts" }), null);
});

test("materialization validates forged descriptors and normalizes the runtime domain", () => {
  const channel = buildCredentialFreeXtreamChannel(
    { name: "News", stream: "https://provider.example/live/user/password/42.ts" },
    "source_xtream",
  );
  const source = {
    id: "source_xtream", kind: "xtream" as const,
    domain: "runtime.example/base/?username=old#fragment",
    username: "runtime-user", password: "runtime-password",
  };

  const persistedChannel = JSON.parse(JSON.stringify(channel));
  assert.equal(materializeChannelForPlayback(persistedChannel, source).stream, "http://runtime.example/base/live/runtime-user/runtime-password/42.ts");
  for (const streamId of ["../admin", "%2fadmin", "42/../../admin"]) {
    assert.throws(
      () => materializeChannelForPlayback({ ...persistedChannel, streamDescriptor: { ...persistedChannel.streamDescriptor!, streamId } as never }, source),
      /invalid Xtream stream descriptor/i,
    );
  }
});

test("Xtream-shaped provider direct sources remain credential-free display-only channels", () => {
  const channel = buildCredentialFreeXtreamChannel(
    { name: "Direct", stream: "https://cdn.example/live/vendor/provider-pass/42.ts" },
    "source_xtream",
    true,
  );

  assert.equal(channel.stream, null);
  assert.equal(channel.originalStream, null);
  assert.deepStrictEqual(channel.streamDescriptor, { kind: "direct" });
  assert.equal(channel.isPlayable, false);
  assert.match(channel.playabilityError ?? "", /direct source|refresh/i);
  assert.equal(JSON.stringify(channel).includes("provider-pass"), false);
});

test("nonstandard Xtream direct sources become credential-free display-only channels", () => {
  const channel = buildCredentialFreeXtreamChannel(
    { name: "Direct", stream: "https://cdn.example/watch.m3u8?username=viewer&password=super-secret" },
    "source_xtream",
  );

  assert.equal(channel.stream, null);
  assert.equal(channel.originalStream, null);
  assert.equal(channel.isPlayable, false);
  assert.match(channel.playabilityError ?? "", /direct source|refresh/i);
  assert.equal(JSON.stringify(channel).includes("super-secret"), false);
});
