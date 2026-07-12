import { test } from "node:test";
import assert from "node:assert";
import {
  formatEpgDirectoryDiagnostics,
  formatEpgFailureStatus,
  formatEpgStoreDiagnostics,
  sanitizeEpgSourceLabel,
} from "./diagnostics.ts";

test("directory diagnostics distinguish corrupt cache recovery from reset", () => {
  const status = formatEpgDirectoryDiagnostics({
    skippedProgrammeCount: 7,
    warnings: [],
    recovered: true,
    corrupt: true,
  });

  assert.match(status, /Skipped 7 malformed programmes/);
  assert.match(status, /corrupt.*recovered from backup/i);
  assert.doesNotMatch(status, /reset|repaired/i);
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

test("failed backup repair reports usable memory state and retry without parser or secret leakage", () => {
  const secret = "https://provider.test/Guide.xml?Token=top-secret";
  const status = formatEpgStoreDiagnostics({
    recovered: true,
    corrupt: true,
    warnings: [
      `The recovered EPG cache could not be repaired on disk. ${secret}`,
      "The recovered EPG cache could not be repaired on disk again.",
    ],
  });

  assert.match(status, /usable.*in memory/i);
  assert.match(status, /disk repair failed.*will retry/i);
  assert.doesNotMatch(status, /guide entries|parsed|reset|was repaired/i);
  assert.doesNotMatch(status, /provider\.test|Guide\.xml|Token|top-secret/i);
  assert.equal((status.match(/disk repair failed/gi) ?? []).length, 1);
});

test("refresh failures use a safe source label and omit raw backend errors", () => {
  const status = formatEpgFailureStatus("provider.test");
  assert.equal(status, "provider.test: the guide could not be updated.");
});

test("malformed credential-bearing guide labels fall back to a generic label", () => {
  assert.equal(sanitizeEpgSourceLabel("not-a-url?token=top-secret"), "EPG guide");
  assert.equal(sanitizeEpgSourceLabel("provider.test"), "provider.test");
});
