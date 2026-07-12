import { test } from "node:test";
import assert from "node:assert";
import {
  enqueuePersistentWork,
  enqueuePersistentWrite,
  createHydrationRevisionGuard,
  persistPreparedValue,
  persistMigratedValue,
  resolvePersistentPayload,
  type AppStatePayload,
  type LoadedPersistentValue,
} from "./usePersistentState.ts";
import {
  deleteSourceSecretBeforeCommit,
  loadM3uUrl,
  loadXtreamPassword,
  SAVED_SOURCES_PERSISTENCE_KEY,
  saveSourceSecretsBeforePersist,
} from "../features/sources/secrets.ts";
import { scrubSourceProfileSecrets } from "../features/sources/profiles.ts";
import type { SavedPlaylistSource } from "../domain/sourceProfiles.ts";

test("a hydration revision guard rejects a load completed after a newer local mutation", () => {
  const guard = createHydrationRevisionGuard();
  const loadRevision = guard.beginHydration();
  assert.equal(guard.canApply(loadRevision), true);
  guard.recordMutation();
  assert.equal(guard.canApply(loadRevision), false);
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("persistent writes for the same key run in invocation order", async () => {
  const first = deferred();
  const events: string[] = [];
  const firstWrite = enqueuePersistentWrite("ordered-key", async () => {
    events.push("first-started");
    await first.promise;
    events.push("first-finished");
  });
  const secondWrite = enqueuePersistentWrite("ordered-key", async () => {
    events.push("second-started");
  });

  await Promise.resolve();
  assert.deepStrictEqual(events, ["first-started"]);
  first.resolve();
  await Promise.all([firstWrite, secondWrite]);
  assert.deepStrictEqual(events, ["first-started", "first-finished", "second-started"]);
});

test("a rejected persistent write does not poison the next write for that key", async () => {
  const first = deferred();
  const events: string[] = [];
  const failedWrite = enqueuePersistentWrite("recovering-key", async () => {
    events.push("failed-started");
    await first.promise;
  });
  const recoveredWrite = enqueuePersistentWrite("recovering-key", async () => {
    events.push("recovered-started");
  });

  first.reject(new Error("disk full"));
  await assert.rejects(failedWrite, /disk full/);
  await recoveredWrite;
  assert.deepStrictEqual(events, ["failed-started", "recovered-started"]);
});

function sourceFixture(kind: "m3u_url" | "xtream"): SavedPlaylistSource {
  const base = {
    id: `source_${kind}`,
    name: kind,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastLoadedAt: null,
  };
  return kind === "m3u_url"
    ? { ...base, kind, url: "https://example.invalid/private-token/list.m3u" }
    : { ...base, kind, domain: "example.invalid", username: "viewer", password: "private-password" };
}

test("M3U and Xtream deletion waits for an older queued save and commits only after delete runs last", async () => {
  for (const kind of ["m3u_url", "xtream"] as const) {
    const oldSave = deferred();
    const events: string[] = [];
    let credentialPresent = false;
    let transitionCommitted = false;
    const queuedSave = enqueuePersistentWork(SAVED_SOURCES_PERSISTENCE_KEY, async () => {
      events.push(`${kind}-save-started`);
      await oldSave.promise;
      credentialPresent = true;
      events.push(`${kind}-save-finished`);
    });
    const deletion = deleteSourceSecretBeforeCommit(
      sourceFixture(kind),
      () => { transitionCommitted = true; events.push(`${kind}-committed`); },
      async () => { credentialPresent = false; events.push(`${kind}-deleted`); },
    );

    await Promise.resolve();
    assert.equal(transitionCommitted, false);
    assert.deepStrictEqual(events, [`${kind}-save-started`]);
    oldSave.resolve();
    await Promise.all([queuedSave, deletion]);
    assert.equal(credentialPresent, false);
    assert.equal(transitionCommitted, true);
    assert.deepStrictEqual(events, [
      `${kind}-save-started`,
      `${kind}-save-finished`,
      `${kind}-deleted`,
      `${kind}-committed`,
    ]);
  }
});

test("failed M3U and Xtream deletion leaves transitions uncommitted and a later retry succeeds safely", async () => {
  for (const kind of ["m3u_url", "xtream"] as const) {
    const secret = kind === "m3u_url" ? "private-url-token" : "private-password";
    const rawError = `raw-keyring-failure-${secret}`;
    let transitionCommitted = false;
    let attempts = 0;
    const commit = () => { transitionCommitted = true; };
    const remove = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error(rawError);
    };

    const firstError = await deleteSourceSecretBeforeCommit(sourceFixture(kind), commit, remove)
      .then(() => null, (error: unknown) => error);
    assert.equal(transitionCommitted, false);
    assert.equal(firstError instanceof Error, true);
    const safeMessage = (firstError as Error).message;
    assert.equal(safeMessage, "The saved source credential could not be removed. Existing saved data was kept.");
    assert.equal(safeMessage.includes(rawError), false);
    assert.equal(safeMessage.includes(secret), false);

    await deleteSourceSecretBeforeCommit(sourceFixture(kind), commit, remove);
    assert.equal(attempts, 2);
    assert.equal(transitionCommitted, true);
  }
});

test("beforePersist finishes before serialization and backend save", async () => {
  const secretUrl = "https://migration.invalid/unique-playlist-token.m3u";
  const events: string[] = [];
  let persisted: unknown;

  await persistPreparedValue(
    { url: secretUrl },
    async (value) => { assert.equal(value.url, secretUrl); events.push("keyring"); },
    (value) => { events.push("serialize"); return { ...value, url: "" }; },
    async (value) => { events.push("backend"); persisted = value; },
    () => events.push("remove-legacy"),
  );

  assert.deepStrictEqual(events, ["keyring", "serialize", "backend", "remove-legacy"]);
  assert.equal(JSON.stringify(persisted).includes(secretUrl), false);
});

test("beforePersist secures edited M3U and Xtream secrets before scrubbed backend persistence", async () => {
  const m3u = sourceFixture("m3u_url");
  const xtream = sourceFixture("xtream");
  const sources = { [m3u.id]: m3u, [xtream.id]: xtream };
  const events: string[] = [];
  let persisted: unknown;

  await persistPreparedValue(
    sources,
    async (value) => { await saveSourceSecretsBeforePersist(value); events.push("keyring"); },
    (value) => { events.push("scrub"); return scrubSourceProfileSecrets(value); },
    async (value) => { events.push("backend"); persisted = value; },
  );

  assert.deepStrictEqual(events, ["keyring", "scrub", "backend"]);
  assert.equal(await loadM3uUrl(m3u.id), m3u.kind === "m3u_url" ? m3u.url : null);
  assert.equal(await loadXtreamPassword(xtream.id), xtream.kind === "xtream" ? xtream.password : null);
  assert.equal(JSON.stringify(persisted).includes("private-token"), false);
  assert.equal(JSON.stringify(persisted).includes("private-password"), false);
});

test("failed beforePersist leaves backend and legacy storage untouched", async () => {
  const secretUrl = "https://migration.invalid/failing-playlist-token.m3u";
  const events: string[] = [];
  await assert.rejects(() => persistPreparedValue(
    { url: secretUrl },
    async () => { events.push("keyring-attempted"); throw new Error("bounded non-secret warning"); },
    (value) => ({ ...value, url: "" }),
    async () => { events.push("backend"); },
    () => events.push("remove-legacy"),
  ), /bounded non-secret warning/);
  assert.deepStrictEqual(events, ["keyring-attempted"]);
  assert.equal(JSON.stringify(events).includes(secretUrl), false);
});

test("failed prepared persistence does not poison a later save in the same queue", async () => {
  const events: string[] = [];
  const first = enqueuePersistentWrite("prepared-recovery", () => persistPreparedValue(
    "first",
    async () => { events.push("first-before"); throw new Error("credential unavailable"); },
    (value) => value,
    async () => { events.push("first-save"); },
  ));
  const second = enqueuePersistentWrite("prepared-recovery", () => persistPreparedValue(
    "second",
    async () => { events.push("second-before"); },
    (value) => value,
    async () => { events.push("second-save"); },
  ));
  await assert.rejects(first, /credential unavailable/);
  await second;
  assert.deepStrictEqual(events, ["first-before", "second-before", "second-save"]);
});

test("legacy localStorage is removed only after the sanitized backend migration succeeds", async () => {
  const events: string[] = [];
  await persistMigratedValue(
    async () => { events.push("saved"); },
    () => { events.push("removed"); },
  );
  assert.deepStrictEqual(events, ["saved", "removed"]);

  const failedEvents: string[] = [];
  await assert.rejects(() => persistMigratedValue(
    async () => { failedEvents.push("save-attempted"); throw new Error("disk full"); },
    () => { failedEvents.push("removed"); },
  ));
  assert.deepStrictEqual(failedEvents, ["save-attempted"]);
});

const legacyValue: LoadedPersistentValue = {
  value: { source: "localStorage" },
  shouldMigrate: true,
  metadata: {
    source: "legacy-local-storage",
    schemaVersion: null,
    recovered: false,
    corrupt: false,
    quarantined: false,
    unsafeLegacyPlaylist: false,
    degraded: false,
  },
};

function payload(overrides: Partial<AppStatePayload>): AppStatePayload {
  return {
    exists: true,
    value: { source: "backend" },
    schemaVersion: 1,
    recovered: false,
    corrupt: false,
    quarantined: false,
    unsafeLegacyPlaylist: false,
    ...overrides,
  };
}

test("pristine backend absence can migrate the legacy localStorage value", () => {
  assert.deepStrictEqual(resolvePersistentPayload(payload({ exists: false, value: null }), legacyValue), legacyValue);
});

test("quarantined or corrupt backend absence never falls back to localStorage", () => {
  for (const metadata of [{ corrupt: true }, { quarantined: true }]) {
    const loaded = resolvePersistentPayload(
      payload({ exists: false, value: null, ...metadata }),
      legacyValue,
    );
    assert.strictEqual(loaded.value, null);
    assert.strictEqual(loaded.shouldMigrate, false);
    assert.strictEqual(loaded.metadata.source, "backend");
    assert.strictEqual(loaded.metadata.degraded, true);
  }
});

test("schema zero schedules a serializer-driven rewrite after hydration", () => {
  const loaded = resolvePersistentPayload(payload({ schemaVersion: 0 }), legacyValue);
  assert.strictEqual(loaded.shouldMigrate, true);
  assert.strictEqual(loaded.metadata.schemaVersion, 0);
});

test("unsafe legacy playlist is exposed as degraded and schedules sanitizing rewrite", () => {
  const loaded = resolvePersistentPayload(
    payload({ schemaVersion: 0, unsafeLegacyPlaylist: true }),
    legacyValue,
  );
  assert.strictEqual(loaded.shouldMigrate, true);
  assert.strictEqual(loaded.metadata.unsafeLegacyPlaylist, true);
  assert.strictEqual(loaded.metadata.degraded, true);
});

test("recovery metadata is preserved for optional hook consumers", () => {
  const loaded = resolvePersistentPayload(
    payload({ recovered: true, corrupt: true, quarantined: true }),
    legacyValue,
  );
  assert.deepStrictEqual(loaded.metadata, {
    source: "backend",
    schemaVersion: 1,
    recovered: true,
    corrupt: true,
    quarantined: true,
    unsafeLegacyPlaylist: false,
    degraded: true,
  });
});
