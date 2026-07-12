import { test } from "node:test";
import assert from "node:assert";
import type { SavedPlaylistSource } from "../../domain/sourceProfiles.ts";
import {
  getSourceSecretHydrationFingerprint,
  getXtreamCredentialHydrationFingerprint,
  hydrateSourceSecrets,
  hydrateXtreamCredentials,
} from "./hydration.ts";

const sources: Record<string, SavedPlaylistSource> = {
  alpha: {
    id: "alpha",
    kind: "xtream",
    name: "Alpha",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastLoadedAt: null,
    domain: "alpha.example",
    username: "alpha-user",
    password: "",
  },
  beta: {
    id: "beta",
    kind: "xtream",
    name: "Beta",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastLoadedAt: null,
    domain: "beta.example",
    username: "beta-user",
    password: "",
  },
};

function fulfilledSettlement(source: SavedPlaylistSource, value: string | null) {
  return {
    sourceId: source.id,
    expectedFingerprint: getXtreamCredentialHydrationFingerprint(source),
    result: { status: "fulfilled" as const, value },
  };
}

test("credential hydration applies successes when another keyring read fails", () => {
  const result = hydrateXtreamCredentials(sources, [
    fulfilledSettlement(sources.alpha, "alpha-secret"),
    {
      sourceId: "failed",
      expectedFingerprint: "missing-source",
      result: { status: "rejected" as const, reason: new Error("raw-keyring-error") },
    },
    fulfilledSettlement(sources.beta, "beta-secret"),
  ]);

  assert.equal(result.sources.alpha.kind === "xtream" && result.sources.alpha.password, "alpha-secret");
  assert.equal(result.sources.beta.kind === "xtream" && result.sources.beta.password, "beta-secret");
  assert.deepStrictEqual(result.passwordsBySourceId, {
    alpha: "alpha-secret",
    beta: "beta-secret",
  });
  assert.equal(result.failureCount, 1);
  assert.equal(result.message, "1 saved Xtream credential could not be loaded.");
  assert.equal(JSON.stringify(result).includes("raw-keyring-error"), false);
});

test("credential hydration bounds failure metadata without exposing rejection details", () => {
  const settlements = Array.from({ length: 150 }, (_, index) => ({
    sourceId: `failed-${index}`,
    expectedFingerprint: `missing-${index}`,
    result: {
      status: "rejected" as const,
      reason: new Error(`secret-error-${index}`),
    },
  }));

  const result = hydrateXtreamCredentials(sources, settlements);

  assert.equal(result.failureCount, 99);
  assert.equal(result.message, "99 or more saved Xtream credentials could not be loaded.");
  assert.equal(JSON.stringify(result).includes("secret-error"), false);
});

test("credential hydration cannot reintroduce a source removed while reads were pending", () => {
  const { alpha: _removed, ...remainingSources } = sources;

  const result = hydrateXtreamCredentials(remainingSources, [
    fulfilledSettlement(sources.alpha, "late-secret"),
    fulfilledSettlement(sources.beta, "beta-secret"),
  ]);

  assert.equal("alpha" in result.sources, false);
  assert.equal("alpha" in result.passwordsBySourceId, false);
  assert.equal(result.sources.beta.kind === "xtream" && result.sources.beta.password, "beta-secret");
});

test("credential hydration ignores a password read started before the source config was edited", () => {
  const pending = fulfilledSettlement(sources.alpha, "stale-secret");
  const editedSources: Record<string, SavedPlaylistSource> = {
    ...sources,
    alpha: {
      ...sources.alpha,
      username: "edited-user",
      updatedAt: "2026-01-02T00:00:00.000Z",
    } as SavedPlaylistSource,
  };

  const result = hydrateXtreamCredentials(editedSources, [pending]);

  assert.deepStrictEqual(result.sources.alpha, editedSources.alpha);
  assert.equal("alpha" in result.passwordsBySourceId, false);
});

test("credential hydration ignores a password read for a deleted and recreated source", () => {
  const pending = fulfilledSettlement(sources.alpha, "former-owner-secret");
  const recreatedSources: Record<string, SavedPlaylistSource> = {
    ...sources,
    alpha: {
      ...sources.alpha,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    } as SavedPlaylistSource,
  };

  const result = hydrateXtreamCredentials(recreatedSources, [pending]);

  assert.deepStrictEqual(result.sources.alpha, recreatedSources.alpha);
  assert.equal("alpha" in result.passwordsBySourceId, false);
});

test("credential hydration rejects records whose map key does not match source identity", () => {
  const mismatchedSources: Record<string, SavedPlaylistSource> = {
    alpha: { ...sources.alpha, id: "different-id" } as SavedPlaylistSource,
  };

  const result = hydrateXtreamCredentials(mismatchedSources, [
    fulfilledSettlement(sources.alpha, "misdirected-secret"),
  ]);

  assert.deepStrictEqual(result.sources.alpha, mismatchedSources.alpha);
  assert.deepStrictEqual(result.passwordsBySourceId, {});
});

test("a null keyring result intentionally clears a password only while identity still matches", () => {
  const populatedSources: Record<string, SavedPlaylistSource> = {
    ...sources,
    alpha: { ...sources.alpha, password: "cached-secret" } as SavedPlaylistSource,
  };
  const matching = hydrateXtreamCredentials(populatedSources, [
    fulfilledSettlement(populatedSources.alpha, null),
  ]);
  assert.equal(matching.sources.alpha.kind === "xtream" && matching.sources.alpha.password, "");
  assert.deepStrictEqual(matching.passwordsBySourceId, { alpha: "" });

  const stale = hydrateXtreamCredentials(
    { alpha: { ...populatedSources.alpha, id: "replacement" } as SavedPlaylistSource },
    [fulfilledSettlement(populatedSources.alpha, null)],
  );
  assert.equal(stale.sources.alpha.kind === "xtream" && stale.sources.alpha.password, "cached-secret");
  assert.deepStrictEqual(stale.passwordsBySourceId, {});
});

test("credential hydration fingerprints never contain the password", () => {
  const source = { ...sources.alpha, password: "do-not-log-this" } as SavedPlaylistSource;
  assert.equal(getXtreamCredentialHydrationFingerprint(source).includes("do-not-log-this"), false);
});

const m3uSource: SavedPlaylistSource = {
  id: "m3u-alpha",
  kind: "m3u_url",
  name: "M3U Alpha",
  enabled: true,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  lastLoadedAt: null,
  url: "",
};

function m3uSettlement(source: SavedPlaylistSource, value: string | null) {
  return {
    sourceId: source.id,
    kind: "m3u_url" as const,
    expectedFingerprint: getSourceSecretHydrationFingerprint(source),
    result: { status: "fulfilled" as const, value },
  };
}

function requireM3uSource(source: SavedPlaylistSource) {
  if (source.kind !== "m3u_url") {
    throw new Error(`Expected an M3U URL source, received ${source.kind}`);
  }
  return source;
}

test("M3U hydration fills a scrubbed URL and preserves a legacy URL when keyring is missing", () => {
  const keyringUrl = "https://keyring.invalid/unique-hydrated.m3u";
  const filled = hydrateSourceSecrets({ [m3uSource.id]: m3uSource }, [m3uSettlement(m3uSource, keyringUrl)]);
  assert.equal(requireM3uSource(filled.sources[m3uSource.id]).url, keyringUrl);

  const legacyUrl = "https://legacy.invalid/must-not-be-lost.m3u";
  const legacy = { ...m3uSource, url: legacyUrl } as SavedPlaylistSource;
  const preserved = hydrateSourceSecrets({ [legacy.id]: legacy }, [m3uSettlement(legacy, null)]);
  assert.equal(requireM3uSource(preserved.sources[legacy.id]).url, legacyUrl);
});

test("M3U hydration ignores stale results after edit, deletion, or recreation", () => {
  const lateUrl = "https://late.invalid/must-not-return.m3u";
  const pending = m3uSettlement(m3uSource, lateUrl);
  assert.equal(m3uSource.id in hydrateSourceSecrets({}, [pending]).sources, false);
  for (const changed of [
    { ...m3uSource, updatedAt: "2026-03-02T00:00:00.000Z" },
    { ...m3uSource, createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" },
  ] as SavedPlaylistSource[]) {
    const result = hydrateSourceSecrets({ [changed.id]: changed }, [pending]);
    assert.equal(requireM3uSource(result.sources[changed.id]).url, "");
  }
});

test("source secret hydration applies independent successes and reports non-secret failures", () => {
  const keyringUrl = "https://keyring.invalid/all-settled.m3u";
  const result = hydrateSourceSecrets({ ...sources, [m3uSource.id]: m3uSource }, [
    m3uSettlement(m3uSource, keyringUrl),
    {
      sourceId: "alpha",
      kind: "xtream",
      expectedFingerprint: getSourceSecretHydrationFingerprint(sources.alpha),
      result: { status: "rejected", reason: new Error("raw-secret-with-sensitive-data") },
    },
  ]);
  assert.equal(requireM3uSource(result.sources[m3uSource.id]).url, keyringUrl);
  assert.equal(result.failureCount, 1);
  assert.equal(result.message, "1 saved source secret could not be loaded.");
  assert.equal(JSON.stringify(result).includes("raw-secret-with-sensitive-data"), false);
});

test("source hydration fingerprints contain neither M3U URLs nor Xtream passwords", () => {
  const url = "https://fingerprint.invalid/private-token.m3u";
  assert.equal(getSourceSecretHydrationFingerprint({ ...m3uSource, url } as SavedPlaylistSource).includes(url), false);
  assert.equal(getSourceSecretHydrationFingerprint({ ...sources.alpha, password: "private-password" } as SavedPlaylistSource).includes("private-password"), false);
});
