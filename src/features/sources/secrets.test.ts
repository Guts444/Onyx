import { test } from "node:test";
import assert from "node:assert";
import type { SavedPlaylistSource } from "../../domain/sourceProfiles.ts";
import { saveSourceSecretsBeforePersist, saveXtreamPasswordBeforeCommit } from "./secrets.ts";

const sources: Record<string, SavedPlaylistSource> = {
  xtream: {
    id: "xtream",
    kind: "xtream",
    name: "Xtream",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastLoadedAt: null,
    domain: "provider.example",
    username: "viewer",
    password: "existing-password",
  },
  m3u: {
    id: "m3u",
    kind: "m3u_url",
    name: "M3U",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastLoadedAt: null,
    url: "https://provider.example/private.m3u",
  },
};

test("metadata persistence only verifies M3U URLs and never rewrites Xtream passwords", async () => {
  const saves: string[] = [];
  await saveSourceSecretsBeforePersist(sources, {
    loadXtreamPassword: async () => "existing-password",
    saveXtreamPassword: async () => { saves.push("xtream"); },
    loadM3uUrl: async () => "https://provider.example/private.m3u",
    saveM3uUrl: async () => { saves.push("m3u"); },
  });
  assert.deepStrictEqual(saves, []);
});

test("changed M3U URLs are secured before metadata persistence", async () => {
  const saves: string[] = [];
  await saveSourceSecretsBeforePersist(sources, {
    loadXtreamPassword: async () => "old-password",
    saveXtreamPassword: async () => { saves.push("xtream"); },
    loadM3uUrl: async () => "https://provider.example/old.m3u",
    saveM3uUrl: async () => { saves.push("m3u"); },
  });
  assert.deepStrictEqual(saves, ["m3u"]);
});

test("Xtream password edits are secured before the UI commit", async () => {
  const events: string[] = [];
  await saveXtreamPasswordBeforeCommit(
    "xtream",
    "new-password",
    () => { events.push("commit"); },
    async (_sourceId, password) => { events.push(`save:${password}`); },
  );
  assert.deepStrictEqual(events, ["save:new-password", "commit"]);
});

test("Xtream password save failures leave the UI edit uncommitted", async () => {
  let committed = false;
  const error = await saveXtreamPasswordBeforeCommit(
    "xtream",
    "new-password",
    () => { committed = true; },
    async () => { throw new Error("new-password"); },
  ).then(() => null, (reason: unknown) => reason);
  assert.equal(committed, false);
  assert.equal(
    (error as Error).message,
    "Saved source changes could not be secured. Existing saved data was kept.",
  );
  assert.equal((error as Error).message.includes("new-password"), false);
});

test("source secret comparison failures remain credential-free", async () => {
  const error = await saveSourceSecretsBeforePersist(sources, {
    loadXtreamPassword: async () => "existing-password",
    saveXtreamPassword: async () => undefined,
    loadM3uUrl: async () => { throw new Error("https://provider.example/private.m3u"); },
    saveM3uUrl: async () => undefined,
  }).then(() => null, (reason: unknown) => reason);
  assert.equal(
    (error as Error).message,
    "Saved source changes could not be secured. Existing saved data was kept.",
  );
  assert.equal((error as Error).message.includes("existing-password"), false);
});
