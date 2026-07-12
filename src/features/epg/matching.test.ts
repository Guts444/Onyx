import { test } from "node:test";
import assert from "node:assert";
import {
  createEpgChannelIndex,
  createEpgMappingScope,
  migrateSavedEpgMappings,
  normalizeEpgLookupText,
  normalizeEpgUrlKey,
  reconstructEpgCacheDirectories,
  serializeEpgMappings,
} from "./matching.ts";
import type { EpgDirectoryResponse, EpgSource, SavedEpgMappingStore } from "../../domain/epg.ts";

test("normalizeEpgLookupText handles empty or nullish inputs", () => {
  assert.strictEqual(normalizeEpgLookupText(null), "");
  assert.strictEqual(normalizeEpgLookupText(undefined), "");
  assert.strictEqual(normalizeEpgLookupText(""), "");
});

test("normalizeEpgLookupText removes diacritics and converts to lowercase", () => {
  assert.strictEqual(normalizeEpgLookupText("Café"), "cafe");
  assert.strictEqual(normalizeEpgLookupText("reçu"), "recu");
  assert.strictEqual(normalizeEpgLookupText("Müller"), "muller");
});

test("normalizeEpgLookupText replaces non-alphanumeric characters with spaces and trims", () => {
  assert.strictEqual(normalizeEpgLookupText("BBC One (HD)"), "bbc one hd");
  assert.strictEqual(normalizeEpgLookupText("Channel-1"), "channel 1");
  assert.strictEqual(normalizeEpgLookupText("Hello, World!"), "hello world");
  assert.strictEqual(normalizeEpgLookupText("***"), "");
});

test("normalizeEpgLookupText collapses multiple whitespace characters into single spaces", () => {
  assert.strictEqual(normalizeEpgLookupText("  Hello   World  "), "hello world");
  assert.strictEqual(
    normalizeEpgLookupText(
      "A" + String.fromCharCode(9) + "B" + String.fromCharCode(10) + "C" + String.fromCharCode(13) + "D",
    ),
    "a b c d",
  );
  assert.strictEqual(normalizeEpgLookupText(String.fromCharCode(32, 9, 32, 10, 32, 13, 32)), "");
});

test("EPG URL identity preserves case-sensitive path and query bytes", () => {
  const upper = normalizeEpgUrlKey("https://guide.test/Guide.xml?Token=A");
  const lower = normalizeEpgUrlKey("https://guide.test/guide.xml?token=a");

  assert.notEqual(upper, lower);
  assert.equal(upper, "https://guide.test/Guide.xml?Token=A");
});

test("EPG URL identity deduplicates scheme and host casing while dropping fragments and default ports", () => {
  assert.equal(
    normalizeEpgUrlKey(" XMLTV: HTTPS://Guide.Test:443/Guide.xml?Token=A#private "),
    normalizeEpgUrlKey("https://guide.test/Guide.xml?Token=A"),
  );
});

const epgSource = (id: string, url: string): EpgSource => ({
  id, url, enabled: true, autoUpdateEnabled: false, updateOnStartup: true,
  updateIntervalHours: 24, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

test("legacy URL mapping scopes migrate losslessly to source IDs and serialize without URLs", () => {
  const privateUrl = "https://guide.invalid/feed.xml?token=private";
  const mappings: SavedEpgMappingStore = { [`${privateUrl}\u0001playlist-a`]: { "channel:one": "guide-one" } };
  const migrated = migrateSavedEpgMappings(mappings, [epgSource("epg-a", privateUrl)]);
  assert.deepStrictEqual(migrated, {
    [createEpgMappingScope("playlist-a", "epg-a")]: { "channel:one": "guide-one" },
  });
  const serialized = serializeEpgMappings(migrated, new Set(["epg-a"]));
  assert.equal(JSON.stringify(serialized).includes(privateUrl), false);
  assert.deepStrictEqual(serialized, migrated);
});

test("ambiguous legacy URL mappings deterministically migrate to the first source without collapsing sources", () => {
  const url = "https://guide.invalid/shared.xml";
  let ambiguityWarnings = 0;
  const migrated = migrateSavedEpgMappings(
    { [`${url}\u0001playlist-a`]: { "channel:one": "guide-one" } },
    [epgSource("epg-a", url), epgSource("epg-b", url)],
    () => { ambiguityWarnings += 1; },
  );
  assert.deepStrictEqual(Object.keys(migrated), ["epg-a\u0001playlist-a"]);
  assert.equal(ambiguityWarnings, 1);
});

function directory(sourceId: string): EpgDirectoryResponse {
  return {
    sourceId, fetchedAt: "2026-01-01T00:00:00.000Z", channelCount: 1,
    programmeCount: 0, skippedProgrammeCount: 0, warnings: [], recovered: false, corrupt: false,
    channels: [{ id: "guide-one", uniqueId: "wrong", sourceId, displayNames: ["One"], icon: null }],
  };
}

test("cached directories reconstruct source-based identities and ignore unknown sources", () => {
  const sharedUrl = "https://guide.invalid/shared.xml";
  const reconstructed = reconstructEpgCacheDirectories(
    [directory("epg-a"), directory("epg-b"), directory("unknown")],
    [epgSource("epg-a", sharedUrl), epgSource("epg-b", sharedUrl)],
  );
  assert.deepStrictEqual(Object.keys(reconstructed).sort(), ["epg-a", "epg-b"]);
  assert.equal(Object.prototype.hasOwnProperty.call(reconstructed["epg-a"], "sourceUrl"), false);
  assert.equal(reconstructed["epg-a"].channels[0].uniqueId, "epg-a\u0001guide-one");
  assert.equal(reconstructed["epg-b"].channels[0].uniqueId, "epg-b\u0001guide-one");
  assert.notStrictEqual(reconstructed["epg-a"], reconstructed["epg-b"]);
  assert.equal(createEpgChannelIndex(reconstructed["epg-a"].channels).sourceIdIndex.has("epg-a"), true);
});
