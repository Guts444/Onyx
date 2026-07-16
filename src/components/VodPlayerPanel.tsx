import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import type { VodPlaybackItem } from "../domain/vod";
import type { MpvPlayerState } from "../features/player/mpv";

interface VodPlayerPanelProps {
  player: MpvPlayerState;
  media: VodPlaybackItem;
  isFullscreen: boolean;
  playerShellRef: RefObject<HTMLDivElement | null>;
  playerSurfaceRef: RefObject<HTMLDivElement | null>;
  onTogglePause: () => void;
  onSeekRelative: (seconds: number) => void;
  onSeekAbsolute: (seconds: number) => void;
  onSelectSubtitle: (trackId: number | null) => void;
  onToggleMute: () => void;
  onSetVolume: (volume: number) => void;
  onQuit: () => void;
}

function formatTime(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function VodPlayerPanel({
  player,
  media,
  isFullscreen,
  playerShellRef,
  playerSurfaceRef,
  onTogglePause,
  onSeekRelative,
  onSeekAbsolute,
  onSelectSubtitle,
  onToggleMute,
  onSetVolume,
  onQuit,
}: VodPlayerPanelProps) {
  const [chromeVisible, setChromeVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const position = player.position ?? 0;
  const duration = player.duration ?? 0;
  const selectedSubtitle = player.subtitleTracks.find((track) => track.selected)?.id ?? "off";
  const showStatus = player.loading || player.buffering || player.error !== null || player.idleActive;
  const resolution = player.videoWidth && player.videoHeight
    ? `${player.videoWidth} × ${player.videoHeight}`
    : null;

  function clearHideTimer() {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }

  function revealChrome(scheduleHide = true) {
    clearHideTimer();
    setChromeVisible(true);
    if (scheduleHide) {
      hideTimerRef.current = window.setTimeout(() => setChromeVisible(false), 3000);
    }
  }

  useEffect(() => {
    revealChrome();
    return () => {
      clearHideTimer();
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    };
  }, [media.id]);

  function handleSurfaceClick(event: MouseEvent<HTMLDivElement>) {
    if (event.detail > 1) return;
    revealChrome();
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      onTogglePause();
    }, 220);
  }

  function handleSurfaceDoubleClick(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = null;
    onQuit();
  }

  return (
    <section
      ref={playerShellRef}
      className={`panel player-shell vod-player ${
        isFullscreen ? "player-shell--fullscreen" : ""
      }`}
    >
      <div
        ref={playerSurfaceRef}
        className={`player-surface ${chromeVisible ? "" : "player-surface--chrome-hidden"}`}
        onMouseMove={() => revealChrome()}
        onClick={handleSurfaceClick}
        onDoubleClick={handleSurfaceDoubleClick}
      >
        {showStatus ? (
          <div className="player-status-card player-status-card--preview">
            <span className={`status-pill ${player.error ? "status-pill--error" : "status-pill--info"}`}>
              {player.status}
            </span>
            <div className="player-status-card__copy">
              <h2>{media.title}</h2>
              <p>{player.error ?? media.plot ?? "Preparing video playback."}</p>
            </div>
          </div>
        ) : null}

        <div
          className="vod-player__chrome"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onFocusCapture={() => revealChrome(false)}
          onBlurCapture={() => revealChrome()}
        >
          <div className="vod-player__title">
            <strong>{media.title}</strong>
            {media.season !== null && media.episode !== null ? (
              <span>Season {media.season}, Episode {media.episode}</span>
            ) : null}
            {resolution ? <span className="vod-player__resolution">{resolution}</span> : null}
          </div>

          <div className="vod-player__timeline">
            <span>{formatTime(player.position)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, duration)}
              step={1}
              value={Math.min(position, Math.max(1, duration))}
              onChange={(event) => onSeekAbsolute(Number(event.currentTarget.value))}
              disabled={duration <= 0}
              aria-label="Playback position"
            />
            <span>{formatTime(player.duration)}</span>
          </div>

          <div className="vod-player__controls">
            <button type="button" className="control-button" onClick={() => onSeekRelative(-30)}>
              −30s
            </button>
            <button type="button" className="control-button control-button--primary" onClick={onTogglePause}>
              {player.paused ? "Resume" : "Pause"}
            </button>
            <button type="button" className="control-button" onClick={() => onSeekRelative(30)}>
              +30s
            </button>
            <button type="button" className="control-button" onClick={onToggleMute}>
              {player.muted ? "Unmute" : "Mute"}
            </button>
            <label className="vod-player__subtitle-control">
              <span>Subtitles</span>
              <select
                value={selectedSubtitle}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  onSelectSubtitle(value === "off" ? null : Number(value));
                }}
              >
                <option value="off">Off</option>
                {player.subtitleTracks.map((track) => (
                  <option key={track.id} value={track.id}>{track.label}</option>
                ))}
              </select>
            </label>
            <label className="volume-control vod-player__volume">
              <span>Volume</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(player.volume)}
                onChange={(event) => onSetVolume(Number(event.currentTarget.value))}
              />
            </label>
            <button type="button" className="control-button" onClick={onQuit}>Quit</button>
          </div>
        </div>
      </div>
    </section>
  );
}
