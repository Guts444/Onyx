import { test } from "node:test";
import assert from "node:assert";
import { redactCredentialUrl, redactCredentials } from "./redaction.ts";

const REDACTED = "redacted";

test("redactCredentialUrl removes URL userinfo while preserving the stream location", () => {
  const result = redactCredentialUrl(
    "https://viewer:super-secret@provider.example:8443/watch/42.ts?quality=hd#now",
  );

  assert.equal(result, `https://${REDACTED}:${REDACTED}@provider.example:8443/watch/42.ts?quality=hd#now`);
  assert.equal(result.includes("viewer"), false);
  assert.equal(result.includes("super-secret"), false);
});

test("redactCredentialUrl handles every sensitive query key case-insensitively and encoded values", () => {
  const keys = [
    "username",
    "USER",
    "Password",
    "pass",
    "token",
    "AUTH",
    "key",
    "api_key",
    "access_token",
    "authorization",
    "credential",
    "secret",
    "signature",
  ];
  const input = `https://provider.example/watch?quality=hd&${keys
    .map((key, index) => `${key}=secret%2F${index}%3Dvalue`)
    .join("&")}`;
  const result = redactCredentialUrl(input);
  const parsed = new URL(result);

  assert.equal(parsed.searchParams.get("quality"), "hd");
  for (const key of keys) {
    assert.equal(parsed.searchParams.get(key), REDACTED);
  }
  assert.equal(/secret%2F\d+%3Dvalue/i.test(result), false);
});

test("redactCredentialUrl recognizes percent-encoded sensitive query keys", () => {
  const result = redactCredentialUrl(
    "https://provider.example/watch?%75sername=viewer&access%5Ftoken=encoded-secret&keep=context",
  );

  assert.equal(result.includes("viewer"), false);
  assert.equal(result.includes("encoded-secret"), false);
  assert.equal(new URL(result).searchParams.get("keep"), "context");
});

test("redactCredentialUrl removes Xtream path credentials for live movie and series URLs", () => {
  for (const kind of ["live", "movie", "series"]) {
    const result = redactCredentialUrl(
      `https://provider.example/base/${kind}/viewer/p%40ss%2Fword/42.ts`,
    );

    assert.equal(result, `https://provider.example/base/${kind}/${REDACTED}/${REDACTED}/42.ts`);
    assert.equal(result.includes("viewer"), false);
    assert.equal(result.includes("p%40ss"), false);
  }
});

test("redactCredentials sanitizes URLs embedded in useful error context", () => {
  const result = redactCredentials(
    "Playback failed for https://viewer:secret@provider.example/live/viewer/secret/42.ts?token=abc%2F123 (timeout); retry source News.",
  );

  assert.match(result, /^Playback failed for https:\/\//);
  assert.match(result, /provider\.example\/live\/redacted\/redacted\/42\.ts/);
  assert.match(result, /timeout/);
  assert.match(result, /retry source News/);
  assert.equal(/viewer|secret|abc%2F123/.test(result), false);
});

test("redactCredentials preserves libmpv error punctuation outside a credential URL", () => {
  const result = redactCredentials(
    "ffmpeg: failed opening 'https://user:p%40ss@provider.example/movie/user/p%40ss/9.mkv?auth=bearer-secret', error=-5.",
  );

  assert.match(result, /^ffmpeg: failed opening 'https:\/\//);
  assert.match(result, /', error=-5\.$/);
  assert.equal(/user|p%40ss|bearer-secret/.test(result), false);
});

test("redactCredentialUrl leaves non-secret URL context intact", () => {
  const input = "https://provider.example/watch/42.ts?quality=hd&language=en";
  assert.equal(redactCredentialUrl(input), input);
});

test("encoded Xtream kinds are classified once, redacted, and identity-canonicalized", async () => {
  const { canonicalizeStreamIdentity } = await import("./channelFactory.ts");
  for (const kind of ["%6cive", "l%69ve", "Li%56E"]) {
    const input = `https://provider.example/base/${kind}/viewer/super-secret/42.ts`;
    const redacted = redactCredentialUrl(input);
    assert.equal(redacted.includes("viewer"), false);
    assert.equal(redacted.includes("super-secret"), false);
    assert.equal(canonicalizeStreamIdentity(input), "https://provider.example/base/live/__user__/__secret__/42.ts");
  }
});

test("malformed and separator-smuggling Xtream paths are rejected without retaining credentials", () => {
  for (const kind of ["l%ZZive", "%256cive", "live%252fadmin", "%2e%2e", "live%255cadmin"]) {
    const input = `https://provider.example/base/${kind}/viewer/super-secret/42.ts`;
    const result = redactCredentialUrl(input);
    assert.equal(result.includes("viewer"), false, kind);
    assert.equal(result.includes("super-secret"), false, kind);
    assert.match(result, /redacted|invalid/i, kind);
  }
});
