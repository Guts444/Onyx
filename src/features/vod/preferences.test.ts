import assert from "node:assert/strict";
import test from "node:test";
import {
  getHiddenVodCategoryIds,
  normalizeVodCategoryVisibilityStore,
  removeVodCategoryVisibilitySource,
  updateHiddenVodCategoryIds,
} from "./preferences.ts";

test("VOD category preferences normalize bounded source-scoped movie and series IDs", () => {
  const normalized = normalizeVodCategoryVisibilityStore({
    source: { movie: ["2", "1", "2", null], series: ["9"] },
    broken: null,
  });
  assert.deepEqual(normalized, {
    source: { movie: ["1", "2"], series: ["9"] },
  });
});

test("movie and series visibility update independently and source deletion removes both", () => {
  let store = updateHiddenVodCategoryIds({}, "source", "movie", ["2", "1"]);
  store = updateHiddenVodCategoryIds(store, "source", "series", ["8"]);
  assert.deepEqual(getHiddenVodCategoryIds(store, "source", "movie"), ["1", "2"]);
  assert.deepEqual(getHiddenVodCategoryIds(store, "source", "series"), ["8"]);
  assert.deepEqual(removeVodCategoryVisibilitySource(store, "source"), {});
});
