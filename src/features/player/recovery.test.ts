import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAYBACK_FAILED_MESSAGE,
  PLAYBACK_LOST_MESSAGE,
  PlaybackRecovery,
  resumeStartPosition,
  type RecoveryOptions,
} from "./recovery.ts";

const OPTIONS: Partial<RecoveryOptions> = {
  firstFrameTimeoutMs: 20_000,
  stallTimeoutMs: 15_000,
  progressTimeoutMs: 30_000,
  seekSuppressionMs: 3_000,
  sustainedPlaybackMs: 60_000,
  retryDelaysMs: [1_000, 2_000, 4_000, 8_000],
};

function started(kind: "live" | "vod" = "live") {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin(kind, 0);
  recovery.loaded(100);
  recovery.firstFrame(200);
  return recovery;
}

function tickUntil(recovery: PlaybackRecovery, from: number, to: number, step = 1_000) {
  let action = { type: "none" } as ReturnType<PlaybackRecovery["tick"]>["action"];
  let snapshot = recovery.snapshot();
  for (let now = from; now <= to; now += step) {
    const result = recovery.tick(now);
    action = result.action;
    snapshot = result.snapshot;
    if (action.type !== "none") return { action, snapshot, now };
  }
  return { action, snapshot, now: to };
}

function tickThrough(recovery: PlaybackRecovery, from: number, to: number, step = 1_000) {
  for (let now = from; now <= to; now += step) {
    const result = recovery.tick(now);
    if (result.action.type !== "none") return { ...result, now };
  }
  return { snapshot: recovery.snapshot(), action: noTickAction(), now: to };
}

function noTickAction() {
  return { type: "none" as const, attempt: 0, delayMs: 0, startAt: null };
}

test("no first frame within the timeout schedules a retry", () => {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin("live", 0);
  const before = tickThrough(recovery, 1_000, 19_000);
  assert.equal(before.action.type, "none");
  assert.equal(before.snapshot.phase, "loading");

  const timedOut = recovery.tick(20_000);
  assert.equal(timedOut.snapshot.phase, "waiting");
  assert.equal(timedOut.snapshot.attempt, 2);
  assert.equal(timedOut.snapshot.message, "Retrying (2 of 5)…");

  const retry = recovery.tick(21_000);
  assert.equal(retry.action.type, "retry");
  assert.equal(retry.action.attempt, 2);
});

test("a stall while buffering needs 15 seconds without progress", () => {
  const recovery = started("live");
  recovery.bufferingChanged(true);
  const before = tickThrough(recovery, 3_000, 15_199);
  assert.equal(before.action.type, "none");
  const after = tickThrough(recovery, 15_200, 15_500);
  assert.equal(after.action.type, "none");
  assert.equal(after.snapshot.phase, "waiting");
});

test("a slow healthy stream is not a stall", () => {
  const recovery = started("live");
  recovery.bufferingChanged(true);
  recovery.progress(0, null, 1_000);
  let now = 2_000;
  for (let second = 0; second < 40; second += 1) {
    recovery.progress(second, null, now);
    recovery.bufferingChanged(true);
    const result = recovery.tick(now);
    assert.equal(result.action.type, "none", `triggered at ${now}`);
    now += 1_000;
  }
});

test("user pause never triggers recovery", () => {
  const recovery = started("vod");
  recovery.pausedChanged(true, 1_000);
  for (let now = 2_000; now <= 120_000; now += 1_000) {
    assert.equal(recovery.tick(now).action.type, "none");
  }
  recovery.pausedChanged(false, 121_000);
  const resumed = tickUntil(recovery, 122_000, 140_000);
  assert.equal(resumed.action.type, "none");
});

test("a seek suppresses the watchdog for three seconds", () => {
  const recovery = started("vod");
  recovery.bufferingChanged(true);
  recovery.seek(10_000);
  const suppressed = tickThrough(recovery, 10_500, 12_999, 500);
  assert.equal(suppressed.action.type, "none");
  assert.equal(suppressed.snapshot.phase, "playing");

  let waiting = null;
  for (let now = 13_500; now <= 29_000; now += 500) {
    const result = recovery.tick(now);
    if (result.snapshot.phase === "waiting") {
      waiting = result;
      break;
    }
  }
  assert.ok(waiting, "the stall should trigger after the seek window");
  assert.equal(waiting?.snapshot.attempt, 2);
});

test("a clean end of a live stream is recoverable", () => {
  const recovery = started("live");
  const result = recovery.endOfStream(5_000);
  assert.equal(result.snapshot.phase, "waiting");
  assert.equal(result.snapshot.attempt, 2);
});

test("a finished VOD is complete, never retried", () => {
  const recovery = started("vod");
  recovery.progress(0, 600, 1_000);
  recovery.progress(599, 600, 5_000);
  const result = recovery.endOfStream(5_100);
  assert.equal(result.snapshot.phase, "idle");
  assert.equal(result.action.type, "none");
  assert.equal(recovery.tick(6_000).action.type, "none");
});

test("a VOD that drops mid-file retries instead of looking finished", () => {
  const recovery = started("vod");
  recovery.progress(0, 7_200, 1_000);
  recovery.progress(2_400, 7_200, 2_000);
  const result = recovery.endOfStream(2_100);
  assert.equal(result.snapshot.phase, "waiting");
  assert.equal(result.snapshot.attempt, 2);
});

test("a declared duration protects a container that cannot report one", () => {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin("vod", 0, 120);
  recovery.loaded(10);
  recovery.firstFrame(20);
  // TS-style: the demuxer estimates the duration from the bytes it has.
  recovery.progress(1, 2, 1_000);
  recovery.progress(18, 18, 18_000);
  const result = recovery.endOfStream(18_100);
  assert.equal(result.snapshot.phase, "waiting");
});

test("a declared duration still allows a real ending", () => {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin("vod", 0, 120);
  recovery.firstFrame(20);
  recovery.progress(119, 120, 1_000);
  const result = recovery.endOfStream(1_100);
  assert.equal(result.snapshot.phase, "idle");
});

test("a truncated duration never turns a drop into completion", () => {
  const recovery = started("vod");
  recovery.progress(2_400, 7_200, 1_000);
  recovery.progress(2_400, 2_400, 2_000);
  const result = recovery.endOfStream(2_100);
  assert.equal(result.snapshot.phase, "waiting");
});

test("a VOD EOF with no known duration retries from the position", () => {
  const recovery = started("vod");
  recovery.progress(42, null, 1_000);
  const result = recovery.endOfStream(1_100);
  assert.equal(result.snapshot.phase, "waiting");
  const retry = recovery.tick(2_100);
  assert.equal(retry.action.startAt, null);
});

test("a retry that hits EOF without progress is the real end", () => {
  const recovery = started("vod");
  recovery.progress(2_400, 7_200, 1_000);
  recovery.bufferingChanged(true);
  const waiting = recovery.endOfStream(2_100);
  assert.equal(waiting.snapshot.phase, "waiting");
  const retry = tickThrough(recovery, 2_200, 5_000);
  assert.equal(retry.action.type, "retry");
  assert.equal(retry.action.startAt, 2_400);
  const ended = recovery.endOfStream(retry.now + 100);
  assert.equal(ended.snapshot.phase, "idle");
});

test("a refusal on the first retry still gets the full ladder", () => {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin("live", 0);
  recovery.firstFrame(10);
  recovery.progress(1, null, 20);
  recovery.loadFailed("reset", 30);
  const retry = tickThrough(recovery, 31, 2_000);
  assert.equal(retry.action.type, "retry");
  // The retry fails before any frame, but the media did play in this ladder.
  recovery.loadFailed("refused", 3_000);
  assert.equal(recovery.snapshot().phase, "waiting");
  assert.equal(recovery.snapshot().maxAttempts, 5);
});

test("a repeated playback-restart does not refresh the attempt clock", () => {
  const recovery = started("live");
  recovery.bufferingChanged(true);
  for (let now = 1_000; now <= 40_000; now += 2_000) {
    // HLS-style reprocessing of the same segments.
    recovery.firstFrame(now);
    if (now < 15_000) assert.equal(recovery.tick(now).snapshot.phase, "playing");
  }
  const waiting = [];
  for (let now = 40_000; now <= 60_000; now += 500) {
    const result = recovery.tick(now);
    if (result.snapshot.phase === "waiting") waiting.push(now);
  }
  assert.ok(waiting.length > 0, "the frozen stream should trigger recovery");
});

test("a frozen HLS replay (position resets every cycle) is a stall", () => {
  const recovery = started("live");
  let now = 1_000;
  // Three cycles of 0..3 seconds, exactly what a dead HLS live window does.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (let second = 0; second <= 3; second += 1) {
      recovery.progress(second, null, now);
      now += 1_000;
    }
  }
  let waiting = null;
  for (; now <= 40_000; now += 500) {
    const result = recovery.tick(now);
    if (result.snapshot.phase === "waiting") {
      waiting = result;
      break;
    }
  }
  assert.ok(waiting, "a replayed window is not progress");
});

test("a healthy HLS style stream that keeps growing never triggers", () => {
  const recovery = started("live");
  let now = 1_000;
  for (let second = 0; second < 60; second += 1) {
    recovery.progress(second * 2, null, now);
    const result = recovery.tick(now);
    assert.equal(result.action.type, "none", `triggered at ${now}`);
    now += 1_000;
  }
});

test("deferring for an unusable surface does not spend an attempt", () => {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin("live", 0);
  const deferred = recovery.defer(5_000);
  assert.equal(deferred.snapshot.phase, "waiting");
  assert.equal(deferred.snapshot.attempt, 1);
  const retry = recovery.tick(8_100);
  assert.equal(retry.action.type, "retry");
  assert.equal(retry.action.attempt, 1);
  assert.equal(retry.snapshot.maxAttempts, 5);
});

test("resumeStartPosition guards the reload path", () => {
  assert.equal(resumeStartPosition("vod", 42, 600), 42);
  assert.equal(resumeStartPosition("vod", 5, 600), null);
  assert.equal(resumeStartPosition("vod", 595, 600), null);
  assert.equal(resumeStartPosition("vod", 42, null), null);
  assert.equal(resumeStartPosition("live", 42, 600), null);
});

test("an error before the first frame gets one retry and then fails", () => {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin("live", 0);
  const first = recovery.loadFailed("http 403", 10);
  assert.equal(first.snapshot.phase, "waiting");
  assert.equal(first.snapshot.attempt, 2);
  assert.equal(first.snapshot.maxAttempts, 2);

  const retry = tickUntil(recovery, 11_000, 12_000);
  assert.equal(retry.action.type, "retry");

  const second = recovery.loadFailed("http 403", 12_100);
  assert.equal(second.snapshot.phase, "failed");
  assert.equal(second.snapshot.message, PLAYBACK_FAILED_MESSAGE);
  assert.equal(second.action.type, "give-up");
});

test("the final message says whether the stream ever opened", () => {
  const refused = new PlaybackRecovery(OPTIONS);
  refused.begin("live", 0);
  refused.loadFailed("http 403", 10);
  refused.loadFailed("http 403", 20);
  assert.equal(refused.snapshot().phase, "failed");
  assert.equal(refused.snapshot().message, PLAYBACK_FAILED_MESSAGE);

  const dropped = new PlaybackRecovery(OPTIONS);
  dropped.begin("live", 0);
  dropped.firstFrame(10);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    dropped.loadFailed("reset", 20);
    tickThrough(dropped, 21, 30_000);
    dropped.firstFrame(30_010);
  }
  dropped.loadFailed("reset", 30_020);
  assert.equal(dropped.snapshot().phase, "failed");
  assert.equal(dropped.snapshot().message, PLAYBACK_LOST_MESSAGE);
});

test("a failure after playback started gets the full ladder", () => {
  const recovery = started("live");
  recovery.bufferingChanged(true);
  const result = tickUntil(recovery, 4_000, 20_000);
  assert.equal(result.snapshot.maxAttempts, 5);
  assert.equal(result.snapshot.attempt, 2);
});

test("the ladder stops after five attempts", () => {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin("live", 0);
  recovery.firstFrame(10);
  let now = 10;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    now += 1;
    const failed = recovery.loadFailed("reset", now);
    assert.equal(failed.snapshot.phase, "waiting", `attempt ${attempt} should wait`);
    const retry = tickThrough(recovery, now + 1, now + 10_000);
    assert.equal(retry.action.type, "retry", `attempt ${attempt} should retry`);
    now = retry.now;
    recovery.firstFrame(now);
  }
  now += 1;
  const last = recovery.loadFailed("reset", now);
  assert.equal(last.snapshot.phase, "failed");
  assert.equal(last.action.type, "give-up");
});

test("sustained playback resets a spent ladder", () => {
  const recovery = started("live");
  recovery.cancel();
  recovery.begin("live", 0);
  recovery.loaded(10);
  recovery.firstFrame(20);
  // Spend four attempts.
  let now = 25;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    recovery.loadFailed("reset", now);
    const retry = tickUntil(recovery, now + 1, now + 10_000);
    assert.equal(retry.action.type, "retry");
    now = retry.now;
    recovery.firstFrame(now);
  }
  assert.equal(recovery.snapshot().attempt, 5);

  // Play for a minute without failing: the next failure starts from one.
  for (let second = 0; second < 70; second += 1) {
    now += 1_000;
    recovery.progress(second, null, now);
    assert.equal(recovery.tick(now).action.type, "none");
  }
  recovery.progress(70, null, now);
  const failure = recovery.loadFailed("reset", now + 1);
  assert.equal(failure.snapshot.attempt, 2);
  assert.equal(failure.snapshot.maxAttempts, 5);
});

test("a long tick gap (sleep or throttling) costs one attempt, not the ladder", () => {
  const recovery = started("live");
  recovery.bufferingChanged(true);
  const wake = recovery.tick(120_000);
  assert.equal(wake.action.type, "none");
  assert.equal(wake.snapshot.phase, "waiting");
  const retry = tickThrough(recovery, 121_000, 122_000);
  assert.equal(retry.action.type, "retry");
  assert.equal(retry.snapshot.attempt, 2);
});

test("cancelling clears the ladder and pending retry", () => {
  const recovery = started("live");
  recovery.loadFailed("reset", 3_000);
  assert.equal(recovery.snapshot().phase, "waiting");
  recovery.cancel();
  assert.equal(recovery.snapshot().phase, "idle");
  assert.equal(tickUntil(recovery, 4_000, 30_000).action.type, "none");
});

test("a VOD retry resumes from the last position, not from zero", () => {
  const recovery = started("vod");
  recovery.progress(42, 600, 2_000);
  recovery.bufferingChanged(true);
  const result = tickUntil(recovery, 4_000, 25_000);
  assert.equal(result.action.type, "retry");
  assert.equal(result.action.startAt, 42);
});

test("a VOD retry near the start or near the end starts from zero", () => {
  const early = started("vod");
  early.progress(4, 600, 2_000);
  early.loadFailed("reset", 3_000);
  assert.equal(early.tick(4_000).action.startAt, null);

  const late = started("vod");
  late.progress(590, 600, 2_000);
  late.loadFailed("reset", 3_000);
  assert.equal(late.tick(4_000).action.startAt, null);

  const unknown = started("vod");
  unknown.progress(42, null, 2_000);
  unknown.loadFailed("reset", 3_000);
  assert.equal(unknown.tick(4_000).action.startAt, null);
});

test("a live retry never carries a start position", () => {
  const recovery = started("live");
  recovery.progress(42, 600, 2_000);
  recovery.loadFailed("reset", 3_000);
  assert.equal(recovery.tick(4_000).action.startAt, null);
});
