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
  retryDelaysMs: [3_000, 10_000, 30_000, 60_000],
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

  const retry = recovery.tick(23_000);
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
  const retry = recovery.tick(4_100);
  assert.equal(retry.action.startAt, 42);
});

test("a retry that hits EOF without progress is the real end", () => {
  const recovery = started("vod");
  recovery.progress(2_400, 7_200, 1_000);
  recovery.bufferingChanged(true);
  const waiting = recovery.endOfStream(2_100);
  assert.equal(waiting.snapshot.phase, "waiting");
  const retry = tickThrough(recovery, 2_200, 6_000);
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
  const retry = tickThrough(recovery, 31, 3_100);
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

  const retry = tickUntil(recovery, 11_000, 13_100);
  assert.equal(retry.action.type, "retry");

  const second = recovery.loadFailed("http 403", retry.now + 100);
  assert.equal(second.snapshot.phase, "failed");
  assert.equal(second.snapshot.message, PLAYBACK_FAILED_MESSAGE);
  assert.equal(second.action.type, "give-up");
});

test("the final message says whether the stream ever opened", () => {
  const refused = new PlaybackRecovery(OPTIONS);
  refused.begin("live", 0);
  refused.loadFailed("http 403", 10);
  const retry = tickThrough(refused, 11, 13_100);
  assert.equal(retry.action.type, "retry");
  refused.loadFailed("http 403", retry.now + 100);
  assert.equal(refused.snapshot().phase, "failed");
  assert.equal(refused.snapshot().message, PLAYBACK_FAILED_MESSAGE);

  const dropped = new PlaybackRecovery(OPTIONS);
  dropped.begin("live", 0);
  dropped.firstFrame(10);
  let now = 20;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    dropped.loadFailed("reset", now);
    const retry = tickThrough(dropped, now + 1, now + 61_000);
    assert.equal(retry.action.type, "retry");
    now = retry.now;
    dropped.firstFrame(now + 10);
  }
  dropped.loadFailed("reset", now + 20);
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
    const retry = tickThrough(recovery, now + 1, now + 61_000);
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
    const retry = tickUntil(recovery, now + 1, now + 61_000);
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
  const retry = tickThrough(recovery, 121_000, 123_100);
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

test("a VOD retry starts where the viewer is", () => {
  const early = started("vod");
  early.progress(4, 600, 2_000);
  early.loadFailed("reset", 3_000);
  assert.equal(early.tick(6_100).action.startAt, null);

  const late = started("vod");
  late.progress(590, 600, 2_000);
  late.loadFailed("reset", 3_000);
  assert.equal(late.tick(6_100).action.startAt, 590);

  const unknown = started("vod");
  unknown.progress(42, null, 2_000);
  unknown.loadFailed("reset", 3_000);
  assert.equal(unknown.tick(6_100).action.startAt, 42);
});

test("rewinding a movie is not a failure, and the retry stays where the viewer is", () => {
  const recovery = started("vod");
  recovery.progress(600, 7_200, 1_000);
  // Two presses of -30 s, exactly 60 seconds back.
  recovery.seek(3_000);
  recovery.progress(570, 7_200, 3_100);
  recovery.seek(3_400);
  recovery.progress(540, 7_200, 3_500);
  // The picture keeps moving, but never past the old maximum.
  let now = 4_000;
  for (let offset = 1; offset <= 40; offset += 1) {
    recovery.progress(540 + offset, 7_200, now);
    const result = recovery.tick(now);
    assert.equal(result.action.type, "none", `triggered at ${now}`);
    now += 1_000;
  }
  // A real stall still fires from the new baseline, and the retry continues
  // where the viewer is, not where the playback used to be.
  recovery.bufferingChanged(true);
  const stalled = tickUntil(recovery, now, now + 20_000);
  assert.equal(stalled.action.type, "retry");
  assert.equal(stalled.action.startAt, 580);
});

test("a backward timestamp jump on a healthy live stream is not a stall", () => {
  const recovery = started("live");
  recovery.progress(29, null, 1_000);
  // Measured on the pinned DLL: a provider clock restart steps from 29 to 0.
  recovery.progress(0, null, 2_000);
  for (let now = 3_000; now <= 60_000; now += 1_000) {
    recovery.progress((now - 2_000) / 1_000, null, now);
    assert.equal(recovery.tick(now).action.type, "none", `triggered at ${now}`);
  }
});

test("an EOF after a rewind is a drop, not the end of the title", () => {
  const recovery = started("vod");
  recovery.progress(7_190, 7_200, 1_000);
  recovery.seek(2_000);
  recovery.progress(120, 7_200, 2_100);
  const result = recovery.endOfStream(2_200);
  assert.equal(result.snapshot.phase, "waiting");
  assert.equal(recovery.tick(5_300).action.startAt, 120);
});

test("a live retry never carries a start position", () => {
  const recovery = started("live");
  recovery.progress(42, 600, 2_000);
  recovery.loadFailed("reset", 3_000);
  assert.equal(recovery.tick(6_100).action.startAt, null);
});

test("a stale playback-restart never cancels a pending retry", () => {
  // Measured on the pinned player: seeking to the end of a file emits both
  // `eof-reached` and `playback-restart`, and the restart arrived after the
  // retry was decided, freezing the movie on "Playing".
  const live = started("live");
  live.endOfStream(5_000);
  assert.equal(live.snapshot().phase, "waiting");
  live.firstFrame(5_050);
  assert.equal(live.snapshot().phase, "waiting");
  assert.equal(live.tick(8_100).action.type, "retry");

  const vod = new PlaybackRecovery(OPTIONS);
  vod.begin("vod", 0, 120);
  vod.firstFrame(100);
  vod.progress(82, 84, 80_000);
  vod.endOfStream(80_100);
  assert.equal(vod.snapshot().phase, "waiting");
  vod.firstFrame(80_150);
  assert.equal(vod.snapshot().phase, "waiting");
  const retry = vod.tick(83_200);
  assert.equal(retry.action.type, "retry");
  assert.equal(retry.action.startAt, 82);
});

test("a duplicate end or failure while waiting does not spend another attempt", () => {
  const recovery = started("live");
  recovery.loadFailed("reset", 2_000);
  assert.equal(recovery.snapshot().attempt, 2);
  recovery.loadFailed("reset", 2_100);
  recovery.endOfStream(2_200);
  assert.equal(recovery.snapshot().attempt, 2);
  assert.equal(recovery.snapshot().phase, "waiting");
});

test("the snapshot carries the retry deadline only while waiting", () => {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin("live", 0);
  assert.equal(recovery.snapshot().retryAt, null);

  const failed = recovery.loadFailed("reset", 1_000);
  assert.equal(failed.snapshot.retryAt, 4_000);

  recovery.tick(4_000);
  assert.equal(recovery.snapshot().phase, "loading");
  assert.equal(recovery.snapshot().retryAt, null);
});

test("Retry now skips the wait without spending an attempt", () => {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin("live", 0);
  const failed = recovery.loadFailed("reset", 1_000);
  assert.equal(failed.snapshot.attempt, 2);
  assert.equal(failed.snapshot.retryAt, 4_000);

  const skipped = recovery.retryNow(2_000);
  assert.equal(skipped.action.type, "none");
  assert.equal(skipped.snapshot.attempt, 2);
  assert.equal(skipped.snapshot.retryAt, 2_000);

  const started = recovery.tick(2_000);
  assert.equal(started.action.type, "retry");
  assert.equal(started.action.attempt, 2);

  // The attempt is in flight: no second connection and no second retry.
  assert.equal(recovery.retryNow(2_001).action.type, "none");
  assert.equal(recovery.tick(2_001).action.type, "none");
});

test("the full ladder waits 3, 10, 30 and 60 seconds before giving up", () => {
  const recovery = new PlaybackRecovery(OPTIONS);
  recovery.begin("live", 0);
  recovery.firstFrame(10);

  let failed = recovery.loadFailed("reset", 1_000);
  assert.equal(failed.snapshot.retryAt, 4_000);
  let retry = recovery.tick(4_000);
  assert.equal(retry.action.attempt, 2);

  failed = recovery.loadFailed("reset", 5_000);
  assert.equal(failed.snapshot.retryAt, 15_000);
  retry = recovery.tick(15_000);
  assert.equal(retry.action.attempt, 3);

  failed = recovery.loadFailed("reset", 16_000);
  assert.equal(failed.snapshot.retryAt, 46_000);
  retry = recovery.tick(46_000);
  assert.equal(retry.action.attempt, 4);

  failed = recovery.loadFailed("reset", 47_000);
  assert.equal(failed.snapshot.retryAt, 107_000);
  retry = recovery.tick(107_000);
  assert.equal(retry.action.attempt, 5);

  const last = recovery.loadFailed("reset", 108_000);
  assert.equal(last.action.type, "give-up");
  assert.equal(last.snapshot.phase, "failed");
  assert.equal(last.snapshot.retryAt, null);
});
