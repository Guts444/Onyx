import assert from "node:assert/strict";
import test from "node:test";
import {
  commitIfCurrentPlaybackRevision,
  LatestPlaybackOperationCoordinator,
} from "./operations.ts";

test("a newer playback operation prevents an older queued load from running", async () => {
  const coordinator = new LatestPlaybackOperationCoordinator();
  const calls: string[] = [];
  const older = coordinator.begin();
  const newer = coordinator.begin();

  const olderResult = coordinator.run(older, async () => {
    calls.push("older");
    return true;
  });
  const newerResult = coordinator.run(newer, async () => {
    calls.push("newer");
    return true;
  });

  assert.equal(await olderResult, null);
  assert.equal(await newerResult, true);
  assert.deepEqual(calls, ["newer"]);
});

test("invalidation queues a stop after an in-flight load and leaves stop as the final command", async () => {
  const coordinator = new LatestPlaybackOperationCoordinator();
  const calls: string[] = [];
  let releaseLoad!: () => void;
  const loadStarted = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const load = coordinator.begin();
  const loadResult = coordinator.run(load, async () => {
    calls.push("load");
    markStarted();
    await loadStarted;
    return true;
  });
  await started;

  const stop = coordinator.begin();
  const stopResult = coordinator.run(stop, async () => {
    calls.push("stop");
    return true;
  });
  releaseLoad();

  assert.equal(await loadResult, null);
  assert.equal(await stopResult, true);
  assert.deepEqual(calls, ["load", "stop"]);
});

test("serialized fullscreen transitions leave Quit's exit as the final host mutation", async () => {
  const coordinator = new LatestPlaybackOperationCoordinator();
  let revision = 1;
  let hostFullscreen = false;
  let releaseEnter!: () => void;
  const enterBlocked = new Promise<void>((resolve) => {
    releaseEnter = resolve;
  });
  let markEnterStarted!: () => void;
  const enterStarted = new Promise<void>((resolve) => {
    markEnterStarted = resolve;
  });

  const enter = coordinator.begin(() => revision === 1);
  const enterResult = coordinator.run(enter, async () => {
    markEnterStarted();
    await enterBlocked;
    hostFullscreen = true;
    return true;
  });
  await enterStarted;

  revision = 2;
  const exit = coordinator.begin(() => revision === 2);
  const exitResult = coordinator.run(exit, async () => {
    hostFullscreen = false;
    return true;
  });
  releaseEnter();

  assert.equal(await enterResult, null);
  assert.equal(await exitResult, true);
  assert.equal(hostFullscreen, false);
});

test("stale Quit cleanup cannot clear a newer active VOD session", () => {
  let revision = 1;
  let activeMedia = "VOD A";
  const quitRevision = ++revision;

  activeMedia = "VOD B";
  revision += 1;

  const committed = commitIfCurrentPlaybackRevision(quitRevision, () => revision, () => {
    activeMedia = "";
  });

  assert.equal(committed, false);
  assert.equal(activeMedia, "VOD B");
});

test("current Quit cleanup clears its own active VOD session", () => {
  let activeMedia = "VOD A";
  const committed = commitIfCurrentPlaybackRevision(2, () => 2, () => {
    activeMedia = "";
  });
  assert.equal(committed, true);
  assert.equal(activeMedia, "");
});

test("an external guard cancels a stale fullscreen continuation", async () => {
  const coordinator = new LatestPlaybackOperationCoordinator();
  let current = true;
  const token = coordinator.begin(() => current);
  current = false;
  let ran = false;

  const result = await coordinator.run(token, async () => {
    ran = true;
    return true;
  });

  assert.equal(result, null);
  assert.equal(ran, false);
});
