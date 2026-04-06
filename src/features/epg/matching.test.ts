import { test } from "node:test";
import assert from "node:assert";
import { normalizeEpgUrlKey } from "./matching.ts";

test("normalizeEpgUrlKey returns empty string for empty or whitespace input", () => {
  assert.strictEqual(normalizeEpgUrlKey(""), "");
  assert.strictEqual(normalizeEpgUrlKey("   "), "");
  assert.strictEqual(normalizeEpgUrlKey("\t\n"), "");
});

test("normalizeEpgUrlKey strips 'xmltv:' prefix and trims whitespace", () => {
  assert.strictEqual(normalizeEpgUrlKey("xmltv:http://example.com/epg.xml"), "http://example.com/epg.xml");
  assert.strictEqual(normalizeEpgUrlKey("XMLTV:http://example.com/epg.xml"), "http://example.com/epg.xml");
  assert.strictEqual(normalizeEpgUrlKey("xmltv : http://example.com/epg.xml"), "http://example.com/epg.xml");
  assert.strictEqual(normalizeEpgUrlKey("  xmltv: http://example.com/epg.xml  "), "http://example.com/epg.xml");
});

test("normalizeEpgUrlKey normalizes valid URLs to lowercase", () => {
  assert.strictEqual(normalizeEpgUrlKey("HTTP://EXAMPLE.COM/EPG.XML"), "http://example.com/epg.xml");
  assert.strictEqual(normalizeEpgUrlKey("https://Example.com/Path?Query=1"), "https://example.com/path?query=1");
});

test("normalizeEpgUrlKey falls back to returning lowercase string on URL parsing error", () => {
  assert.strictEqual(normalizeEpgUrlKey("not-a-url"), "not-a-url");
  assert.strictEqual(normalizeEpgUrlKey("INVALID://///URL"), "invalid://///url");
  assert.strictEqual(normalizeEpgUrlKey("XMLTV:SOME-LOCAL-FILE"), "some-local-file");
});
