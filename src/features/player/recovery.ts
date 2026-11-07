export type PlaybackKind = "live" | "vod";

export type RecoveryPhase = "idle" | "loading" | "playing" | "waiting" | "failed";

export interface RecoverySnapshot {
  phase: RecoveryPhase;
  attempt: number;
  maxAttempts: number;
  message: string | null;
  lastError: string | null;
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
  sustainedPlaybackMs: 60_000,
  minimumResumeSeconds: 10,
  minimumResumeFraction: 0.05,
  retryDelaysMs: [1_000, 2_000, 4_000, 8_000],
};

const IDLE_SNAPSHOT: RecoverySnapshot = {
  phase: "idle",
  attempt: 0,
  maxAttempts: 0,
  message: null,
  lastError: null,
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
  private maxPosition: number | null = null;
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
    this.maxPosition = null;
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

  /** Metadata is parsed. This is explicitly not a first frame. */
  loaded(at: number): RecoveryResult {
    if (this.phase === "loading" && this.firstFrameAt === null) {
      this.lastProgressAt = Math.max(this.lastProgressAt, at);
    }
    return this.result(noAction());
  }

  firstFrame(at: number): RecoveryResult {
    if (this.phase === "idle") return this.result(noAction());
    // mpv emits playback-restart again on every HLS reload; the attempt clock
    // and the progress clock must be set once, at the real first frame.
    if (this.phase === "playing" && this.firstFrameAt !== null) {
      return this.result(noAction());
    }
    this.phase = "playing";
    this.firstFrameAt = at;
    this.lastProgressAt = at;
    this.reachedFirstFrame = true;
    if (this.maxPosition === null && this.lastPosition !== null) {
      this.maxPosition = this.lastPosition;
    }
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
      if (this.maxPosition === null) {
        this.maxPosition = position;
        if (this.phase === "playing") this.lastProgressAt = at;
      } else if (position > this.maxPosition + 0.5) {
        this.maxPosition = position;
        if (this.phase === "playing") this.lastProgressAt = at;
      }
      if (
        this.lastRetryStartAt !== null &&
        this.maxPosition !== null &&
        this.maxPosition > this.lastRetryStartAt + 1
      ) {
        this.progressSinceRetry = true;
      }
    }
    return this.result(noAction());
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
    return this.result(noAction());
  }

  /** A clean stream end. A live stream is recoverable; for VOD it depends. */
  endOfStream(at: number): RecoveryResult {
    if (this.phase === "idle") return this.result(noAction());
    if (this.kind === "vod") {
      const end = this.longestDuration;
      const position = this.maxPosition ?? this.lastPosition ?? 0;
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
    if (this.phase === "idle") return this.result(noAction());
    // The refusal cap is about the media, not the attempt: a stream that
    // already played in this ladder is a drop, even if the retry fails fast.
    const refusal = !this.reachedFirstFrame;
    return this.fail(error, at, refusal);
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
      };
    }
    if (this.phase === "waiting") {
      return {
        phase: "waiting",
        attempt: this.attempt,
        maxAttempts: this.maxAttempts,
        message: `Retrying (${this.attempt} of ${this.maxAttempts})…`,
        lastError: this.lastError,
      };
    }
    return {
      phase: this.phase,
      attempt: this.attempt,
      maxAttempts: this.maxAttempts,
      message: null,
      lastError: this.lastError,
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
      this.maxPosition = startAt;
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
    return resumeStartPosition(
      this.kind,
      this.maxPosition ?? this.lastPosition,
      this.longestDuration,
      this.options,
    );
  }

  private result(action: RecoveryAction): RecoveryResult {
    return { snapshot: this.snapshot(), action };
  }
}
