import { test } from "node:test";
import assert from "node:assert";
import { getErrorMessage } from "./messages.ts";

const FALLBACK = "The saved source could not be loaded.";
const REDACTED = "redacted";

test("an Error keeps its message", () => {
  assert.equal(getErrorMessage(new Error("The request failed with HTTP 403."), FALLBACK), "The request failed with HTTP 403.");
});

test("a Tauri rejection string is used instead of the fallback", () => {
  assert.equal(
    getErrorMessage("The request failed with HTTP 403.", FALLBACK),
    "The request failed with HTTP 403.",
  );
  assert.equal(
    getErrorMessage("The response is too large to import safely.", FALLBACK),
    "The response is too large to import safely.",
  );
});

test("messages are trimmed before they reach the UI", () => {
  assert.equal(getErrorMessage("  Could not read the server response: timeout. \n", FALLBACK), "Could not read the server response: timeout.");
  assert.equal(getErrorMessage(new Error("  libmpv rejected the command  "), FALLBACK), "libmpv rejected the command");
});

test("empty text uses the fallback", () => {
  assert.equal(getErrorMessage(new Error(""), FALLBACK), FALLBACK);
  assert.equal(getErrorMessage(new Error("   "), FALLBACK), FALLBACK);
  assert.equal(getErrorMessage("", FALLBACK), FALLBACK);
  assert.equal(getErrorMessage(" \n\t ", FALLBACK), FALLBACK);
});

test("anything else uses the fallback", () => {
  for (const value of [null, undefined, 42, true, Symbol("rejection"), {}, [], new Error("")]) {
    assert.equal(getErrorMessage(value, FALLBACK), FALLBACK);
  }
});

test("credential-bearing messages are redacted in both rejection shapes", () => {
  const withCredentials = (prefix: string) =>
    `${prefix} https://provider.example/live/alice/s3cret/42.ts?token=abc123`;

  for (const message of [withCredentials("Request failed for"), withCredentials("Could not fetch")]) {
    const shown = getErrorMessage(message, FALLBACK);
    assert.equal(shown.includes("s3cret"), false, shown);
    assert.equal(shown.includes("abc123"), false, shown);
    assert.equal(shown.includes(REDACTED), true, shown);
  }

  const fromError = getErrorMessage(
    new Error("Request failed for https://provider.example/get.php?username=alice&password=s3cret"),
    FALLBACK,
  );
  assert.equal(fromError.includes("s3cret"), false, fromError);
  assert.equal(fromError.includes("provider.example"), true, "non-secret parts stay readable");
});

test("the fallback itself is never replaced by text from the rejection object", () => {
  assert.equal(getErrorMessage({ message: "object-shaped rejection" }, FALLBACK), FALLBACK);
});
