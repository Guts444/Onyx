import { test } from "node:test";
import assert from "node:assert";
import {
  enqueuePersistentWrite,
  persistMigratedValue,
  resolvePersistentPayload,
  type AppStatePayload,
  type LoadedPersistentValue,
} from "./usePersistentState.ts";

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
