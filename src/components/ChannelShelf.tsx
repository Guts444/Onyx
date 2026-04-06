import type { EpgResolvedGuide } from "../domain/epg";
import type { Channel, LibraryView } from "../domain/iptv";

interface ChannelShelfProps {
  activeGroupLabel: string | null;
  isFavoritesGroup: boolean;
  channels: Channel[];
  selectedChannelId: string | null;
  activeView: LibraryView;
  searchQuery: string;
  favoriteIdSet: Set<string>;
  recentIdSet: Set<string>;
  getGuideByChannelId: (channelId: string) => EpgResolvedGuide | null;
  canMatchEpg: boolean;
  onSearchChange: (value: string) => void;
  onSelectView: (view: LibraryView) => void;
  onSelectChannel: (channel: Channel) => void;
  onToggleFavorite: (channelId: string) => void;
  onOpenEpgMatcher: (channel: Channel) => void;
}

export function ChannelShelf({
  activeGroupLabel,
  isFavoritesGroup,
  channels,
  selectedChannelId,
  activeView,
  searchQuery,
  favoriteIdSet,
  recentIdSet,
  getGuideByChannelId,
  canMatchEpg,
  onSearchChange,
  onSelectView,
  onSelectChannel,
  onToggleFavorite,
  onOpenEpgMatcher,
}: ChannelShelfProps) {
  function formatProgrammeTime(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatProgrammeWindow(programme: EpgResolvedGuide["current"] | EpgResolvedGuide["next"]) {
    if (!programme) {
      return null;
    }

    const startLabel = formatProgrammeTime(programme.startMs);
    const stopLabel = programme.stopMs ? formatProgrammeTime(programme.stopMs) : null;
    return stopLabel ? `${startLabel} - ${stopLabel}` : startLabel;
  }

  return (
    <section className="panel channel-shelf">
      <div className="channel-shelf__toolbar">
        <div className="channel-shelf__summary channel-shelf__summary--compact">
          <span className="channel-shelf__eyebrow">Channels</span>
          <h3>{activeGroupLabel ?? "Choose a group"}</h3>
          <span className="channel-shelf__meta">
            {activeGroupLabel ? `${channels.length} shown` : "Pick a group"}
          </span>
        </div>

        <div className="channel-shelf__filters">
          <div className="chip-row">
            <button
              type="button"
              className={`chip ${activeView === "all" ? "chip--active" : ""}`}
              onClick={() => onSelectView("all")}
            >
              All
            </button>
            <button
              type="button"
              className={`chip ${activeView === "favorites" ? "chip--active" : ""}`}
              onClick={() => onSelectView("favorites")}
            >
              Favorites
            </button>
            <button
              type="button"
              className={`chip ${activeView === "recents" ? "chip--active" : ""}`}
              onClick={() => onSelectView("recents")}
            >
              Recents
            </button>
          </div>

          <label className="channel-shelf__search">
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchChange(event.currentTarget.value)}
              placeholder={activeGroupLabel ? `Search ${activeGroupLabel}` : "Search channels"}
            />
          </label>
        </div>
      </div>

      {!activeGroupLabel ? (
        <div className="empty-state">
          <strong>No group selected</strong>
          <span>Choose a group from the library to browse its channels here.</span>
        </div>
      ) : null}

      {activeGroupLabel && channels.length === 0 ? (
        <div className="empty-state">
          <strong>{isFavoritesGroup ? "No favorites match this filter" : "No channels match this filter"}</strong>
          <span>
            {isFavoritesGroup
              ? "Favorite a channel to pin it here, or clear the current search and view filters."
              : "Try a different view or clear the search term."}
          </span>
        </div>
      ) : null}

      {activeGroupLabel && channels.length > 0 ? (
        <div className="channel-shelf__list">
          {channels.map((channel) => {
            const isFavorite = favoriteIdSet.has(channel.id);
            const isRecent = recentIdSet.has(channel.id);
            const isSelected = selectedChannelId === channel.id;
            const guide = getGuideByChannelId(channel.id) ?? null;

            return (
              <article
                key={channel.id}
                className={`channel-card ${isSelected ? "channel-card--active" : ""} ${
                  !channel.isPlayable ? "channel-card--disabled" : ""
                }`}
              >
                <button
                  type="button"
                  className="channel-card__main"
                  onClick={() => onSelectChannel(channel)}
                >
                  <span className="channel-card__name">{channel.name}</span>
                  {!channel.isPlayable ? (
                    <span className="channel-card__meta">
                      {channel.playabilityError ?? "Unavailable"}
                    </span>
                  ) : null}
                  <div className="channel-card__tags">
                    {isFavorite ? <span className="tag">Favorite</span> : null}
                    {isRecent ? <span className="tag">Recent</span> : null}
                    {guide ? (
                      <span className={`tag ${guide.matchSource === "manual" ? "tag--active" : ""}`}>
                        {guide.matchSource === "manual" ? "Guide matched" : "Guide"}
                      </span>
                    ) : null}
                    {!channel.isPlayable ? <span className="tag tag--danger">Unavailable</span> : null}
                  </div>
                  {guide?.current ? (
                    <div className="channel-guide">
                      <span className="channel-guide__eyebrow">
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
                </button>

                <button
                  type="button"
                  className={`favorite-toggle ${isFavorite ? "favorite-toggle--active" : ""}`}
                  onClick={() => onToggleFavorite(channel.id)}
                  aria-label={isFavorite ? `Remove ${channel.name} from favorites` : `Add ${channel.name} to favorites`}
                >
                  Fav
                </button>
                <button
                  type="button"
                  className={`favorite-toggle ${guide ? "favorite-toggle--active" : ""}`}
                  onClick={() => onOpenEpgMatcher(channel)}
                  disabled={!canMatchEpg}
                  title={guide ? "Change EPG match" : "Add EPG match"}
                  aria-label={guide ? `Change EPG match for ${channel.name}` : `Add EPG match for ${channel.name}`}
                >
                  EPG
                </button>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
