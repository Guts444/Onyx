import { test } from "node:test";
import assert from "node:assert";
import { normalizeEpgSources, sanitizeUpdateIntervalHours } from "./epg.ts";

test("normalizeEpgSources returns empty array for non-array inputs", () => {
  assert.deepStrictEqual(normalizeEpgSources(null), []);
  assert.deepStrictEqual(normalizeEpgSources(undefined), []);
  assert.deepStrictEqual(normalizeEpgSources({}), []);
  assert.deepStrictEqual(normalizeEpgSources("not an array"), []);
  assert.deepStrictEqual(normalizeEpgSources(123), []);
});

test("normalizeEpgSources filters out non-object elements in the array", () => {
  const input = [null, undefined, 123, "string"]; // Removed [] as it's an object in JS
  assert.deepStrictEqual(normalizeEpgSources(input), []);
});

test("normalizeEpgSources handles empty array", () => {
  assert.deepStrictEqual(normalizeEpgSources([]), []);
});

test("normalizeEpgSources normalizes valid and partially valid objects", () => {
  const input = [
    {
      url: "http://example.com/epg.xml",
      enabled: true,
    },
    {
      id: "existing_id",
      url: "http://example.com/epg2.xml",
      enabled: false,
      autoUpdateEnabled: true,
      updateOnStartup: false,
      updateIntervalHours: 12,
      createdAt: "2023-01-01T00:00:00.000Z",
      updatedAt: "2023-01-02T00:00:00.000Z",
    },
  ];

  const result = normalizeEpgSources(input);

  assert.strictEqual(result.length, 2);

  // First element normalization
  assert.ok(result[0].id.startsWith("epg_"));
  assert.strictEqual(result[0].url, "http://example.com/epg.xml");
  assert.strictEqual(result[0].enabled, true);
  assert.strictEqual(result[0].autoUpdateEnabled, false);
  assert.strictEqual(result[0].updateOnStartup, true);
  assert.strictEqual(result[0].updateIntervalHours, 24); // default
  assert.ok(typeof result[0].createdAt === "string");
  assert.ok(typeof result[0].updatedAt === "string");

  // Second element preservation/normalization
  assert.strictEqual(result[1].id, "existing_id");
  assert.strictEqual(result[1].url, "http://example.com/epg2.xml");
  assert.strictEqual(result[1].enabled, false);
  assert.strictEqual(result[1].autoUpdateEnabled, true);
  assert.strictEqual(result[1].updateOnStartup, false);
  assert.strictEqual(result[1].updateIntervalHours, 12);
  assert.strictEqual(result[1].createdAt, "2023-01-01T00:00:00.000Z");
  assert.strictEqual(result[1].updatedAt, "2023-01-02T00:00:00.000Z");
});

test("createEpgSource returns an object with correct default values", () => {
  const result = createEpgSource();

  assert.ok(result.id.startsWith("epg_"));
  assert.strictEqual(result.url, "");
  assert.strictEqual(result.enabled, true);
  assert.strictEqual(result.autoUpdateEnabled, false);
  assert.strictEqual(result.updateOnStartup, true);
  assert.strictEqual(result.updateIntervalHours, 24);
  assert.strictEqual(result.createdAt, result.updatedAt);
  // Ensure it is an ISO string (simple regex check)
  assert.match(result.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("createEpgSource sets values from provided arguments and overrides", () => {
  const url = "http://example.com/guide.xml";
  const overrides = {
    enabled: false,
    autoUpdateEnabled: true,
    updateOnStartup: false,
    updateIntervalHours: 12,
  };

  const result = createEpgSource(url, overrides);

  assert.strictEqual(result.url, url);
  assert.strictEqual(result.enabled, false);
  assert.strictEqual(result.autoUpdateEnabled, true);
  assert.strictEqual(result.updateOnStartup, false);
  assert.strictEqual(result.updateIntervalHours, 12);
});

test("createEpgSource sanitizes invalid updateIntervalHours override", () => {
  const overrides = {
    updateIntervalHours: 999, // Invalid value
  };

  const result = createEpgSource("", overrides);

  // Should fallback to default (24)
  assert.strictEqual(result.updateIntervalHours, 24);
});

test("createEpgSource generates unique IDs", () => {
  const source1 = createEpgSource();
  const source2 = createEpgSource();

  assert.notStrictEqual(source1.id, source2.id);
});

test("normalizeEpgSources sanitizes updateIntervalHours", () => {
  const input = [
    { url: "1", updateIntervalHours: 1 }, // Invalid, should default to 24
    { url: "2", updateIntervalHours: 6 }, // Valid
    { url: "3", updateIntervalHours: 100 }, // Invalid, should default to 24
    { url: "4", updateIntervalHours: "6" }, // Wrong type, should default to 24
  ];

  const result = normalizeEpgSources(input);

  assert.strictEqual(result[0].updateIntervalHours, 24);
  assert.strictEqual(result[1].updateIntervalHours, 6);
  assert.strictEqual(result[2].updateIntervalHours, 24);
  assert.strictEqual(result[3].updateIntervalHours, 24);
});

test("sanitizeUpdateIntervalHours accepts valid numbers", () => {
  assert.strictEqual(sanitizeUpdateIntervalHours(2), 2);
  assert.strictEqual(sanitizeUpdateIntervalHours(4), 4);
  assert.strictEqual(sanitizeUpdateIntervalHours(6), 6);
  assert.strictEqual(sanitizeUpdateIntervalHours(12), 12);
  assert.strictEqual(sanitizeUpdateIntervalHours(24), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(48), 48);
});

test("sanitizeUpdateIntervalHours defaults invalid numbers to 24", () => {
  assert.strictEqual(sanitizeUpdateIntervalHours(1), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(3), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(5), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(100), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(0), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(-6), 24);
});

test("sanitizeUpdateIntervalHours handles decimals by rounding", () => {
  assert.strictEqual(sanitizeUpdateIntervalHours(5.5), 6); // Rounds to 6 (valid)
  assert.strictEqual(sanitizeUpdateIntervalHours(6.4), 6); // Rounds to 6 (valid)
  assert.strictEqual(sanitizeUpdateIntervalHours(3.5), 4); // Rounds to 4 (valid)
  assert.strictEqual(sanitizeUpdateIntervalHours(2.1), 2); // Rounds to 2 (valid)
  assert.strictEqual(sanitizeUpdateIntervalHours(4.6), 24); // Rounds to 5 (invalid) -> defaults to 24
});

test("sanitizeUpdateIntervalHours defaults non-numbers to 24", () => {
  assert.strictEqual(sanitizeUpdateIntervalHours(undefined), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(null), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours("12"), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours("invalid"), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(true), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(false), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours([]), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours({}), 24);
});

test("sanitizeUpdateIntervalHours handles non-finite numbers", () => {
  assert.strictEqual(sanitizeUpdateIntervalHours(NaN), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(Infinity), 24);
  assert.strictEqual(sanitizeUpdateIntervalHours(-Infinity), 24);
});
