import { test } from "node:test";
import assert from "node:assert";
import type { SavedPlaylistSource } from "../../domain/sourceProfiles.ts";
import { hydrateXtreamCredentials } from "./hydration.ts";

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

test("credential hydration applies successes when another keyring read fails", () => {
  const result = hydrateXtreamCredentials(sources, [
    { sourceId: "alpha", result: { status: "fulfilled", value: "alpha-secret" } },
    { sourceId: "failed", result: { status: "rejected", reason: new Error("raw-keyring-error") } },
    { sourceId: "beta", result: { status: "fulfilled", value: "beta-secret" } },
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
    { sourceId: "alpha", result: { status: "fulfilled", value: "late-secret" } },
    { sourceId: "beta", result: { status: "fulfilled", value: "beta-secret" } },
  ]);

  assert.equal("alpha" in result.sources, false);
  assert.equal("alpha" in result.passwordsBySourceId, false);
  assert.equal(result.sources.beta.kind === "xtream" && result.sources.beta.password, "beta-secret");
});
