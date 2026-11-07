import assert from "node:assert/strict";
import test from "node:test";
import {
  clampToWorkArea,
  isTrueMaximized,
  LIBRARY_WINDOW_MIN,
  nextVodDisplay,
  planWindowRestore,
  VOD_WINDOWED_MIN,
} from "./display.ts";

const WORK_AREA = { width: 1920, height: 1040 };

test("double-click toggles the display in both directions", () => {
  assert.equal(nextVodDisplay("fullscreen", "double-click"), "windowed");
  assert.equal(nextVodDisplay("windowed", "double-click"), "fullscreen");
});

test("Esc leaves fullscreen and does nothing in windowed mode", () => {
  assert.equal(nextVodDisplay("fullscreen", "escape"), "windowed");
  assert.equal(nextVodDisplay("windowed", "escape"), "windowed");
});

test("windowed mode allows the small window the library does not", () => {
  assert.ok(VOD_WINDOWED_MIN.width < LIBRARY_WINDOW_MIN.width);
  assert.ok(VOD_WINDOWED_MIN.height < LIBRARY_WINDOW_MIN.height);
});

test("a maximized start is restored as maximized", () => {
  const plan = planWindowRestore({
    snapshot: { innerWidth: 1920, innerHeight: 1009, maximized: true },
    current: { innerWidth: 480, innerHeight: 270, maximized: false },
    workArea: WORK_AREA,
  });
  assert.deepEqual(plan, { kind: "maximize" });
});

test("a snap narrower than the library minimum is put back", () => {
  const plan = planWindowRestore({
    snapshot: { innerWidth: 1456, innerHeight: 939, maximized: false },
    current: { innerWidth: 944, innerHeight: 1041, maximized: false },
    workArea: WORK_AREA,
  });
  assert.deepEqual(plan, { kind: "size", size: { width: 1456, height: 939 } });
});

test("a window the user kept large enough is left alone", () => {
  const plan = planWindowRestore({
    snapshot: { innerWidth: 1200, innerHeight: 800, maximized: false },
    current: { innerWidth: 1280, innerHeight: 900, maximized: false },
    workArea: WORK_AREA,
  });
  assert.deepEqual(plan, { kind: "keep" });
});

test("a window smaller than the library minimum goes back to its old size", () => {
  const plan = planWindowRestore({
    snapshot: { innerWidth: 1456, innerHeight: 939, maximized: false },
    current: { innerWidth: 480, innerHeight: 270, maximized: false },
    workArea: WORK_AREA,
  });
  assert.deepEqual(plan, { kind: "size", size: { width: 1456, height: 939 } });
});

test("the restored size never drops below the library minimum", () => {
  const plan = planWindowRestore({
    snapshot: { innerWidth: 800, innerHeight: 500, maximized: false },
    current: { innerWidth: 480, innerHeight: 270, maximized: false },
    workArea: WORK_AREA,
  });
  assert.deepEqual(plan, { kind: "size", size: { width: 1100, height: 700 } });
});

test("the restored size is clamped to the work area, never moved", () => {
  const plan = planWindowRestore({
    snapshot: { innerWidth: 1600, innerHeight: 1000, maximized: false },
    current: { innerWidth: 480, innerHeight: 270, maximized: false },
    workArea: { width: 1280, height: 720 },
  });
  assert.deepEqual(plan, { kind: "size", size: { width: 1280, height: 720 } });
  assert.deepEqual(clampToWorkArea({ width: 3000, height: 2000 }, WORK_AREA), WORK_AREA);
});

test("a snapped window is not mistaken for a maximized one", () => {
  const monitor = { width: 1920, height: 1080 };
  // Measured on this machine: a maximized frame is 1936 x 1048.
  assert.equal(isTrueMaximized({ width: 1936, height: 1048 }, monitor, true), true);
  assert.equal(isTrueMaximized({ width: 960, height: 1040 }, monitor, true), false);
  assert.equal(isTrueMaximized({ width: 1920, height: 520 }, monitor, true), false);
  assert.equal(isTrueMaximized({ width: 1936, height: 1048 }, monitor, false), false);
});
