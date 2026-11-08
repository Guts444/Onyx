import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  command,
  destroy,
  init,
  listenEvents,
  observeProperties,
  setProperty,
  setVideoMarginRatio,
  type MpvObservableProperty,
} from "tauri-plugin-libmpv-api";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Channel } from "../../domain/iptv";
import { getErrorMessage } from "../errors/messages";
import { redactCredentials } from "../playlist/redaction";
import { calculateVideoMarginRatio, createLayoutSync, LAYOUT_TRAILING_SYNC_MS } from "./layout";
import { clampSeekPosition, parseSubtitleTracks, type SubtitleTrack } from "./media";
import { LatestPlaybackOperationCoordinator } from "./operations";
import {
  PLAYBACK_FAILED_MESSAGE,
  PlaybackRecovery,
  resumeStartPosition,
  type RecoveryResult,
  type RecoverySnapshot,
} from "./recovery";

export const DEFAULT_PLAYER_VOLUME = 72;
const RECOVERY_TICK_MS = 1_000;
const END_FILE_GRACE_MS = 750;
const OBSERVED_PROPERTIES = [
  ["volume", "double"],
  ["mute", "flag"],
  ["width", "int64", "none"],
  ["height", "int64", "none"],
  ["estimated-vf-fps", "double", "none"],
  ["container-fps", "double", "none"],
  ["paused-for-cache", "flag"],
  ["idle-active", "flag"],
  ["eof-reached", "flag"],
  ["duration", "double", "none"],
  ["time-pos", "double", "none"],
  ["pause", "flag"],
  ["track-list", "node"],
] as const satisfies ReadonlyArray<MpvObservableProperty>;

export interface MpvPlayerState {
  environment: "tauri" | "browser";
  ready: boolean;
  idleActive: boolean;
  loading: boolean;
  buffering: boolean;
  muted: boolean;
  volume: number;
  status: string;
  error: string | null;
  initError: string | null;
  videoWidth: number | null;
  videoHeight: number | null;
  videoFps: number | null;
  playbackMode: "live" | "vod" | null;
  paused: boolean;
  duration: number | null;
  /**
   * The longest duration seen for the current title, including the catalog
   * hint. A truncated or re-estimated duration never shrinks this, so it is
   * the value saved positions and the end rule must use.
   */
  longestDuration: number | null;
  position: number | null;
  subtitleTracks: SubtitleTrack[];
  recovery: RecoverySnapshot;
}

export interface MpvPlayableMedia {
  id: string;
  kind: "live" | "vod";
  name: string;
  stream: string | null;
  isPlayable: boolean;
  playabilityError?: string | null;
  durationHint?: number | null;
}

type PlayerLayoutMode = "windowed" | "fullscreen";

function sanitizeLogMessage(message: string) {
  return redactCredentials(message)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function clampVolume(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeVideoDimension(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value);
}

function normalizeVideoFps(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
}

function normalizeDurationHint(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function getMarginRatio(surface: HTMLElement) {
  const rect = surface.getBoundingClientRect();
  const root = document.documentElement;
  return calculateVideoMarginRatio(rect, {
    width: Math.max(window.innerWidth || 0, root.clientWidth || 0),
    height: Math.max(window.innerHeight || 0, root.clientHeight || 0),
  });
}

function describeInitError(error: unknown) {
  const message = getErrorMessage(error, "Unknown initialization error.");

  return `libmpv could not start. Review the mpv dependency setup, then place libmpv-wrapper.dll and libmpv-2.dll in src-tauri/lib/. Original error: ${message}`;
}

function describeCommandError(error: unknown) {
  return getErrorMessage(error, "The player command failed.");
}

export function useMpvPlayer(
  surfaceRef: RefObject<HTMLElement | null>,
  layoutMode: PlayerLayoutMode = "windowed",
  initialVolume = DEFAULT_PLAYER_VOLUME,
) {
  const isNativeHost = isTauri();
  const initializedRef = useRef(false);
  const initialVolumeRef = useRef(clampVolume(initialVolume));
  const currentMediaRef = useRef<MpvPlayableMedia | null>(null);
  const userStoppedPlaybackRef = useRef(false);
  const lastErrorLogRef = useRef<string | null>(null);
  const playbackOperationsRef = useRef(new LatestPlaybackOperationCoordinator());
  const recoveryRef = useRef(new PlaybackRecovery());
  const recoverySnapshotRef = useRef<RecoverySnapshot>(recoveryRef.current.snapshot());
  const readyRef = useRef(false);
  const expectedStopRef = useRef(false);
  const ourLoadRef = useRef(false);
  const internalReloadRef = useRef(false);
  const longestDurationRef = useRef<number | null>(null);
  const lastStartFileAtRef = useRef(0);
  const endFileGraceRef = useRef<number | null>(null);
  const retryInFlightRef = useRef(false);
  const lastPositionRef = useRef<number | null>(null);
  const [state, setState] = useState<MpvPlayerState>({
    environment: isNativeHost ? "tauri" : "browser",
    ready: false,
    idleActive: true,
    loading: false,
    buffering: false,
    muted: false,
    volume: initialVolumeRef.current,
    status: isNativeHost
      ? "Starting native player..."
      : "Browser preview detected. Open the app with `npm run tauri dev` for native playback.",
    error: null,
    initError: null,
    videoWidth: null,
    videoHeight: null,
    videoFps: null,
    playbackMode: null,
    paused: false,
    duration: null,
    longestDuration: null,
    position: null,
    subtitleTracks: [],
    recovery: recoveryRef.current.snapshot(),
  });

  async function applyVideoLayout() {
    const surface = surfaceRef.current;
    if (!surface) return false;
    const margin = getMarginRatio(surface);
    if (!margin) return false;
    await setVideoMarginRatio(margin);
    return true;
  }

  async function prepareVideoLayout() {
    const retryDelays = [0, 16, 50, 120];
    for (const delay of retryDelays) {
      if (delay > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      }
      if (await applyVideoLayout()) return true;
    }
    return false;
  }

  function clearEndFileGrace() {
    if (endFileGraceRef.current !== null) {
      window.clearTimeout(endFileGraceRef.current);
      endFileGraceRef.current = null;
    }
  }

  function applyRecovery(result: RecoveryResult) {
    const previous = recoverySnapshotRef.current;
    const next = result.snapshot;
    const changed =
      previous.phase !== next.phase ||
      previous.attempt !== next.attempt ||
      previous.maxAttempts !== next.maxAttempts ||
      previous.message !== next.message ||
      previous.lastError !== next.lastError;

    if (changed) {
      recoverySnapshotRef.current = next;
      setState((currentState) => {
        if (next.phase === "waiting") {
          return {
            ...currentState,
            recovery: next,
            loading: true,
            buffering: false,
            status: next.message ?? "Retrying…",
          };
        }
        if (next.phase === "failed") {
          return {
            ...currentState,
            recovery: next,
            loading: false,
            buffering: false,
            idleActive: true,
            status: "Playback error",
            error: next.message ?? PLAYBACK_FAILED_MESSAGE,
          };
        }
        return { ...currentState, recovery: next };
      });
    }

    if (result.action.type === "retry") {
      void retryCurrentMedia(result.action.startAt);
    }

    if (result.action.type === "give-up") {
      // Holding a dead connection can block a one-connection account. Release
      // it, but do not report a user stop; the error above is the outcome.
      void command("stop").catch(() => undefined);
    }
  }

  async function retryCurrentMedia(startAt: number | null) {
    const media = currentMediaRef.current;
    if (!media || retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    try {
      await loadMedia(media, () => true, { startAt, isRetry: true });
    } finally {
      retryInFlightRef.current = false;
    }
  }

  /** mpv emits end-file during its own HLS reload; only a quiet one is a failure. */
  function scheduleEndFileCheck(reason: string, code: number) {
    clearEndFileGrace();
    const startFileRevision = lastStartFileAtRef.current;
    endFileGraceRef.current = window.setTimeout(() => {
      endFileGraceRef.current = null;
      if (userStoppedPlaybackRef.current) return;
      if (lastStartFileAtRef.current !== startFileRevision) return;
      const phase = recoverySnapshotRef.current.phase;
      if (phase === "idle" || phase === "failed" || phase === "waiting") return;
      applyRecovery(recoveryRef.current.loadFailed(`mpv reported ${reason} (${code})`, performance.now()));
    }, END_FILE_GRACE_MS);
  }

  useEffect(() => {
    if (!isNativeHost) {
      return undefined;
    }

    let unlistenProperties: UnlistenFn | null = null;
    let unlistenEvents: UnlistenFn | null = null;
    let cancelled = false;

    async function startPlayer() {
      try {
        await init({
          initialOptions: {
            vo: "gpu-next",
            hwdec: "auto-safe",
            "keep-open": "yes",
            "force-window": "yes",
            idle: "yes",
            osc: "no",
          },
          observedProperties: OBSERVED_PROPERTIES,
        });

        initializedRef.current = true;

        unlistenProperties = await observeProperties(OBSERVED_PROPERTIES, (event) => {
          if (cancelled) {
            return;
          }

          switch (event.name) {
            case "volume":
              if (typeof event.data === "number") {
                setState((currentState) => ({
                  ...currentState,
                  volume: clampVolume(event.data),
                }));
              }
              break;
            case "mute":
              if (typeof event.data === "boolean") {
                setState((currentState) => ({
                  ...currentState,
                  muted: event.data,
                }));
              }
              break;
            case "width":
              setState((currentState) => ({
                ...currentState,
                videoWidth: normalizeVideoDimension(event.data),
              }));
              break;
            case "height":
              setState((currentState) => ({
                ...currentState,
                videoHeight: normalizeVideoDimension(event.data),
              }));
              break;
            case "estimated-vf-fps":
            case "container-fps": {
              const videoFps = normalizeVideoFps(event.data);

              if (videoFps !== null) {
                setState((currentState) => ({
                  ...currentState,
                  videoFps,
                }));
              }
              break;
            }
            case "paused-for-cache":
              if (typeof event.data === "boolean") {
                applyRecovery(recoveryRef.current.bufferingChanged(event.data));
                setState((currentState) => ({
                  ...currentState,
                  buffering: event.data,
                  status: event.data
                    ? "Buffering..."
                    : currentState.error
                    ? currentState.status
                    : currentMediaRef.current?.kind === "vod"
                    ? "Playing"
                    : "Playing live stream",
                }));
              }
              break;
            case "idle-active":
              if (typeof event.data === "boolean" && !expectedStopRef.current) {
                setState((currentState) => ({
                  ...currentState,
                  idleActive: event.data,
                  status:
                    event.data && !userStoppedPlaybackRef.current && currentMediaRef.current
                      ? currentState.error
                        ? "Playback error"
                        : "Waiting for the stream..."
                      : currentState.status,
                }));
              }
              break;
            case "duration": {
              const duration = normalizeVideoFps(event.data);
              if (duration !== null) {
                longestDurationRef.current = longestDurationRef.current === null
                  ? duration
                  : Math.max(longestDurationRef.current, duration);
              }
              applyRecovery(recoveryRef.current.progress(null, duration, performance.now()));
              setState((currentState) => ({
                ...currentState,
                duration,
                longestDuration:
                  duration === null
                    ? currentState.longestDuration
                    : Math.max(currentState.longestDuration ?? 0, duration),
              }));
              break;
            }
            case "time-pos": {
              const position = typeof event.data === "number" && Number.isFinite(event.data)
                ? Math.max(0, event.data)
                : null;
              lastPositionRef.current = position;
              applyRecovery(recoveryRef.current.progress(position, null, performance.now()));
              setState((currentState) => ({ ...currentState, position }));
              break;
            }
            case "eof-reached":
              if (event.data === true && !userStoppedPlaybackRef.current && !expectedStopRef.current) {
                const media = currentMediaRef.current;
                if (!media) break;
                const result = recoveryRef.current.endOfStream(performance.now());
                applyRecovery(result);
                if (media.kind === "vod" && result.snapshot.phase === "idle") {
                  setState((currentState) => ({
                    ...currentState,
                    status: "Playback complete",
                    error: null,
                    loading: false,
                    buffering: false,
                    idleActive: true,
                  }));
                }
              }
              break;
            case "pause":
              if (typeof event.data === "boolean") {
                applyRecovery(recoveryRef.current.pausedChanged(event.data, performance.now()));
                setState((currentState) => ({ ...currentState, paused: event.data }));
              }
              break;
            case "track-list":
              setState((currentState) => ({
                ...currentState,
                subtitleTracks: parseSubtitleTracks(event.data),
              }));
              break;
            default:
              break;
          }
        });

        unlistenEvents = await listenEvents((event) => {
          if (cancelled) {
            return;
          }

          switch (event.event) {
            case "start-file":
              lastStartFileAtRef.current += 1;
              clearEndFileGrace();
              if (!ourLoadRef.current) {
                // mpv reloading an HLS playlist by itself: no UI churn.
                internalReloadRef.current = true;
                break;
              }
              ourLoadRef.current = false;
              internalReloadRef.current = false;
              setState((currentState) => ({
                ...currentState,
                loading: true,
                idleActive: false,
                buffering: false,
                error: null,
                status: "Opening stream...",
                videoWidth: null,
                videoHeight: null,
                videoFps: null,
              }));
              break;
            case "file-loaded":
              expectedStopRef.current = false;
              applyRecovery(recoveryRef.current.loaded(performance.now()));
              if (!internalReloadRef.current) {
                setState((currentState) => ({
                  ...currentState,
                  loading: true,
                  status: "Starting playback...",
                }));
              }
              break;
            case "playback-restart":
              applyRecovery(recoveryRef.current.firstFrame(performance.now()));
              if (internalReloadRef.current) {
                internalReloadRef.current = false;
                break;
              }
              setState((currentState) => ({
                ...currentState,
                ready: true,
                idleActive: false,
                loading: false,
                buffering: false,
                error: null,
                status: currentMediaRef.current?.kind === "vod" ? "Playing" : "Playing live stream",
              }));
              break;
            case "end-file": {
              if (userStoppedPlaybackRef.current) {
                setState((currentState) => ({
                  ...currentState,
                  idleActive: true,
                  loading: false,
                  buffering: false,
                  error: null,
                  status: "Playback stopped",
                  videoWidth: null,
                  videoHeight: null,
                  videoFps: null,
                }));
                break;
              }

              // The stop our own `loadfile replace` produces is not a user stop
              // and must never reset the ladder.
              if (event.reason === "stop") {
                expectedStopRef.current = false;
                break;
              }

              if (event.reason === "error" || event.reason === "eof") {
                scheduleEndFileCheck(event.reason, event.error);
              }
              break;
            }
            case "log-message": {
              if (event.level.toLowerCase().includes("error")) {
                const sanitizedMessage = sanitizeLogMessage(event.text);
                lastErrorLogRef.current = sanitizedMessage.length > 0 ? sanitizedMessage : null;
              }
              break;
            }
            default:
              break;
          }
        });

        await setProperty("volume", initialVolumeRef.current);

        if (!cancelled) {
          readyRef.current = true;
          setState((currentState) => ({
            ...currentState,
            ready: true,
            status: "Native player ready",
          }));
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        readyRef.current = false;
        setState((currentState) => ({
          ...currentState,
          initError: describeInitError(error),
          status: "Native player unavailable",
          ready: false,
        }));
      }
    }

    void startPlayer();

    return () => {
      cancelled = true;
      clearEndFileGrace();

      if (unlistenProperties) {
        void unlistenProperties();
      }

      if (unlistenEvents) {
        void unlistenEvents();
      }

      if (initializedRef.current) {
        void destroy().catch(() => {
          // Best-effort cleanup during hot reload or shutdown.
        });
      }
    };
  }, [isNativeHost]);

  useEffect(() => {
    if (!isNativeHost) return undefined;

    const timer = window.setInterval(() => {
      const result = recoveryRef.current.tick(performance.now());
      applyRecovery(result);
    }, RECOVERY_TICK_MS);

    return () => {
      window.clearInterval(timer);
      clearEndFileGrace();
    };
  }, [isNativeHost]);

  useEffect(() => {
    if (!isNativeHost || !state.ready || !surfaceRef.current) {
      return undefined;
    }

    const surface = surfaceRef.current;
    let frameHandle = 0;
    let disposed = false;
    const earlyHandles: number[] = [];
    const unlistenFns: UnlistenFn[] = [];

    const syncMargin = () => {
      cancelAnimationFrame(frameHandle);
      frameHandle = window.requestAnimationFrame(() => {
        const nextSurface = surfaceRef.current ?? surface;
        const margin = getMarginRatio(nextSurface);
        if (!margin) return;

        void setVideoMarginRatio(margin).catch(() => {
          // Layout syncing is best-effort and can safely retry on the next event.
        });
      });
    };

    const layoutSync = createLayoutSync(syncMargin, LAYOUT_TRAILING_SYNC_MS, {
      setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      clearTimeout: (handle) => window.clearTimeout(handle),
    });

    layoutSync.schedule();
    earlyHandles.push(window.setTimeout(() => layoutSync.schedule(), 80));
    earlyHandles.push(window.setTimeout(() => layoutSync.schedule(), 220));

    if (isTauri()) {
      const appWindow = getCurrentWindow();
      const attach = (registration: Promise<UnlistenFn>) => {
        void registration
          .then((unlisten) => {
            if (disposed) {
              unlisten();
            } else {
              unlistenFns.push(unlisten);
            }
          })
          .catch(() => {
            // Window events are an extra trigger; the DOM events still sync.
          });
      };
      attach(appWindow.onResized(() => layoutSync.schedule()));
      attach(appWindow.onMoved(() => layoutSync.schedule()));
      attach(appWindow.onScaleChanged(() => layoutSync.schedule()));
    }

    const resizeObserver = new ResizeObserver(() => layoutSync.schedule());
    resizeObserver.observe(surface);
    const onViewportChange = () => layoutSync.schedule();
    window.addEventListener("resize", onViewportChange);
    document.addEventListener("scroll", onViewportChange, true);
    document.addEventListener("fullscreenchange", onViewportChange);

    return () => {
      disposed = true;
      layoutSync.cancel();
      cancelAnimationFrame(frameHandle);
      earlyHandles.forEach((timeoutHandle) => {
        window.clearTimeout(timeoutHandle);
      });
      unlistenFns.forEach((unlisten) => unlisten());
      resizeObserver.disconnect();
      window.removeEventListener("resize", onViewportChange);
      document.removeEventListener("scroll", onViewportChange, true);
      document.removeEventListener("fullscreenchange", onViewportChange);
    };
  }, [isNativeHost, layoutMode, state.ready, surfaceRef]);

  interface LoadMediaOptions {
    startAt?: number | null;
    isRetry?: boolean;
  }

  async function loadMedia(
    media: MpvPlayableMedia,
    externalGuard: () => boolean = () => true,
    options: LoadMediaOptions = {},
  ) {
    if (!externalGuard()) return false;
    const operation = playbackOperationsRef.current.begin(externalGuard);
    const { startAt = null, isRetry = false } = options;
    currentMediaRef.current = media;

    if (!isRetry) {
      clearEndFileGrace();
      applyRecovery(recoveryRef.current.begin(media.kind, performance.now(), media.durationHint ?? null));
    }

    if (!media.isPlayable) {
      setState((currentState) => ({
        ...currentState,
        idleActive: true,
        error: media.playabilityError ?? "This channel is not playable.",
        status: "Channel unavailable",
        videoWidth: null,
        videoHeight: null,
        videoFps: null,
      }));
      return false;
    }

    if (!isNativeHost) {
      setState((currentState) => ({
        ...currentState,
        idleActive: true,
        status: "Use `npm run tauri dev` to test native playback.",
        error: null,
        videoWidth: null,
        videoHeight: null,
        videoFps: null,
      }));
      return false;
    }

    if (!readyRef.current) {
      setState((currentState) => ({
        ...currentState,
        idleActive: true,
        error: currentState.initError ?? "The native player is still starting.",
        status: "Player not ready",
        videoWidth: null,
        videoHeight: null,
        videoFps: null,
      }));
      return false;
    }

    if (media.stream === null) {
      setState((currentState) => ({
        ...currentState,
        idleActive: true,
        loading: false,
        buffering: false,
        error: "Refresh or unlock this source before playback.",
        status: "Channel unavailable",
        videoWidth: null,
        videoHeight: null,
        videoFps: null,
      }));
      return false;
    }

    userStoppedPlaybackRef.current = false;
    lastErrorLogRef.current = null;
    lastPositionRef.current = startAt ?? null;
    if (!isRetry) longestDurationRef.current = null;
    internalReloadRef.current = false;

    setState((currentState) => ({
      ...currentState,
      idleActive: false,
      loading: true,
      buffering: false,
      error: null,
      status: `Loading ${media.name}...`,
      videoWidth: null,
      videoHeight: null,
      videoFps: null,
      playbackMode: media.kind,
      paused: false,
      duration: isRetry ? currentState.duration : null,
      longestDuration: isRetry
        ? currentState.longestDuration
        : normalizeDurationHint(media.durationHint),
      position: isRetry ? startAt : null,
      subtitleTracks: [],
    }));

    const stream = media.stream;
    try {
      if (!(await prepareVideoLayout())) {
        if (operation.isCurrent()) {
          if (isRetry) {
            // A minimized window has no usable surface yet. That is not a
            // stream failure, so wait instead of spending an attempt.
            applyRecovery(recoveryRef.current.defer(performance.now()));
          } else {
            recoveryRef.current.cancel();
            applyRecovery({ snapshot: recoveryRef.current.snapshot(), action: { type: "none", attempt: 0, delayMs: 0, startAt: null } });
            setState((currentState) => ({
              ...currentState,
              idleActive: true,
              loading: false,
              buffering: false,
              error: "The player surface is not ready yet. Try the channel again.",
              status: "Playback error",
              videoWidth: null,
              videoHeight: null,
              videoFps: null,
            }));
          }
        }
        return false;
      }
      // keep-open leaves pause=true at the end of the previous file; a retry
      // must not start paused, or the watchdog sees a frozen "playing" stream.
      // The recovery machine is told too: a missed pause event must not leave
      // it believing a deliberately unpaused load is a user pause.
      await setProperty("pause", false).catch(() => undefined);
      applyRecovery(recoveryRef.current.pausedChanged(false, performance.now()));
      ourLoadRef.current = true;
      expectedStopRef.current = true;
      const args: (string | number)[] = [stream, "replace"];
      if (typeof startAt === "number" && startAt >= 10) {
        args.push(-1, `start=${Math.floor(startAt)}`);
      }
      const result = await playbackOperationsRef.current.run(operation, async () => {
        await command("loadfile", args);
        // The unpause above can be undone before loadfile runs: a dropped VOD
        // stream surfaces as EOF, and keep-open re-pauses a file sitting at
        // its end. Once the new file replaces it, unpause again so a Reload
        // resumes playing instead of opening paused.
        await setProperty("pause", false).catch(() => undefined);
        return true;
      });
      return result === true;
    } catch (error) {
      ourLoadRef.current = false;
      expectedStopRef.current = false;
      if (!operation.isCurrent()) return false;
      applyRecovery(recoveryRef.current.loadFailed(describeCommandError(error), performance.now()));
      return false;
    }
  }

  async function playMedia(
    media: MpvPlayableMedia,
    externalGuard: () => boolean = () => true,
    options: LoadMediaOptions = {},
  ) {
    return loadMedia(media, externalGuard, options);
  }

  async function playChannel(channel: Channel, externalGuard?: () => boolean) {
    return playMedia({
      id: channel.id,
      kind: "live",
      name: channel.name,
      stream: channel.stream,
      isPlayable: channel.isPlayable,
      playabilityError: channel.playabilityError,
    }, externalGuard);
  }

  async function stopPlayback() {
    const operation = playbackOperationsRef.current.begin();
    if (!isNativeHost || !state.ready) {
      return;
    }

    userStoppedPlaybackRef.current = true;
    clearEndFileGrace();
    expectedStopRef.current = false;
    applyRecovery(recoveryRef.current.cancel());

    try {
      const result = await playbackOperationsRef.current.run(operation, async () => {
        await command("stop");
        return true;
      });
      if (result !== true) return;
      setState((currentState) => ({
        ...currentState,
        idleActive: true,
        loading: false,
        buffering: false,
        error: null,
        status: "Playback stopped",
        videoWidth: null,
        videoHeight: null,
        videoFps: null,
      }));
    } catch (error) {
      if (!operation.isCurrent()) return;
      setState((currentState) => ({
        ...currentState,
        idleActive: true,
        error: describeCommandError(error),
        status: "Playback error",
      }));
    }
  }

  /**
   * The user asked to skip the current wait. The recovery machine keeps the
   * same attempt; this only makes its deadline now and starts it.
   */
  function retryNow() {
    const recovery = recoveryRef.current;
    applyRecovery(recovery.retryNow(performance.now()));
    const started = recovery.tick(performance.now());
    applyRecovery(started);
    if (started.action.type === "retry") {
      void retryCurrentMedia(started.action.startAt);
    }
  }

  async function reloadPlayback() {
    const media = currentMediaRef.current;
    if (!media) {
      return;
    }

    const startAt = resumeStartPosition(
      media.kind,
      lastPositionRef.current,
      longestDurationRef.current,
    );
    await loadMedia(media, () => true, { startAt });
  }

  async function toggleMute() {
    if (!isNativeHost || !state.ready) {
      return;
    }

    try {
      await setProperty("mute", !state.muted);
    } catch (error) {
      setState((currentState) => ({
        ...currentState,
        error: describeCommandError(error),
        status: "Playback error",
      }));
    }
  }

  async function togglePause() {
    if (!isNativeHost || !state.ready || state.playbackMode !== "vod") return;
    try {
      await setProperty("pause", !state.paused);
    } catch (error) {
      setState((currentState) => ({
        ...currentState,
        error: describeCommandError(error),
        status: "Playback error",
      }));
    }
  }

  async function seekRelative(seconds: number) {
    if (!isNativeHost || !state.ready || state.playbackMode !== "vod" || !Number.isFinite(seconds)) {
      return;
    }
    applyRecovery(recoveryRef.current.seek(performance.now()));
    await command("seek", [seconds, "relative+exact"]);
  }

  async function seekAbsolute(seconds: number) {
    if (!isNativeHost || !state.ready || state.playbackMode !== "vod") return;
    applyRecovery(recoveryRef.current.seek(performance.now()));
    await command("seek", [clampSeekPosition(seconds, state.duration), "absolute+exact"]);
  }

  async function setSubtitleTrack(trackId: number | null) {
    if (!isNativeHost || !state.ready || state.playbackMode !== "vod") return;
    await setProperty("sid", trackId ?? "no");
  }

  async function setVolumeLevel(volume: number) {
    if (!isNativeHost || !state.ready) {
      return;
    }

    try {
      await setProperty("volume", clampVolume(volume));
    } catch (error) {
      setState((currentState) => ({
        ...currentState,
        error: describeCommandError(error),
        status: "Playback error",
      }));
    }
  }

  return {
    player: state,
    playChannel,
    playMedia,
    stopPlayback,
    reloadPlayback,
    retryNow,
    toggleMute,
    togglePause,
    seekRelative,
    seekAbsolute,
    setSubtitleTrack,
    setVolumeLevel,
  };
}
