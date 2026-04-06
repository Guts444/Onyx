import { test } from "node:test";
import assert from "node:assert";
import { normalizeEpgLookupText } from "./matching.ts";

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
  assert.strictEqual(normalizeEpgLookupText("A\tB\nC\rD"), "a b c d");
  assert.strictEqual(normalizeEpgLookupText(" \t \n \r "), "");
});
