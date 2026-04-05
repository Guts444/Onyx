import { useEffect, useMemo, useState } from "react";
import type { EpgDirectoryChannel, EpgResolvedGuide } from "../domain/epg";
import type { Channel } from "../domain/iptv";
import { searchEpgChannelsForChannel } from "../features/epg/matching";

interface ChannelEpgMatchDialogProps {
  isOpen: boolean;
  channel: Channel | null;
  epgChannels: EpgDirectoryChannel[];
  currentGuide: EpgResolvedGuide | null;
  onClose: () => void;
  onApplyMatch: (channel: Channel, epgChannel: EpgDirectoryChannel) => void;
  onClearMatch: (channel: Channel) => void;
}

export function ChannelEpgMatchDialog({
  isOpen,
  channel,
  epgChannels,
  currentGuide,
  onClose,
  onApplyMatch,
  onClearMatch,
}: ChannelEpgMatchDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!isOpen || !channel) {
      setSearchQuery("");
      return;
    }

    setSearchQuery(channel.tvgName ?? channel.name);
  }, [channel, isOpen]);

  const visibleChannels = useMemo(() => {
    if (!channel) {
      return [];
    }

    return searchEpgChannelsForChannel(channel, epgChannels, searchQuery);
  }, [channel, epgChannels, searchQuery]);

  if (!isOpen || !channel) {
    return null;
  }

  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <section
        className="settings-drawer settings-drawer--modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="epg-match-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-drawer__header">
          <div>
            <span className="settings-drawer__eyebrow">EPG Match</span>
            <h2 id="epg-match-title">{channel.name}</h2>
            <p>Pick the guide entry that should drive now and next data for this channel. The saved choice will load automatically next time you open Onyx.</p>
          </div>

          <button type="button" className="settings-close" onClick={onClose} aria-label="Close guide matcher">
            Close
          </button>
        </header>

        {currentGuide ? (
          <div className="settings-notice">
            Current match: <strong>{currentGuide.epgChannel.displayNames[0] ?? currentGuide.epgChannel.id}</strong>{" "}
            ({currentGuide.matchSource === "manual" ? "manual" : "auto"}).
          </div>
        ) : null}

        <div className="settings-toolbar settings-toolbar--controls">
          <label className="settings-group-search channel-match-search">
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder="Search guide channels"
            />
          </label>

          <div className="settings-toolbar__actions">
            <button
              type="button"
              className="control-button"
              onClick={() => onClearMatch(channel)}
              disabled={currentGuide?.matchSource !== "manual"}
            >
              Clear Manual Match
            </button>
          </div>
        </div>

        <div className="channel-match-hint">
          Scroll through the results or search by the channel name, `tvg-name`, or the XMLTV channel id.
        </div>

        <div className="settings-list">
          {visibleChannels.length === 0 ? (
            <div className="settings-empty">
              <strong>No guide channels match this search</strong>
              <span>Try the channel name, `tvg-name`, or the provider’s XMLTV channel id.</span>
            </div>
          ) : null}

          {visibleChannels.map((epgChannel) => {
            const isCurrentMatch = currentGuide?.epgChannel.id === epgChannel.id;
            const isCurrentManualMatch =
              isCurrentMatch && currentGuide?.matchSource === "manual";

            return (
              <article key={epgChannel.id} className="settings-list__item settings-list__item--stacked">
                <div className="settings-list__copy">
                  <strong>{epgChannel.displayNames[0] ?? epgChannel.id}</strong>
                  <span>{epgChannel.id}</span>
                  {epgChannel.displayNames.slice(1, 4).map((displayName) => (
                    <span key={displayName}>{displayName}</span>
                  ))}
                </div>

                <button
                  type="button"
                  className={`control-button ${isCurrentManualMatch ? "control-button--active" : ""}`}
                  onClick={() => onApplyMatch(channel, epgChannel)}
                >
                  {isCurrentManualMatch ? "Matched" : "Apply Match"}
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
