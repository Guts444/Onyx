import { test } from "node:test";
import assert from "node:assert";
import type { SavedPlaylistSource } from "../../domain/sourceProfiles.ts";
import {
  getXtreamCredentialHydrationFingerprint,
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
