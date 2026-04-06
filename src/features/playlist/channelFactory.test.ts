import { test } from "node:test";
import assert from "node:assert";
import { sanitizeLabel } from "./channelFactory.ts";

test("sanitizeLabel returns string up to maxLength", () => {
  assert.strictEqual(sanitizeLabel("hello", "fallback", 10), "hello");
  assert.strictEqual(sanitizeLabel("hello world", "fallback", 5), "hello");
});

test("sanitizeLabel collapses multiple whitespaces and trims", () => {
  assert.strictEqual(sanitizeLabel("  hello   world  ", "fallback", 20), "hello world");
  assert.strictEqual(sanitizeLabel("a \n\t b", "fallback", 20), "a b");
});

test("sanitizeLabel replaces control characters with space", () => {
  assert.strictEqual(sanitizeLabel("hello\x00world", "fallback", 20), "hello world");
  assert.strictEqual(sanitizeLabel("hello\x1Fworld", "fallback", 20), "hello world");
  assert.strictEqual(sanitizeLabel("hello\x7Fworld", "fallback", 20), "hello world");
});

test("sanitizeLabel returns fallback if string is empty or whitespace-only", () => {
  assert.strictEqual(sanitizeLabel("", "fallback", 10), "fallback");
  assert.strictEqual(sanitizeLabel("   ", "fallback", 10), "fallback");
  assert.strictEqual(sanitizeLabel("\n\t\x00", "fallback", 10), "fallback");
});
