export type PlaybackKind = "live" | "vod";

export type RecoveryPhase = "idle" | "loading" | "playing" | "waiting" | "failed";

export interface RecoverySnapshot {
  phase: RecoveryPhase;
  attempt: number;
  maxAttempts: number;
  message: string | null;
  lastError: string | null;
  /** `performance.now()` deadline of the wait; null outside the waiting phase. */
  retryAt: number | null;
}

export interface RecoveryAction {
  type: "none" | "retry" | "give-up";
  attempt: number;
  delayMs: number;
  startAt: number | null;
}

export interface RecoveryResult {
  snapshot: RecoverySnapshot;
  action: RecoveryAction;
}

export interface RecoveryOptions {
  maxAttempts: number;
  refusalAttempts: number;
  firstFrameTimeoutMs: number;
  stallTimeoutMs: number;
  progressTimeoutMs: number;
  seekSuppressionMs: number;
  /**
   * A timestamp step backwards at least this large is a discontinuity (a
   * provider restarting its clock) or a seek the player did not announce. It
   * moves the progress baseline instead of counting as a stall. Smaller steps
   * are the usual HLS rebuild, which must never look like progress.
   */
  backwardJumpSeconds: number;
  sustainedPlaybackMs: number;
  minimumResumeSeconds: number;
  minimumResumeFraction: number;
  retryDelaysMs: readonly number[];
}

export const DEFAULT_RECOVERY_OPTIONS: RecoveryOptions = {
  maxAttempts: 5,
  refusalAttempts: 2,
  firstFrameTimeoutMs: 20_000,
  stallTimeoutMs: 15_000,
  progressTimeoutMs: 30_000,
  seekSuppressionMs: 3_000,
  backwardJumpSeconds: 10,
  sustainedPlaybackMs: 60_000,
  minimumResumeSeconds: 10,
  minimumResumeFraction: 0.05,
  retryDelaysMs: [3_000, 10_000, 30_000, 60_000],
};

const IDLE_SNAPSHOT: RecoverySnapshot = {
  phase: "idle",
  attempt: 0,
  maxAttempts: 0,
  message: null,
  lastError: null,
  retryAt: null,
};

function noAction(): RecoveryAction {
  return { type: "none", attempt: 0, delayMs: 0, startAt: null };
}

export const PLAYBACK_FAILED_MESSAGE = "The stream could not be opened. Reload to try again.";
export const PLAYBACK_LOST_MESSAGE = "The stream stopped and could not be reconnected. Reload to try again.";

export interface ResumeOptions {
  minimumResumeSeconds: number;
  minimumResumeFraction: number;
}

/** The one place that decides whether a VOD position is worth resuming. */
export function resumeStartPosition(
  kind: PlaybackKind,
  position: number | null,
  duration: number | null,
  options: ResumeOptions = DEFAULT_RECOVERY_OPTIONS,
): number | null {
  if (kind !== "vod") return null;
  if (position === null || !Number.isFinite(position)) return null;
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return null;
  if (position < options.minimumResumeSeconds) return null;
  if (position >= duration * (1 - options.minimumResumeFraction)) return null;
  return Math.floor(position);
}

/**
 * Decides when a playback attempt has failed and how to retry it.
 *
 * Time is always passed in by the caller, so tests drive a fake clock and the
 * hook owns the only real timer. Nothing here imports mpv or React.
 */
export class PlaybackRecovery {
  private readonly options: RecoveryOptions;

  private kind: PlaybackKind = "live";
  private phase: RecoveryPhase = "idle";
  private attempt = 0;
  private maxAttempts = 0;

  private startedAt = 0;
  private firstFrameAt: number | null = null;
  private lastProgressAt = 0;

  private lastPosition: number | null = null;
  /** The position that last counted as progress; null means "adopt the next". */
  private baseline: number | null = null;
  private longestDuration: number | null = null;

  private buffering = false;
  private paused = false;
  private seekUntil = 0;
  private retryAt = 0;
  private lastError: string | null = null;
  private reachedFirstFrame = false;
  private lastRetryStartAt: number | null = null;
  private progressSinceRetry = false;
  private deferredRetries = 0;

  constructor(options: Partial<RecoveryOptions> = {}) {
    this.options = { ...DEFAULT_RECOVERY_OPTIONS, ...options };
  }

  begin(kind: PlaybackKind, at: number, durationHint: number | null = null): RecoveryResult {
    this.kind = kind;
    this.phase = "loading";
    this.attempt = 1;
    this.maxAttempts = this.options.maxAttempts;
    this.startedAt = at;
    this.firstFrameAt = null;
    this.lastProgressAt = at;
    this.lastPosition = null;
    this.baseline = null;
    this.longestDuration =
      typeof durationHint === "number" && Number.isFinite(durationHint) && durationHint > 0
        ? durationHint
        : null;
    this.buffering = false;
    this.paused = false;
    this.seekUntil = 0;
    this.retryAt = 0;
    this.lastError = null;
    this.reachedFirstFrame = false;
    this.lastRetryStartAt = null;
    this.progressSinceRetry = false;
    this.deferredRetries = 0;
    return this.result(noAction());
  }

  /**
   * Metadata is parsed. This is explicitly not a first frame.
   */
  loaded(at: number): RecoveryResult {
    if (this.phase === "loading" && this.firstFrameAt === null) {
      this.lastProgressAt = Math.max(this.lastProgressAt, at);
    }
    return this.result(noAction());
  }

  firstFrame(at: number): RecoveryResult {
    // Only a load in flight can produce a first frame. mpv also emits
    // playback-restart when it seeks to the end of a file, and that event must
    // never cancel a retry that is already decided (measured: it froze a
    // truncated movie on "Playing" with the ladder dead).
    if (this.phase !== "loading") return this.result(noAction());
    this.phase = "playing";
    this.firstFrameAt = at;
    this.lastProgressAt = at;
    this.reachedFirstFrame = true;
    // Wherever the viewer is now is the baseline for progress, not a stale
    // value from before a retry or a seek.
    this.baseline = null;
    return this.result(noAction());
  }

  progress(position: number | null, duration: number | null, at: number): RecoveryResult {
    if (this.phase === "idle") return this.result(noAction());
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
      // A truncated read reports a shorter duration; never trust a shrink.
      this.longestDuration = this.longestDuration === null
        ? duration
        : Math.max(this.longestDuration, duration);
    }
    if (typeof position === "number" && Number.isFinite(position)) {
      this.lastPosition = position;
      if (this.phase === "playing") this.observePosition(position, at);
      if (
        this.lastRetryStartAt !== null &&
        this.lastPosition > this.lastRetryStartAt + 1
      ) {
        this.progressSinceRetry = true;
      }
    }
    return this.result(noAction());
  }

  /**
   * Only a picture that really moves counts. A step forward (or a step far
   * enough back to be a discontinuity) moves the baseline; a small step back
   * is the HLS rebuild of the last segments and is not progress.
   */
  private observePosition(position: number, at: number): void {
    const baseline = this.baseline;
    if (baseline === null) {
      this.baseline = position;
      this.lastProgressAt = at;
      return;
    }
    if (position > baseline + 0.5) {
      this.baseline = position;
      this.lastProgressAt = at;
      return;
    }
    if (position < baseline - this.options.backwardJumpSeconds) {
      this.baseline = position;
      this.lastProgressAt = at;
    }
  }

  bufferingChanged(active: boolean): RecoveryResult {
    this.buffering = active;
    return this.result(noAction());
  }

  pausedChanged(active: boolean, at: number): RecoveryResult {
    this.paused = active;
    if (!active) this.lastProgressAt = at;
    return this.result(noAction());
  }

  seek(at: number): RecoveryResult {
    this.seekUntil = at + this.options.seekSuppressionMs;
    this.lastProgressAt = at;
    // The viewer chose a new position; the next reported one is the baseline,
    // whether they scrubbed forward or rewound an hour.
    this.baseline = null;
    return this.result(noAction());
  }

  /** A clean stream end. A live stream is recoverable; for VOD it depends. */
  endOfStream(at: number): RecoveryResult {
    if (this.phase === "idle" || this.phase === "waiting" || this.phase === "failed") {
      return this.result(noAction());
    }
    if (this.kind === "vod") {
      const end = this.longestDuration;
      // Where the viewer actually is, not the furthest point they ever reached:
      // an EOF after a rewind is a drop, not the end of the title.
      const position = this.lastPosition ?? this.baseline ?? 0;
      const nearEnd = end !== null && end > 0 && position >= end - 2;
      // A retry that hits EOF again without advancing means the title really
      // ends there, so a truncated file cannot loop.
      const stuckAfterRetry = this.lastRetryStartAt !== null && !this.progressSinceRetry;
      if (nearEnd || stuckAfterRetry) {
        this.phase = "idle";
        this.lastError = null;
        return this.result(noAction());
      }
      return this.fail("The stream ended early.", at, false);
    }
    return this.fail("The stream ended.", at, false);
  }

  /** mpv reported an error before the first frame. */
  loadFailed(error: string, at: number): RecoveryResult {
    // A retry is already scheduled; a duplicate failure from the old stream
    // must not spend a second attempt.
    if (this.phase === "idle" || this.phase === "waiting" || this.phase === "failed") {
      return this.result(noAction());
    }
    // The refusal cap is about the media, not the attempt: a stream that
    // already played in this ladder is a drop, even if the retry fails fast.
    const refusal = !this.reachedFirstFrame;
    return this.fail(error, at, refusal);
  }

  /**
   * Skip the current wait and make the next attempt due immediately. It does
   * not spend an extra attempt and does nothing while an attempt is loading.
   */
  retryNow(at: number): RecoveryResult {
    if (this.phase !== "waiting") return this.result(noAction());
    this.retryAt = at;
    return this.result(noAction());
  }

  cancel(): RecoveryResult {
    this.phase = "idle";
    this.attempt = 0;
    this.maxAttempts = 0;
    this.firstFrameAt = null;
    this.lastError = null;
    this.retryAt = 0;
    this.buffering = false;
    this.paused = false;
    this.seekUntil = 0;
    this.lastRetryStartAt = null;
    this.progressSinceRetry = false;
    return this.result(noAction());
  }

  /**
   * Retry without spending an attempt. Used when the video surface is not
   * usable yet (minimized window), which is not a stream failure.
   */
  defer(at: number, delayMs = 3_000): RecoveryResult {
    if (this.phase !== "loading" && this.phase !== "playing") return this.result(noAction());
    this.deferredRetries += 1;
    if (this.deferredRetries > 20) {
      return this.fail("The player window is not ready.", at, false);
    }
    this.phase = "waiting";
    this.retryAt = at + delayMs;
    this.buffering = false;
    return this.result(noAction());
  }

  snapshot(): RecoverySnapshot {
    if (this.phase === "idle") return IDLE_SNAPSHOT;
    if (this.phase === "failed") {
      return {
        phase: "failed",
        attempt: this.attempt,
        maxAttempts: this.maxAttempts,
        message: this.reachedFirstFrame ? PLAYBACK_LOST_MESSAGE : PLAYBACK_FAILED_MESSAGE,
        lastError: this.lastError,
        retryAt: null,
      };
    }
    if (this.phase === "waiting") {
      return {
        phase: "waiting",
        attempt: this.attempt,
        maxAttempts: this.maxAttempts,
        message: `Retrying (${this.attempt} of ${this.maxAttempts})…`,
        lastError: this.lastError,
        retryAt: this.retryAt,
      };
    }
    return {
      phase: this.phase,
      attempt: this.attempt,
      maxAttempts: this.maxAttempts,
      message: null,
      lastError: this.lastError,
      retryAt: null,
    };
  }

  tick(at: number): RecoveryResult {
    if (this.phase === "idle") return this.result(noAction());


    if (this.phase === "waiting") {
      if (at < this.retryAt) return this.result(noAction());
      this.phase = "loading";
      this.startedAt = at;
      this.firstFrameAt = null;
      this.lastProgressAt = at;
      this.buffering = false;
      this.seekUntil = 0;
      const startAt = this.retryStartAt();
      this.lastRetryStartAt = startAt;
      this.progressSinceRetry = false;
      this.lastPosition = startAt;
      this.baseline = null;
      return this.result({
        type: "retry",
        attempt: this.attempt,
        delayMs: 0,
        startAt,
      });
    }

    if (this.phase === "loading") {
      if (at - this.startedAt >= this.options.firstFrameTimeoutMs) {
        return this.fail("The stream did not start in time.", at, false);
      }
      return this.result(noAction());
    }

    if (this.phase === "playing") {
      if (this.paused) {
        this.lastProgressAt = at;
        return this.result(noAction());
      }
      if (at < this.seekUntil) {
        this.lastProgressAt = at;
        return this.result(noAction());
      }
      if (
        this.firstFrameAt !== null &&
        this.attempt > 1 &&
        at - this.firstFrameAt >= this.options.sustainedPlaybackMs
      ) {
        this.attempt = 1;
        this.maxAttempts = this.options.maxAttempts;
      }
      const stalledFor = at - this.lastProgressAt;
      const threshold = this.buffering
        ? this.options.stallTimeoutMs
        : this.options.progressTimeoutMs;
      if (stalledFor >= threshold) {
        return this.fail("The stream stopped responding.", at, false);
      }
    }

    return this.result(noAction());
  }

  private fail(error: string, at: number, refusal: boolean): RecoveryResult {
    this.lastError = error;
    if (refusal) {
      this.maxAttempts = Math.min(this.maxAttempts, this.options.refusalAttempts);
    }
    if (this.attempt >= this.maxAttempts) {
      this.phase = "failed";
      return this.result({
        type: "give-up",
        attempt: this.attempt,
        delayMs: 0,
        startAt: null,
      });
    }
    this.attempt += 1;
    const delayIndex = Math.min(this.attempt - 2, this.options.retryDelaysMs.length - 1);
    const delayMs = this.options.retryDelaysMs[Math.max(0, delayIndex)];
    this.retryAt = at + delayMs;
    this.phase = "waiting";
    this.buffering = false;
    return this.result(noAction());
  }

  private retryStartAt(): number | null {
    // A retry continues where the viewer is. Unlike Reload, it must not fall
    // back to zero near the end: the title is not finished, the stream failed.
    // It also must resume without a duration, or a real end would replay from
    // the start for as long as the app stays open.
    if (this.kind !== "vod") return null;
    const position = this.lastPosition;
    if (position === null || !Number.isFinite(position)) return null;
    if (position < this.options.minimumResumeSeconds) return null;
    return Math.floor(position);
  }

  private result(action: RecoveryAction): RecoveryResult {
    return { snapshot: this.snapshot(), action };
  }
}
