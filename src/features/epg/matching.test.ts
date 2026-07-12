import { test } from "node:test";
import assert from "node:assert";
import { normalizeEpgLookupText, normalizeEpgUrlKey } from "./matching.ts";

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
