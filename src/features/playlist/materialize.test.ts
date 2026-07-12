import { test } from "node:test";
import assert from "node:assert";
import { buildCredentialFreeXtreamChannel, materializeChannelForPlayback } from "./materialize.ts";

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

  assert.equal(result.stream, "https://provider.example/base/live/runtime%20user/runtime%2Fpass/42.ts");
  assert.equal(channel.stream, null);
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
