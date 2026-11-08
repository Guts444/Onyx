import assert from "node:assert/strict";
import test from "node:test";
import { calculateVideoMarginRatio, createLayoutSync } from "./layout.ts";

test("a mounted preview surface maps to bounded window-relative video margins", () => {
  assert.deepEqual(
    calculateVideoMarginRatio(
      { left: 454, right: 874, top: 48, bottom: 284, width: 420, height: 236 },
      { width: 1440, height: 900 },
    ),
    {
      left: 454 / 1440,
      right: (1440 - 874) / 1440,
      top: 48 / 900,
      bottom: (900 - 284) / 900,
    },
  );
});

test("an unmounted or collapsed surface never becomes zero margins for the whole window", () => {
  assert.equal(
    calculateVideoMarginRatio(
      { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 },
      { width: 1440, height: 900 },
    ),
    null,
  );
});

test("invalid viewport dimensions cannot produce a whole-window video surface", () => {
  assert.equal(
    calculateVideoMarginRatio(
      { left: 20, right: 420, top: 20, bottom: 245, width: 400, height: 225 },
      { width: 0, height: 0 },
    ),
    null,
  );
});

function fakeScheduler() {
  const timers: Array<{ handle: number; callback: () => void }> = [];
  let nextHandle = 1;
  return {
    timers,
    scheduler: {
      setTimeout(callback: () => void) {
        const handle = nextHandle++;
        timers.push({ handle, callback });
        return handle;
      },
      clearTimeout(handle: number) {
        const index = timers.findIndex((timer) => timer.handle === handle);
        if (index >= 0) timers.splice(index, 1);
      },
    },
  };
}

test("a window change syncs again after it settles", () => {
  let syncs = 0;
  const { timers, scheduler } = fakeScheduler();
  const layoutSync = createLayoutSync(() => { syncs += 1; }, 200, scheduler);

  layoutSync.schedule();

  assert.equal(syncs, 1);
  assert.equal(timers.length, 1);

  timers.shift()?.callback();
  assert.equal(syncs, 2);
});

test("a burst of window events leaves one trailing sync", () => {
  let syncs = 0;
  const { timers, scheduler } = fakeScheduler();
  const layoutSync = createLayoutSync(() => { syncs += 1; }, 200, scheduler);

  layoutSync.schedule();
  layoutSync.schedule();
  layoutSync.schedule();

  assert.equal(syncs, 3);
  assert.equal(timers.length, 1);

  timers.shift()?.callback();
  assert.equal(syncs, 4);
});

test("cancelling drops the trailing sync", () => {
  let syncs = 0;
  const { timers, scheduler } = fakeScheduler();
  const layoutSync = createLayoutSync(() => { syncs += 1; }, 200, scheduler);

  layoutSync.schedule();
  layoutSync.cancel();

  assert.equal(timers.length, 0);
  assert.equal(syncs, 1);
});
