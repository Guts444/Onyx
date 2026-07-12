import { test } from "node:test";
import assert from "node:assert";
import {
  formatEpgDirectoryDiagnostics,
  formatEpgFailureStatus,
  formatEpgStoreDiagnostics,
  sanitizeEpgSourceLabel,
} from "./diagnostics.ts";

test("directory diagnostics surface skipped, recovered, and corrupt reset state", () => {
  const status = formatEpgDirectoryDiagnostics({
    skippedProgrammeCount: 7,
    warnings: [],
    recovered: true,
    corrupt: true,
  });

  assert.match(status, /Skipped 7 malformed programmes/);
  assert.match(status, /recovered from backup/i);
  assert.match(status, /corrupt.*reset/i);
});

test("parser diagnostics are capped, categorized, and never expose credentials", () => {
  const secret = "https://user:password@provider.test/guide.xml?token=top-secret";
  const status = formatEpgDirectoryDiagnostics({
    skippedProgrammeCount: 0,
    warnings: [
      `Invalid timestamp in ${secret}`,
      "Programme references a missing channel",
      "Malformed XML node",
      "Unknown parser warning with token=another-secret",
      "One more warning",
    ],
    recovered: false,
    corrupt: false,
  });

  assert.equal(status.split(" ").filter((part) => part === "Warning:").length <= 3, true);
  assert.doesNotMatch(status, /password|top-secret|another-secret|provider\.test|user:/i);
  assert.match(status, /invalid times/i);
  assert.match(status, /missing channels/i);
});

test("empty corrupt store diagnostics remain visible as a recovery warning", () => {
  const status = formatEpgStoreDiagnostics({
    recovered: false,
    corrupt: true,
    warnings: ["raw backend path C:/Users/name/cache.json"],
  });

  assert.match(status, /corrupt.*reset/i);
  assert.doesNotMatch(status, /C:\/|Users|cache\.json/i);
});

test("refresh failures use a safe source label and omit raw backend errors", () => {
  const status = formatEpgFailureStatus("provider.test");
  assert.equal(status, "provider.test: the guide could not be updated.");
});

test("malformed credential-bearing guide labels fall back to a generic label", () => {
  assert.equal(sanitizeEpgSourceLabel("not-a-url?token=top-secret"), "EPG guide");
  assert.equal(sanitizeEpgSourceLabel("provider.test"), "provider.test");
});
