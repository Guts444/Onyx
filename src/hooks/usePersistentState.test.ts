import { test } from "node:test";
import assert from "node:assert";
import {
  resolvePersistentPayload,
  type AppStatePayload,
  type LoadedPersistentValue,
} from "./usePersistentState.ts";

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
