import assert from "node:assert/strict";
import test from "node:test";
import {
  planLiveViewTransition,
  runLiveViewTransition,
  type LiveDisplay,
  type LiveViewHost,
} from "./views.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createFakeHost(options: {
  native?: boolean;
  gate?: Promise<void>;
  fail?: boolean;
}) {
  let native = options.native ?? false;
  const calls: string[] = [];
  const host: LiveViewHost = {
    isFullscreen: async () => {
      calls.push(`read:${native}`);
      return native;
    },
    setFullscreen: async (value) => {
      calls.push(`set:${value}:begin`);
      if (options.gate) await options.gate;
      if (options.fail) {
        calls.push(`set:${value}:refused`);
        throw new Error("the host refused the change");
      }
      native = value;
      calls.push(`set:${value}:end`);
    },
    applyWindowedMinimum: async () => {
      calls.push("minimum:player");
    },
    applyLibraryMinimum: async () => {
      calls.push("minimum:library");
    },
    restoreWindow: async () => {
      calls.push("restore");
    },
  };
  return { host, calls, nativeState: () => native };
}

test("a selection can open the windowed player straight from the guide", () => {
  const plan = planLiveViewTransition("guide", "windowed");
  assert.ok(plan);
  if (!plan) return;
  assert.equal(plan.interim, "windowed");
  assert.equal(plan.final, "windowed");
  assert.equal(plan.fullscreen, false);
  assert.equal(plan.minimum, "player");
  assert.equal(plan.fallback, "guide");
  assert.equal(planLiveViewTransition("guide", "guide"), null);
});

test("every player transition uses a windowed interim view", () => {
  for (const [from, to] of [
    ["guide", "fullscreen"],
    ["guide", "windowed"],
    ["fullscreen", "windowed"],
    ["fullscreen", "guide"],
    ["windowed", "guide"],
    ["windowed", "fullscreen"],
  ] as const) {
    const plan = planLiveViewTransition(from, to);
    assert.ok(plan, `${from} -> ${to} must have a plan`);
    if (!plan) continue;
    assert.equal(plan.interim, "windowed", `${from} -> ${to} interim`);
    assert.equal(plan.final, to);
  }
});

test("window minimums follow the destination", () => {
  const fullscreen = planLiveViewTransition("guide", "fullscreen");
  assert.equal(fullscreen?.minimum, "none");
  const windowed = planLiveViewTransition("fullscreen", "windowed");
  assert.equal(windowed?.minimum, "player");
  const direct = planLiveViewTransition("guide", "windowed");
  assert.equal(direct?.minimum, "player");
  const guide = planLiveViewTransition("windowed", "guide");
  assert.equal(guide?.minimum, "library");
  assert.equal(guide?.restoreWindow, true);
});

test("opening windowed from the guide never touches fullscreen", async () => {
  const fake = createFakeHost({ native: false });
  const commits: LiveDisplay[] = [];
  const completed = await runLiveViewTransition(
    planLiveViewTransition("guide", "windowed")!,
    fake.host,
    (display) => commits.push(display),
  );

  assert.equal(completed, true);
  assert.deepEqual(commits, ["windowed", "windowed"]);
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("set:")), []);
  assert.ok(fake.calls.includes("minimum:player"));
});

test("entering fullscreen commits the player before the window call resolves", async () => {
  const gate = deferred();
  const fake = createFakeHost({ native: false, gate: gate.promise });
  const commits: LiveDisplay[] = [];
  const run = runLiveViewTransition(
    planLiveViewTransition("guide", "fullscreen")!,
    fake.host,
    (display) => commits.push(display),
  );

  await tick();
  // The window call is still in flight, and the player is already the view:
  // a slow native call can never leave the guide on screen at fullscreen size.
  assert.deepEqual(commits, ["windowed"]);
  assert.deepEqual(fake.calls.slice(0, 2), ["read:false", "set:true:begin"]);
  assert.equal(fake.nativeState(), false);

  gate.resolve();
  assert.equal(await run, true);
  assert.deepEqual(commits, ["windowed", "fullscreen"]);
});

test("the guide is committed only after the window has left fullscreen", async () => {
  const gate = deferred();
  const fake = createFakeHost({ native: true, gate: gate.promise });
  const commits: Array<{ display: LiveDisplay; fullscreen: boolean }> = [];
  const run = runLiveViewTransition(
    planLiveViewTransition("fullscreen", "guide")!,
    fake.host,
    (display) => commits.push({ display, fullscreen: fake.nativeState() }),
  );

  await tick();
  assert.deepEqual(commits, [{ display: "windowed", fullscreen: true }]);
  assert.equal(fake.nativeState(), true);

  gate.resolve();
  assert.equal(await run, true);
  assert.deepEqual(commits, [
    { display: "windowed", fullscreen: true },
    { display: "guide", fullscreen: false },
  ]);
});

test("leaving a windowed player restores the library window before the guide", async () => {
  const fake = createFakeHost({ native: false });
  const order: string[] = [];
  const host: LiveViewHost = {
    ...fake.host,
    applyLibraryMinimum: async () => {
      order.push("minimum");
    },
    restoreWindow: async () => {
      order.push("restore");
    },
  };
  const run = runLiveViewTransition(
    planLiveViewTransition("windowed", "guide")!,
    host,
    (display) => order.push(`commit:${display}`),
  );

  assert.equal(await run, true);
  assert.deepEqual(order, ["commit:windowed", "minimum", "restore", "commit:guide"]);
});

test("a refused enter leaves the guide in the normal window", async () => {
  const fake = createFakeHost({ native: false, fail: true });
  const commits: LiveDisplay[] = [];
  const completed = await runLiveViewTransition(
    planLiveViewTransition("guide", "fullscreen")!,
    fake.host,
    (display) => commits.push(display),
  );

  assert.equal(completed, false);
  assert.deepEqual(commits, ["windowed", "guide"]);
  assert.equal(fake.nativeState(), false);
});

test("a refused exit keeps the fullscreen player rather than a guide in a fullscreen window", async () => {
  const fake = createFakeHost({ native: true, fail: true });
  const commits: LiveDisplay[] = [];
  const completed = await runLiveViewTransition(
    planLiveViewTransition("fullscreen", "windowed")!,
    fake.host,
    (display) => commits.push(display),
  );

  assert.equal(completed, false);
  assert.deepEqual(commits, ["windowed", "fullscreen"]);
  assert.equal(fake.nativeState(), true);
});

test("a window that is already in the target state costs no window call", async () => {
  const fake = createFakeHost({ native: false });
  const completed = await runLiveViewTransition(
    planLiveViewTransition("windowed", "guide")!,
    fake.host,
    () => undefined,
  );

  assert.equal(completed, true);
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("set:")), []);
});
