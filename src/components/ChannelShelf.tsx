import { useEffect, useMemo, useState, type ReactNode, type UIEvent } from "react";
import {
  getProgrammeStopMs,
  type EpgProgrammeSummary,
  type EpgResolvedGuide,
} from "../domain/epg";
import type { Channel } from "../domain/iptv";
import type { NavigationSection } from "./ChannelSidebar";

interface ChannelShelfProps {
  navigationSection: NavigationSection;
  isSidebarVisible: boolean;
  preview: ReactNode;
  activeGroupLabel: string | null;
  playlistName: string | null;
  channels: Channel[];
  totalChannelCount: number;
  selectedChannel: Channel | null;
  selectedGuide: EpgResolvedGuide | null;
  selectedChannelId: string | null;
  favoriteIdSet: Set<string>;
  getGuideByChannelId: (channelId: string) => EpgResolvedGuide | null;
  getProgrammesByChannelId: (channelId: string) => EpgProgrammeSummary[];
  canMatchEpg: boolean;
  guideNowMs: number;
  guideWindowStartMs: number;
  guideWindowEndMs: number;
  searchQuery: string;
  onSelectChannel: (channel: Channel) => void;
  onToggleFavorite: (channelId: string) => void;
  onOpenEpgMatcher: (channel: Channel) => void;
  onLoadMoreChannels: () => void;
}

interface GuideSegment {
  key: string;
  title: string;
  startMs: number;
  stopMs: number;
  isPlaceholder: boolean;
  isCurrent: boolean;
}

interface ContextMenuState {
  channel: Channel;
  x: number;
  y: number;
}

const GUIDE_SLOT_MINUTES = 30;

function formatClock(timestamp: number, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(timestamp);
}

function formatGuideDate(timestamp: number) {
  return new Intl.DateTimeFormat([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatProgrammeWindow(programme: EpgProgrammeSummary | null, nextProgramme: EpgProgrammeSummary | null) {
  if (!programme) {
    return "No guide information";
  }

  const stopMs = programme.stopMs ?? nextProgramme?.startMs ?? null;
  const startLabel = formatClock(programme.startMs);
  const stopLabel = stopMs ? formatClock(stopMs) : null;
  return stopLabel ? `${startLabel} - ${stopLabel}` : startLabel;
}

function clampPercentage(value: number) {
  return Math.max(0, Math.min(100, value));
}

function buildGuideSegments(
  programmes: EpgProgrammeSummary[],
  guideNowMs: number,
  guideWindowStartMs: number,
  guideWindowEndMs: number,
) {
  if (programmes.length === 0) {
    return [
      {
        key: "placeholder",
        title: "No information",
        startMs: guideWindowStartMs,
        stopMs: guideWindowEndMs,
        isPlaceholder: true,
        isCurrent: false,
      } satisfies GuideSegment,
    ];
  }

  const segments: GuideSegment[] = [];
  let cursorMs = guideWindowStartMs;

  for (let index = 0; index < programmes.length; index += 1) {
    const programme = programmes[index];
    const inferredStopMs = getProgrammeStopMs(programmes, index, guideWindowEndMs) ?? guideWindowEndMs;

    if (programme.startMs >= guideWindowEndMs) {
      break;
    }

    if (inferredStopMs <= guideWindowStartMs) {
      continue;
    }

    const segmentStartMs = Math.max(programme.startMs, guideWindowStartMs);
    const segmentStopMs = Math.min(inferredStopMs, guideWindowEndMs);

    if (segmentStartMs > cursorMs) {
      segments.push({
        key: `gap_${cursorMs}`,
        title: "No information",
        startMs: cursorMs,
        stopMs: segmentStartMs,
        isPlaceholder: true,
        isCurrent: false,
      });
    }

    segments.push({
      key: `${programme.startMs}_${programme.title}`,
      title: programme.title,
      startMs: segmentStartMs,
      stopMs: segmentStopMs,
      isPlaceholder: false,
      isCurrent: programme.startMs <= guideNowMs && guideNowMs < inferredStopMs,
    });

    cursorMs = Math.max(cursorMs, segmentStopMs);
  }

  if (cursorMs < guideWindowEndMs) {
    segments.push({
      key: `gap_${cursorMs}`,
      title: "No information",
      startMs: cursorMs,
      stopMs: guideWindowEndMs,
      isPlaceholder: true,
      isCurrent: false,
    });
  }

  return segments;
}

export function ChannelShelf({
  navigationSection,
  isSidebarVisible,
  preview,
  activeGroupLabel,
  playlistName,
  channels,
  totalChannelCount,
  selectedChannel,
  selectedGuide,
  selectedChannelId,
  favoriteIdSet,
  getGuideByChannelId,
  getProgrammesByChannelId,
  canMatchEpg,
  guideNowMs,
  guideWindowStartMs,
  guideWindowEndMs,
  searchQuery,
  onSelectChannel,
  onToggleFavorite,
  onOpenEpgMatcher,
  onLoadMoreChannels,
}: ChannelShelfProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const hasMoreChannels = channels.length < totalChannelCount;
  const timeMarkers = useMemo(() => {
    const markerCount = Math.round((guideWindowEndMs - guideWindowStartMs) / (GUIDE_SLOT_MINUTES * 60 * 1000));

    return Array.from({ length: markerCount + 1 }, (_, index) =>
      guideWindowStartMs + index * GUIDE_SLOT_MINUTES * 60 * 1000,
    );
  }, [guideWindowEndMs, guideWindowStartMs]);
  const nowLineLeft = clampPercentage(
    ((guideNowMs - guideWindowStartMs) / (guideWindowEndMs - guideWindowStartMs)) * 100,
  );
  const selectedCurrentProgramme = selectedGuide?.current ?? null;
  const selectedNextProgramme = selectedGuide?.next ?? null;
  const selectedStopMs =
    selectedCurrentProgramme?.stopMs ?? selectedNextProgramme?.startMs ?? null;
  const selectedProgress =
    selectedCurrentProgramme && selectedStopMs && selectedStopMs > selectedCurrentProgramme.startMs
      ? clampPercentage(
          ((guideNowMs - selectedCurrentProgramme.startMs) /
            (selectedStopMs - selectedCurrentProgramme.startMs)) *
            100,
        )
      : 0;

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }

    const handleClose = () => {
      setContextMenu(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("mousedown", handleClose);
    window.addEventListener("resize", handleClose);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("mousedown", handleClose);
      window.removeEventListener("resize", handleClose);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [contextMenu]);

  function handleListScroll(event: UIEvent<HTMLDivElement>) {
    if (contextMenu) {
      setContextMenu(null);
    }

    if (!hasMoreChannels) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;

    if (scrollHeight - scrollTop - clientHeight < 640) {
      onLoadMoreChannels();
    }
  }

  function handleOpenContextMenu(channel: Channel, clientX: number, clientY: number) {
    const maxLeft = Math.max(20, window.innerWidth - 220);
    const maxTop = Math.max(20, window.innerHeight - 150);

    setContextMenu({
      channel,
      x: Math.min(clientX, maxLeft),
      y: Math.min(clientY, maxTop),
    });
  }

  return (
    <section
      className={`channel-shelf ${
        isSidebarVisible ? "channel-shelf--sidebar-visible" : "channel-shelf--guide-focused"
      }`}
    >
      <div className={`guide-hero ${isSidebarVisible ? "guide-hero--with-sidebar" : ""}`}>
        <div className={`guide-hero__preview ${isSidebarVisible ? "guide-hero__preview--with-sidebar" : ""}`}>
          {preview}
        </div>

        <div className="guide-hero__details">
          <span className="channel-shelf__eyebrow">
            {navigationSection === "search" ? "Search" : activeGroupLabel ?? "Live TV"}
          </span>
          <h3>{selectedCurrentProgramme?.title ?? selectedChannel?.name ?? "Select a channel"}</h3>
          <div className="guide-hero__meta">
            <span>{formatProgrammeWindow(selectedCurrentProgramme, selectedNextProgramme)}</span>
            {selectedCurrentProgramme ? <span>{Math.round(selectedProgress)}% live</span> : null}
            {playlistName ? <span>{playlistName}</span> : null}
          </div>

          {selectedCurrentProgramme ? (
            <>
              <div className="guide-hero__progress">
                <span style={{ width: `${selectedProgress}%` }} />
              </div>
              <p>
                {selectedCurrentProgramme.description ??
                  selectedCurrentProgramme.subTitle ??
                  "No programme description is available for this guide entry."}
              </p>
              {selectedNextProgramme ? (
                <div className="guide-hero__next">
                  Next {formatProgrammeWindow(selectedNextProgramme, null)}: {selectedNextProgramme.title}
                </div>
              ) : null}
            </>
          ) : selectedChannel ? (
            <p>
              {selectedGuide
                ? "Guide data is available for this channel, but nothing is airing in the current window."
                : "Right-click this channel to favorite it or assign the correct EPG listing."}
            </p>
          ) : (
            <p>Pick a channel from the guide to see its live programme details.</p>
          )}
        </div>
      </div>

      <div className="guide-grid">
        <div className="guide-grid__header">
          <div className="guide-grid__channel-header">
            <span className="guide-grid__date">{formatGuideDate(guideNowMs)}</span>
          </div>

          <div className="guide-grid__timeline-header">
            {timeMarkers.map((marker) => (
              <span key={marker} className="guide-grid__time-marker">
                {formatClock(marker)}
              </span>
            ))}
            <span className="guide-grid__now-line" style={{ left: `${nowLineLeft}%` }} />
          </div>
        </div>

        {totalChannelCount === 0 ? (
          <div className="empty-state guide-grid__empty">
            <strong>No channels available</strong>
            <span>Load a source from Settings to build the live TV guide.</span>
          </div>
        ) : navigationSection === "search" && searchQuery.trim().length === 0 ? (
          <div className="empty-state guide-grid__empty">
            <strong>Start typing to search</strong>
            <span>The live guide will narrow down as you search for channels.</span>
          </div>
        ) : channels.length === 0 ? (
          <div className="empty-state guide-grid__empty">
            <strong>No channels match this view</strong>
            <span>
              {navigationSection === "search"
                ? "Try a different search term."
                : "Choose another group or add favorites from the channel context menu."}
            </span>
          </div>
        ) : (
          <div className="guide-grid__body" onScroll={handleListScroll}>
            {channels.map((channel, index) => {
              const isSelected = selectedChannelId === channel.id;
              const isFavorite = favoriteIdSet.has(channel.id);
              const guide = getGuideByChannelId(channel.id);
              const programmes = getProgrammesByChannelId(channel.id);
              const segments = buildGuideSegments(
                programmes,
                guideNowMs,
                guideWindowStartMs,
                guideWindowEndMs,
              );

              return (
                <article
                  key={channel.id}
                  className={`guide-row ${isSelected ? "guide-row--active" : ""}`}
                >
                  <button
                    type="button"
                    className="guide-row__channel"
                    onClick={() => onSelectChannel(channel)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      handleOpenContextMenu(channel, event.clientX, event.clientY);
                    }}
                  >
                    <span className="guide-row__number">{index + 1}</span>
                    {channel.logo ? (
                      <img
                        className="guide-row__logo"
                        src={channel.logo}
                        alt=""
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                      />
                    ) : (
                      <span className="guide-row__logo guide-row__logo--placeholder">TV</span>
                    )}
                    <span className="guide-row__channel-copy">
                      <strong>{channel.name}</strong>
                      <span>
                        {guide ? (guide.matchSource === "manual" ? "Manual EPG" : "Guide matched") : channel.group}
                      </span>
                    </span>
                    {isFavorite ? <span className="guide-row__favorite">★</span> : null}
                  </button>

                  <div
                    className="guide-row__timeline"
                    onClick={() => onSelectChannel(channel)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      handleOpenContextMenu(channel, event.clientX, event.clientY);
                    }}
                  >
                    {segments.map((segment) => {
                      const width = clampPercentage(
                        ((segment.stopMs - segment.startMs) /
                          (guideWindowEndMs - guideWindowStartMs)) *
                          100,
                      );
                      const left = clampPercentage(
                        ((segment.startMs - guideWindowStartMs) /
                          (guideWindowEndMs - guideWindowStartMs)) *
                          100,
                      );

                      return (
                        <div
                          key={segment.key}
                          className={`guide-row__programme ${
                            segment.isPlaceholder ? "guide-row__programme--placeholder" : ""
                          } ${segment.isCurrent ? "guide-row__programme--current" : ""}`}
                          style={{
                            left: `${left}%`,
                            width: `${width}%`,
                          }}
                          title={segment.title}
                        >
                          <span>{segment.title}</span>
                        </div>
                      );
                    })}
                    <span className="guide-row__now-line" style={{ left: `${nowLineLeft}%` }} />
                  </div>
                </article>
              );
            })}

            {hasMoreChannels ? (
              <button
                type="button"
                className="channel-shelf__load-more"
                onClick={onLoadMoreChannels}
              >
                Show more channels
              </button>
            ) : null}
          </div>
        )}
      </div>

      {contextMenu ? (
        <div
          className="channel-context-menu"
          role="menu"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="channel-context-menu__item"
            onClick={() => {
              onToggleFavorite(contextMenu.channel.id);
              setContextMenu(null);
            }}
          >
            {favoriteIdSet.has(contextMenu.channel.id) ? "Remove Favorite" : "Add Favorite"}
          </button>
          <button
            type="button"
            className="channel-context-menu__item"
            onClick={() => {
              if (canMatchEpg) {
                onOpenEpgMatcher(contextMenu.channel);
              }
              setContextMenu(null);
            }}
          >
            {canMatchEpg ? "Assign EPG" : "Add EPG Source First"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
