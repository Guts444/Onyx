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
import { redactCredentials } from "../playlist/redaction";
import { calculateVideoMarginRatio } from "./layout";
import { clampSeekPosition, parseSubtitleTracks, type SubtitleTrack } from "./media";
import { LatestPlaybackOperationCoordinator } from "./operations";

export const DEFAULT_PLAYER_VOLUME = 72;
const OBSERVED_PROPERTIES = [
  ["volume", "double"],
  ["mute", "flag"],
  ["width", "int64", "none"],
  ["height", "int64", "none"],
  ["estimated-vf-fps", "double", "none"],
  ["container-fps", "double", "none"],
  ["paused-for-cache", "flag"],
  ["idle-active", "flag"],
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
  position: number | null;
  subtitleTracks: SubtitleTrack[];
}

export interface MpvPlayableMedia {
  id: string;
  kind: "live" | "vod";
  name: string;
  stream: string | null;
  isPlayable: boolean;
  playabilityError?: string | null;
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

function getMarginRatio(surface: HTMLElement) {
  const rect = surface.getBoundingClientRect();
  const root = document.documentElement;
  return calculateVideoMarginRatio(rect, {
    width: Math.max(window.innerWidth || 0, root.clientWidth || 0),
    height: Math.max(window.innerHeight || 0, root.clientHeight || 0),
  });
}

function describeInitError(error: unknown) {
  const message = redactCredentials(
    error instanceof Error ? error.message : "Unknown initialization error.",
  );

  return `libmpv could not start. Review the mpv dependency setup, then place libmpv-wrapper.dll and libmpv-2.dll in src-tauri/lib/. Original error: ${message}`;
}

function describeCommandError(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return redactCredentials(error.message.trim());
  }

  return "The player command failed.";
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
    position: null,
    subtitleTracks: [],
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
                setState((currentState) => ({
                  ...currentState,
                  buffering: event.data,
                  status: event.data ? "Buffering..." : currentState.status,
                }));
              }
              break;
            case "idle-active":
              if (typeof event.data === "boolean") {
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
            case "duration":
              setState((currentState) => ({
                ...currentState,
                duration: normalizeVideoFps(event.data),
              }));
              break;
            case "time-pos":
              setState((currentState) => ({
                ...currentState,
                position: typeof event.data === "number" && Number.isFinite(event.data)
                  ? Math.max(0, event.data)
                  : null,
              }));
              break;
            case "pause":
              if (typeof event.data === "boolean") {
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
            case "playback-restart":
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
              if (userStoppedPlaybackRef.current || event.reason === "stop") {
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

              if (event.reason === "eof") {
                setState((currentState) => ({
                  ...currentState,
                  idleActive: true,
                  loading: false,
                  buffering: false,
                  error: null,
                  status: currentMediaRef.current?.kind === "vod"
                    ? "Playback complete"
                    : "The stream ended.",
                  videoWidth: null,
                  videoHeight: null,
                  videoFps: null,
                }));
                break;
              }

              const logSuffix = lastErrorLogRef.current ? ` ${lastErrorLogRef.current}` : "";
              setState((currentState) => ({
                ...currentState,
                idleActive: true,
                loading: false,
                buffering: false,
                error: `The stream stopped unexpectedly (${event.reason}, code ${event.error}).${logSuffix}`,
                status: "Playback error",
                videoWidth: null,
                videoHeight: null,
                videoFps: null,
              }));
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
    if (!isNativeHost || !state.ready || !surfaceRef.current) {
      return undefined;
    }

    const surface = surfaceRef.current;
    let frameHandle = 0;
    const timeoutHandles: number[] = [];

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

    syncMargin();
    timeoutHandles.push(window.setTimeout(syncMargin, 80));
    timeoutHandles.push(window.setTimeout(syncMargin, 220));

    const resizeObserver = new ResizeObserver(syncMargin);
    resizeObserver.observe(surface);
    window.addEventListener("resize", syncMargin);
    document.addEventListener("scroll", syncMargin, true);
    document.addEventListener("fullscreenchange", syncMargin);

    return () => {
      cancelAnimationFrame(frameHandle);
      timeoutHandles.forEach((timeoutHandle) => {
        window.clearTimeout(timeoutHandle);
      });
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncMargin);
      document.removeEventListener("scroll", syncMargin, true);
      document.removeEventListener("fullscreenchange", syncMargin);
    };
  }, [isNativeHost, layoutMode, state.ready, surfaceRef]);

  async function playMedia(media: MpvPlayableMedia, externalGuard: () => boolean = () => true) {
    if (!externalGuard()) return false;
    const operation = playbackOperationsRef.current.begin(externalGuard);
    currentMediaRef.current = media;

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

    if (!state.ready) {
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
      duration: null,
      position: null,
      subtitleTracks: [],
    }));

    const stream = media.stream;
    try {
      if (!(await prepareVideoLayout())) {
        throw new Error("The player surface is not ready yet. Try the channel again.");
      }
      const result = await playbackOperationsRef.current.run(operation, async () => {
        await command("loadfile", [stream, "replace"]);
        return true;
      });
      return result === true;
    } catch (error) {
      if (!operation.isCurrent()) return false;
      setState((currentState) => ({
        ...currentState,
        idleActive: true,
        loading: false,
        buffering: false,
        error: describeCommandError(error),
        status: "Playback error",
      }));
      return false;
    }
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

  async function reloadPlayback() {
    if (!currentMediaRef.current) {
      return;
    }

    await playMedia(currentMediaRef.current);
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
    await command("seek", [seconds, "relative+exact"]);
  }

  async function seekAbsolute(seconds: number) {
    if (!isNativeHost || !state.ready || state.playbackMode !== "vod") return;
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
    toggleMute,
    togglePause,
    seekRelative,
    seekAbsolute,
    setSubtitleTrack,
    setVolumeLevel,
  };
}
