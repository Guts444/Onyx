import assert from "node:assert/strict";
import test from "node:test";
import { clampSeekPosition, parseSubtitleTracks } from "./media.ts";

test("subtitle tracks expose safe labels and selected state", () => {
  assert.deepEqual(
    parseSubtitleTracks([
      { id: 1, type: "audio", lang: "eng" },
      { id: 2, type: "sub", lang: "eng", title: "English CC", selected: true },
      { id: 3, type: "sub", lang: "por", external: true },
      { id: "bad", type: "sub" },
    ]),
    [
      { id: 2, label: "English CC", language: "eng", selected: true, external: false },
      { id: 3, label: "POR", language: "por", selected: false, external: true },
    ],
  );
});

test("seek positions stay inside finite VOD duration", () => {
  assert.equal(clampSeekPosition(-4, 120), 0);
  assert.equal(clampSeekPosition(60, 120), 60);
  assert.equal(clampSeekPosition(140, 120), 120);
  assert.equal(clampSeekPosition(Number.NaN, 120), 0);
});
