import assert from "node:assert/strict";
import test from "node:test";
import {
  clampToWorkArea,
  isTrueMaximized,
  LIBRARY_WINDOW_MIN,
  logicalWindowReading,
  nextVodDisplay,
  planWindowRestore,
  VOD_WINDOWED_MIN,
} from "./display.ts";

const WORK_AREA = { width: 1920, height: 1040 };

test("double-click toggles the display in both directions", () => {
  assert.equal(nextVodDisplay("fullscreen", "double-click"), "windowed");
  assert.equal(nextVodDisplay("windowed", "double-click"), "fullscreen");
});

test("Esc leaves fullscreen and quits a windowed player", () => {
  assert.equal(nextVodDisplay("fullscreen", "escape"), "windowed");
  assert.equal(nextVodDisplay("windowed", "escape"), null);
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

test("window sizes are converted from physical pixels once, at 150%", () => {
  // 2880 x 1800 at 150%: the window API reports physical, the rest is logical.
  const reading = logicalWindowReading({
    inner: { width: 2400, height: 1500 },
    outer: { width: 2880, height: 1759 },
    monitor: { width: 2880, height: 1800 },
    reportedMaximized: true,
    scaleFactor: 1.5,
  });
  assert.deepEqual(reading.monitor, { width: 1920, height: 1200 });
  assert.equal(reading.innerWidth, 1600);
  assert.equal(reading.innerHeight, 1000);
  assert.equal(reading.maximized, true);

  // A physical 1200 x 750 window is 800 x 500 logical: below the library
  // minimum, so it must be restored rather than left alone.
  const small = logicalWindowReading({
    inner: { width: 1200, height: 750 },
    outer: { width: 1216, height: 789 },
    monitor: { width: 2880, height: 1800 },
    reportedMaximized: false,
    scaleFactor: 1.5,
  });
  assert.equal(small.innerWidth, 800);
  const plan = planWindowRestore({
    snapshot: small,
    current: small,
    workArea: small.monitor ?? WORK_AREA,
  });
  assert.deepEqual(plan, { kind: "size", size: { width: 1100, height: 700 } });

  // A pre-VOD physical 1800 x 1200 is 1200 x 800 logical, and that is the size
  // the restore must ask for.
  const snapshot = logicalWindowReading({
    inner: { width: 1800, height: 1200 },
    outer: { width: 1816, height: 1239 },
    monitor: { width: 2880, height: 1800 },
    reportedMaximized: false,
    scaleFactor: 1.5,
  });
  assert.deepEqual(
    planWindowRestore({
      snapshot,
      current: { innerWidth: 480, innerHeight: 270, maximized: false },
      workArea: snapshot.monitor ?? WORK_AREA,
    }),
    { kind: "size", size: { width: 1200, height: 800 } },
  );
});

test("window sizes convert at 125% too", () => {
  const reading = logicalWindowReading({
    inner: { width: 1250, height: 875 },
    outer: { width: 2400, height: 1399 },
    monitor: { width: 2400, height: 1440 },
    reportedMaximized: true,
    scaleFactor: 1.25,
  });
  assert.equal(reading.innerWidth, 1000);
  assert.equal(reading.monitor?.width, 1920);
  assert.equal(reading.monitor?.height, 1152);
  assert.equal(reading.maximized, true);
});
