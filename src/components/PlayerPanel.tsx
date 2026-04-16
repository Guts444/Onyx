import { useEffect, useRef, useState, type RefObject } from "react";
import type { EpgResolvedGuide } from "../domain/epg";
import type { Channel } from "../domain/iptv";
import type { MpvPlayerState } from "../features/player/mpv";

interface PlayerPanelProps {
  player: MpvPlayerState;
  selectedChannel: Channel | null;
  guide: EpgResolvedGuide | null;
  isFullscreen: boolean;
  layout?: "default" | "preview";
  playerShellRef: RefObject<HTMLDivElement | null>;
  playerSurfaceRef: RefObject<HTMLDivElement | null>;
  onStop: () => void;
  onReload: () => void;
  onToggleMute: () => void;
  onSetVolume: (volume: number) => void;
  onToggleFullscreen: () => void;
}

function getStatusTone(player: MpvPlayerState, selectedChannel: Channel | null) {
  if (player.initError || player.error || selectedChannel?.playabilityError) {
    return "error";
  }

  if (player.buffering) {
    return "warning";
  }

  if (player.loading) {
    return "info";
  }

  if (!selectedChannel) {
    return "idle";
  }

  if (player.idleActive) {
    return "idle";
  }

  return "success";
}

function getPlayerCopy(player: MpvPlayerState, selectedChannel: Channel | null) {
  let heading = "Open a source from Settings";
  let body = "Pick a group on the left, then choose a channel below the player.";

  if (player.environment === "browser") {
    heading = "Native playback is disabled in browser preview";
    body = "Use `npm run tauri dev` to test the real desktop app with libmpv.";
  } else if (player.initError) {
    heading = "Native player setup required";
    body = player.initError;
  } else if (selectedChannel?.playabilityError) {
    heading = selectedChannel.name;
    body = selectedChannel.playabilityError;
  } else if (player.error && selectedChannel) {
    heading = selectedChannel.name;
    body = player.error;
  } else if (player.buffering && selectedChannel) {
    heading = selectedChannel.name;
    body = "The stream is buffering. Reload it if playback stalls for too long.";
  } else if (player.loading && selectedChannel) {
    heading = selectedChannel.name;
    body = "Opening the selected stream.";
  } else if (player.idleActive && selectedChannel) {
    heading = selectedChannel.name;
    body = "Playback is idle. If the stream does not appear, reload it or choose the channel again.";
  }

  return { heading, body };
}

export function PlayerPanel({
  player,
  selectedChannel,
  guide,
  isFullscreen,
  layout = "default",
  playerShellRef,
  playerSurfaceRef,
  onStop,
  onReload,
  onToggleMute,
  onSetVolume,
  onToggleFullscreen,
}: PlayerPanelProps) {
  const isPreviewLayout = layout === "preview";
  const statusTone = getStatusTone(player, selectedChannel);
  const { heading, body } = getPlayerCopy(player, selectedChannel);
  const hideChromeTimeoutRef = useRef<number | null>(null);
  const [showPlayerChrome, setShowPlayerChrome] = useState(false);
  const canControlPlayback =
    player.environment === "tauri" &&
    player.ready &&
    !player.initError &&
    selectedChannel !== null &&
    selectedChannel.isPlayable;
  const shouldShowStatusCard =
    player.environment === "browser" ||
    player.initError !== null ||
    selectedChannel === null ||
    player.idleActive ||
    selectedChannel.playabilityError !== null ||
    player.error !== null ||
    player.loading ||
    player.buffering;
  const currentTitle = selectedChannel?.name ?? "Nothing selected";
  const currentMeta = selectedChannel
    ? `${selectedChannel.group}${selectedChannel.isPlayable ? "" : " - unavailable"}`
    : "Choose a group, then pick a channel to begin playback.";
  const resolutionLabel =
    player.videoWidth !== null && player.videoHeight !== null
      ? `${player.videoWidth}x${player.videoHeight}`
      : "Detecting...";
  const fpsLabel = player.videoFps !== null ? `${Math.round(player.videoFps)} fps` : "Detecting...";
  const shouldRenderChrome = !isPreviewLayout && selectedChannel !== null;
  const shouldHideCursor =
    !isPreviewLayout && isFullscreen && !showPlayerChrome && !shouldShowStatusCard;

  function formatProgrammeTime(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatProgrammeWindow(
    programme: EpgResolvedGuide["current"] | EpgResolvedGuide["next"],
  ) {
    if (!programme) {
      return null;
    }

    const startLabel = formatProgrammeTime(programme.startMs);
    const stopLabel = programme.stopMs ? formatProgrammeTime(programme.stopMs) : null;
    return stopLabel ? `${startLabel} - ${stopLabel}` : startLabel;
  }

  function clearHideTimer() {
    if (hideChromeTimeoutRef.current !== null) {
      window.clearTimeout(hideChromeTimeoutRef.current);
      hideChromeTimeoutRef.current = null;
    }
  }

  function revealPlayerChrome() {
    clearHideTimer();
    setShowPlayerChrome(true);

    if (shouldShowStatusCard) {
      return;
    }

    hideChromeTimeoutRef.current = window.setTimeout(() => {
      setShowPlayerChrome(false);
    }, 2200);
  }

  function hidePlayerChrome() {
    clearHideTimer();

    if (isFullscreen && !shouldShowStatusCard) {
      setShowPlayerChrome(false);
      return;
    }

    if (!isFullscreen) {
      setShowPlayerChrome(false);
    }
  }

  useEffect(() => {
    clearHideTimer();

    if (!shouldRenderChrome) {
      setShowPlayerChrome(false);
      return undefined;
    }

    setShowPlayerChrome(true);

    if (!shouldShowStatusCard) {
      hideChromeTimeoutRef.current = window.setTimeout(() => {
        setShowPlayerChrome(false);
      }, 2200);
    }

    return () => {
      clearHideTimer();
    };
  }, [shouldRenderChrome, isFullscreen, shouldShowStatusCard]);

  return (
    <section
      ref={playerShellRef}
      className={`panel player-shell ${isPreviewLayout ? "player-shell--preview" : ""} ${
        isFullscreen ? "player-shell--fullscreen" : ""
      } ${
        shouldHideCursor ? "player-shell--cursor-hidden" : ""
      }`}
      onMouseMove={isPreviewLayout ? undefined : revealPlayerChrome}
      onMouseEnter={isPreviewLayout ? undefined : revealPlayerChrome}
      onMouseLeave={isPreviewLayout ? undefined : hidePlayerChrome}
    >
      <div ref={playerSurfaceRef} className="player-surface" onDoubleClick={onToggleFullscreen}>
        {shouldShowStatusCard ? (
          <div className={`player-status-card ${isPreviewLayout ? "player-status-card--preview" : ""}`}>
            <span className={`status-pill status-pill--${statusTone}`}>{player.status}</span>
            <div className="player-status-card__copy">
              <h2>{heading}</h2>
              <p>{body}</p>
            </div>
          </div>
        ) : null}

        {shouldRenderChrome ? (
          <div className={`player-chrome ${showPlayerChrome ? "" : "player-chrome--hidden"}`}>
            <div className="player-chrome__top">
              <span className={`status-pill status-pill--${statusTone}`}>{player.status}</span>
            </div>

            <div className="player-chrome__bottom">
              <div className="player-chrome__summary">
                <strong>{currentTitle}</strong>
                <span>{currentMeta}</span>
                {guide?.current ? (
                  <div className="player-guide">
                    <span className="player-guide__eyebrow">
                      On now {formatProgrammeWindow(guide.current)}
                    </span>
                    <strong>{guide.current.title}</strong>
                    {guide.next ? (
                      <span>
                        Next {formatProgrammeWindow(guide.next)}: {guide.next.title}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="player-chrome__controls">
                <div className="control-row">
                  <span className="control-metric">{resolutionLabel}</span>
                  <span className="control-metric">{fpsLabel}</span>
                  <button
                    type="button"
                    className="control-button"
                    onClick={onReload}
                    disabled={!canControlPlayback}
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    className="control-button"
                    onClick={onStop}
                    disabled={!canControlPlayback}
                  >
                    Stop
                  </button>
                  <button
                    type="button"
                    className="control-button"
                    onClick={onToggleMute}
                    disabled={!canControlPlayback}
                  >
                    {player.muted ? "Unmute" : "Mute"}
                  </button>
                  <button
                    type="button"
                    className="control-button"
                    onClick={onToggleFullscreen}
                    disabled={selectedChannel === null}
                  >
                    {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                  </button>
                </div>

                <label className="volume-control">
                  <span>Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(player.volume)}
                    onChange={(event) => onSetVolume(Number(event.currentTarget.value))}
                    disabled={!canControlPlayback}
                  />
                  <span>{Math.round(player.volume)}%</span>
                </label>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
