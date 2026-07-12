import { test } from "node:test";
import assert from "node:assert";
import {
  EPG_SOURCES_STORAGE_KEY,
  deleteEpgUrlBeforeCommit,
  getEpgSecretHydrationFingerprint,
  hydrateEpgSecrets,
  requireEpgMappingMigrationReady,
  saveEpgUrlBeforeCommit,
  saveEpgUrlsBeforePersist,
  serializeEpgSources,
} from "./secrets.ts";
import { enqueuePersistentWork, persistPreparedValue } from "../../hooks/usePersistentState.ts";
import type { EpgSource } from "../../domain/epg.ts";

const source = (id: string, url: string, updatedAt = "2026-01-01T00:00:00.000Z"): EpgSource => ({
  id, url, enabled: true, autoUpdateEnabled: false, updateOnStartup: true,
  updateIntervalHours: 24, createdAt: "2026-01-01T00:00:00.000Z", updatedAt,
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("EPG URLs are saved before an allowlisted URL-free value reaches persistence", async () => {
  const privateUrl = "https://guide.invalid/feed.xml?token=do-not-persist";
  const events: string[] = [];
  let persisted: unknown;
  await persistPreparedValue(
    [source("epg-a", privateUrl)],
    async (sources) => saveEpgUrlsBeforePersist(sources, async (id, url) => {
      assert.equal(id, "epg-a"); assert.equal(url, privateUrl); events.push("keyring");
    }),
    (sources) => { events.push("scrub"); return serializeEpgSources(sources); },
    async (value) => { events.push("backend"); persisted = value; },
  );
  assert.deepStrictEqual(events, ["keyring", "scrub", "backend"]);
  assert.equal(JSON.stringify(persisted).includes(privateUrl), false);
  assert.deepStrictEqual(Object.keys((persisted as EpgSource[])[0]).sort(), [
    "autoUpdateEnabled", "createdAt", "enabled", "id", "updateIntervalHours", "updateOnStartup", "updatedAt", "url",
  ].sort());
  assert.equal((persisted as EpgSource[])[0].url, "");
});

test("keyring failure prevents scrubbed persistence and exposes no raw error", async () => {
  const privateUrl = "https://guide.invalid/feed.xml?token=secret";
  const events: string[] = [];
  const error = await persistPreparedValue(
    [source("epg-a", privateUrl)],
    (sources) => saveEpgUrlsBeforePersist(sources, async () => { throw new Error(`raw ${privateUrl}`); }),
    serializeEpgSources,
    async () => { events.push("backend"); },
  ).then(() => null, (reason: unknown) => reason);
  assert.equal(error instanceof Error, true);
  assert.equal((error as Error).message, "EPG URL changes could not be secured. Existing saved data was kept.");
  assert.equal((error as Error).message.includes(privateUrl), false);
  assert.deepStrictEqual(events, []);
});

test("all-settled hydration is stale-safe, preserves legacy URLs when missing, and has URL-free fingerprints", () => {
  const legacyUrl = "https://legacy.invalid/private.xml";
  const edited = source("epg-edited", "https://new.invalid/feed", "2026-02-01T00:00:00.000Z");
  const current = [source("epg-legacy", legacyUrl), edited];
  const stale = source("epg-edited", "https://old.invalid/feed", "2026-01-01T00:00:00.000Z");
  const result = hydrateEpgSecrets(current, [
    { sourceId: "epg-legacy", expectedFingerprint: getEpgSecretHydrationFingerprint(current[0]), result: { status: "fulfilled", value: null } },
    { sourceId: "epg-edited", expectedFingerprint: getEpgSecretHydrationFingerprint(stale), result: { status: "fulfilled", value: "https://stale.invalid/feed" } },
    { sourceId: "missing", expectedFingerprint: "missing", result: { status: "rejected", reason: new Error(legacyUrl) } },
  ]);
  assert.equal(result.sources[0].url, legacyUrl);
  assert.equal(result.sources[1].url, edited.url);
  assert.equal(result.message, "1 saved EPG URL could not be loaded.");
  assert.equal(result.message?.includes(legacyUrl), false);
  assert.equal(getEpgSecretHydrationFingerprint(current[0]).includes(legacyUrl), false);
});

test("mapping persistence is blocked until URL-scope migration is ready", async () => {
  let persisted = false;
  const error = await persistPreparedValue(
    { "https://guide.invalid/private.xml\u0001playlist": { "channel:one": "guide" } },
    () => requireEpgMappingMigrationReady(false),
    (value) => value,
    async () => { persisted = true; },
  ).then(() => null, (reason: unknown) => reason);
  assert.equal(persisted, false);
  assert.equal((error as Error).message.includes("guide.invalid"), false);
  await requireEpgMappingMigrationReady(true);
});

test("EPG URL replacement commits UI state only after a queued keyring save succeeds", async () => {
  let committed = false;
  let attempts = 0;
  const save = async () => { attempts += 1; if (attempts === 1) throw new Error("raw private URL"); };
  const first = await saveEpgUrlBeforeCommit("epg-a", "https://guide.invalid/new", () => { committed = true; }, save)
    .then(() => null, (reason: unknown) => reason);
  assert.equal(committed, false);
  assert.equal((first as Error).message, "EPG URL changes could not be secured. Existing saved data was kept.");
  await saveEpgUrlBeforeCommit("epg-a", "https://guide.invalid/new", () => { committed = true; }, save);
  assert.equal(committed, true);
});

test("EPG delete waits for older saves, commits only after success, and can retry", async () => {
  const oldSave = deferred();
  const events: string[] = [];
  const queued = enqueuePersistentWork(EPG_SOURCES_STORAGE_KEY, async () => {
    events.push("save-start"); await oldSave.promise; events.push("save-end");
  });
  let attempts = 0;
  let committed = false;
  const remove = async () => { attempts += 1; events.push("delete"); if (attempts === 1) throw new Error("raw secret"); };
  const first = deleteEpgUrlBeforeCommit("epg-a", () => { committed = true; events.push("commit"); }, remove);
  await Promise.resolve();
  assert.deepStrictEqual(events, ["save-start"]);
  oldSave.resolve();
  await queued;
  const firstError = await first.then(() => null, (reason: unknown) => reason);
  assert.equal(committed, false);
  assert.equal((firstError as Error).message, "The saved EPG URL could not be removed. Existing saved data was kept.");
  await deleteEpgUrlBeforeCommit("epg-a", () => { committed = true; events.push("commit"); }, remove);
  assert.equal(committed, true);
  assert.deepStrictEqual(events, ["save-start", "save-end", "delete", "delete", "commit"]);
});
