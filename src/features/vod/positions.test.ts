import assert from "node:assert/strict";
import test from "node:test";
import {
  clearVodPosition,
  isVodPositionWorthSaving,
  removeSourcePositions,
  reviveVodPositions,
  saveVodPosition,
  vodPositionKey,
  VOD_POSITION_LIMIT,
  type VodPositionStore,
} from "./positions.ts";

const SOURCE = "source_xtream_00000000-0000-4000-8000-000000000000";

test("a key is built from ids only, and malformed ids are rejected", () => {
  assert.equal(vodPositionKey(SOURCE, "movie", "101"), `${SOURCE}|movie|101`);
  assert.equal(vodPositionKey(SOURCE, "episode", "201"), `${SOURCE}|episode|201`);
  assert.equal(vodPositionKey(null, "movie", "101"), null);
  assert.equal(vodPositionKey(SOURCE, "movie", "../secret"), null);
  assert.equal(vodPositionKey(SOURCE, "movie", "http://host/live/a/b/1.ts"), null);
});

test("saving starts at ten seconds and stops before the end", () => {
  const store: VodPositionStore = {};
  assert.equal(saveVodPosition(store, "k", 9, 600, 1), store);
  assert.equal(saveVodPosition(store, "k", 10, 600, 1)["k"].position, 10);
  assert.equal(saveVodPosition(store, "k", 569, 600, 1)["k"].position, 569);
  const ended = saveVodPosition(store, "k", 595, 600, 1);
  assert.equal(ended["k"], undefined);
});

test("an unknown or zero duration saves nothing", () => {
  const store = saveVodPosition({}, "k", 42, null, 1);
  assert.deepEqual(store, {});
  assert.deepEqual(saveVodPosition({}, "k", 42, 0, 1), {});
  assert.equal(isVodPositionWorthSaving(42, null), false);
});

test("a null position or unknown duration keeps an older entry", () => {
  const store = saveVodPosition({}, "k", 120, 600, 1);
  assert.equal(saveVodPosition(store, "k", null, 600, 2), store);
  assert.equal(saveVodPosition(store, "k", 120, null, 3), store);
  assert.equal(saveVodPosition(store, "k", Number.NaN, 600, 4), store);
});

test("a save below the threshold clears an older entry", () => {
  const store = saveVodPosition({}, "k", 120, 600, 1);
  const cleared = saveVodPosition(store, "k", 4, 600, 2);
  assert.equal(cleared["k"], undefined);
});

test("an unchanged position keeps the same store object", () => {
  const store = saveVodPosition({}, "k", 120.4, 600, 1);
  const again = saveVodPosition(store, "k", 120.1, 600, 2);
  assert.equal(again, store);
  const moved = saveVodPosition(store, "k", 130, 600, 3);
  assert.notEqual(moved, store);
  assert.equal(moved["k"].updatedAt, 3);
});

test("the store keeps only the newest entries", () => {
  let store: VodPositionStore = {};
  for (let index = 0; index < VOD_POSITION_LIMIT + 20; index += 1) {
    store = saveVodPosition(store, `k${index}`, 60, 600, index);
  }
  assert.equal(Object.keys(store).length, VOD_POSITION_LIMIT);
  assert.equal(store["k0"], undefined);
  assert.ok(store[`k${VOD_POSITION_LIMIT + 19}`]);
});

test("removing a source removes only its entries", () => {
  let store = saveVodPosition({}, vodPositionKey(SOURCE, "movie", "101"), 60, 600, 1);
  store = saveVodPosition(store, vodPositionKey(SOURCE, "episode", "201"), 90, 600, 2);
  store = saveVodPosition(store, vodPositionKey("local", "movie", "101"), 60, 600, 3);
  const next = removeSourcePositions(store, SOURCE);
  assert.equal(Object.keys(next).length, 1);
  assert.ok(next["local|movie|101"]);
  assert.equal(removeSourcePositions(next, "absent"), next);
});

test("clear removes one entry and keeps the rest", () => {
  const store = saveVodPosition({}, "k", 60, 600, 1);
  assert.deepEqual(clearVodPosition(store, "k"), {});
  assert.equal(clearVodPosition(store, "absent"), store);
});

test("persisted data is validated on read", () => {
  const revived = reviveVodPositions({
    [`${SOURCE}|movie|101`]: { position: 60, duration: 600, updatedAt: 5 },
    "not-a-key": { position: 60, duration: 600, updatedAt: 5 },
    [`${SOURCE}|movie|102`]: { position: "60", duration: 600, updatedAt: 5 },
    [`${SOURCE}|movie|103`]: { position: 60, duration: 600 },
    [`${SOURCE}|series|104`]: { position: 60, duration: 600, updatedAt: 5 },
  });
  assert.deepEqual(Object.keys(revived), [`${SOURCE}|movie|101`]);
  assert.deepEqual(reviveVodPositions(null), {});
  assert.deepEqual(reviveVodPositions([]), {});
});
