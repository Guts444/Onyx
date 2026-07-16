import assert from "node:assert/strict";
import test from "node:test";
import type { SavedXtreamSource } from "../../domain/sourceProfiles.ts";
import type { VodCatalogItem } from "../../domain/vod.ts";
import { buildXtreamVodStreamUrl, filterVodCatalog } from "./model.ts";

const source: SavedXtreamSource = {
  id: "source_xtream_test",
  kind: "xtream",
  name: "Test",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastLoadedAt: null,
  domain: "https://provider.example/base",
  username: "viewer name",
  password: "private/pass",
};

const items: VodCatalogItem[] = [
  {
    id: "1",
    title: "The Last Voyage",
    categoryId: "7",
    cover: null,
    plot: "A journey across the sea",
    rating: 8.1,
    year: "2025",
    containerExtension: "mkv",
    added: null,
  },
  {
    id: "2",
    title: "Quiet City",
    categoryId: "8",
    cover: null,
    plot: "A metropolitan drama",
    rating: 7,
    year: "2024",
    containerExtension: "mp4",
    added: null,
  },
];

test("movie and episode stream URLs encode credentials only at the final playback boundary", () => {
  assert.equal(
    buildXtreamVodStreamUrl(source, "https://stream.example:8443/", "movie", "42", "mkv"),
    "https://stream.example:8443/movie/viewer%20name/private%2Fpass/42.mkv",
  );
  assert.equal(
    buildXtreamVodStreamUrl(source, "https://stream.example:8443/", "episode", "episode-9", "mp4"),
    "https://stream.example:8443/series/viewer%20name/private%2Fpass/episode-9.mp4",
  );
});

test("invalid VOD playback descriptors fail without echoing attacker-controlled values", () => {
  const marker = "private-marker";
  assert.throws(
    () => buildXtreamVodStreamUrl(source, "https://stream.example/", "movie", `../${marker}`, "mkv"),
    (error: unknown) => error instanceof Error && !error.message.includes(marker),
  );
});

test("catalog filtering searches title plot and year without changing provider order", () => {
  assert.deepEqual(filterVodCatalog(items, "voyage").map((item) => item.id), ["1"]);
  assert.deepEqual(filterVodCatalog(items, "metropolitan").map((item) => item.id), ["2"]);
  assert.deepEqual(filterVodCatalog(items, "2025").map((item) => item.id), ["1"]);
  assert.deepEqual(filterVodCatalog(items, "").map((item) => item.id), ["1", "2"]);
});
