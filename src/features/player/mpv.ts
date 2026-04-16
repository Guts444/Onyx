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
}

type PlayerLayoutMode = "windowed" | "fullscreen";

function sanitizeLogMessage(message: string) {
  return message
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
  const width = Math.max(window.innerWidth || 0, root.clientWidth || 0, 1);
  const height = Math.max(window.innerHeight || 0, root.clientHeight || 0, 1);

  if (rect.width < 40 || rect.height < 40) {
    return {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    };
  }

  return {
    left: Math.max(0, Math.min(1, rect.left / width)),
    right: Math.max(0, Math.min(1, (width - rect.right) / width)),
    top: Math.max(0, Math.min(1, rect.top / height)),
    bottom: Math.max(0, Math.min(1, (height - rect.bottom) / height)),
  };
}

function describeInitError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown initialization error.";

  return `libmpv could not start. Review the mpv dependency setup, then place libmpv-wrapper.dll and libmpv-2.dll in src-tauri/lib/. Original error: ${message}`;
}

function describeCommandError(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
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
  const currentChannelRef = useRef<Channel | null>(null);
  const userStoppedPlaybackRef = useRef(false);
  const lastErrorLogRef = useRef<string | null>(null);
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
  });

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
                    event.data && !userStoppedPlaybackRef.current && currentChannelRef.current
                      ? currentState.error
                        ? "Playback error"
                        : "Waiting for the stream..."
                      : currentState.status,
                }));
              }
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
                status: "Playing live stream",
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
                  status: "The stream ended.",
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

        void setVideoMarginRatio(getMarginRatio(nextSurface)).catch(() => {
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
    document.addEventListener("fullscreenchange", syncMargin);

    return () => {
      cancelAnimationFrame(frameHandle);
      timeoutHandles.forEach((timeoutHandle) => {
        window.clearTimeout(timeoutHandle);
      });
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncMargin);
      document.removeEventListener("fullscreenchange", syncMargin);
    };
  }, [isNativeHost, layoutMode, state.ready, surfaceRef]);

  async function playChannel(channel: Channel) {
    currentChannelRef.current = channel;

    if (!channel.isPlayable) {
      setState((currentState) => ({
        ...currentState,
        idleActive: true,
        error: channel.playabilityError ?? "This channel is not playable.",
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

    userStoppedPlaybackRef.current = false;
    lastErrorLogRef.current = null;

    setState((currentState) => ({
      ...currentState,
      idleActive: false,
      loading: true,
      buffering: false,
      error: null,
      status: `Loading ${channel.name}...`,
      videoWidth: null,
      videoHeight: null,
      videoFps: null,
    }));

    try {
      await command("loadfile", [channel.stream, "replace"]);
      return true;
    } catch (error) {
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

  async function stopPlayback() {
    if (!isNativeHost || !state.ready) {
      return;
    }

    userStoppedPlaybackRef.current = true;

    try {
      await command("stop");
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
      setState((currentState) => ({
        ...currentState,
        idleActive: true,
        error: describeCommandError(error),
        status: "Playback error",
      }));
    }
  }

  async function reloadPlayback() {
    if (!currentChannelRef.current) {
      return;
    }

    await playChannel(currentChannelRef.current);
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
    stopPlayback,
    reloadPlayback,
    toggleMute,
    setVolumeLevel,
  };
}
