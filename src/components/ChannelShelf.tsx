import type { Channel, LibraryView } from "../domain/iptv";

interface ChannelShelfProps {
  activeGroupLabel: string | null;
  isFavoritesGroup: boolean;
  channels: Channel[];
  selectedChannelId: string | null;
  activeView: LibraryView;
  searchQuery: string;
  favoriteIds: string[];
  recentIds: string[];
  onSearchChange: (value: string) => void;
  onSelectView: (view: LibraryView) => void;
  onSelectChannel: (channel: Channel) => void;
  onToggleFavorite: (channelId: string) => void;
}

export function ChannelShelf({
  activeGroupLabel,
  isFavoritesGroup,
  channels,
  selectedChannelId,
  activeView,
  searchQuery,
  favoriteIds,
  recentIds,
  onSearchChange,
  onSelectView,
  onSelectChannel,
  onToggleFavorite,
}: ChannelShelfProps) {
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
            const isFavorite = favoriteIds.includes(channel.id);
            const isRecent = recentIds.includes(channel.id);
            const isSelected = selectedChannelId === channel.id;

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
                    {!channel.isPlayable ? <span className="tag tag--danger">Unavailable</span> : null}
                  </div>
                </button>

                <button
                  type="button"
                  className={`favorite-toggle ${isFavorite ? "favorite-toggle--active" : ""}`}
                  onClick={() => onToggleFavorite(channel.id)}
                >
                  Fav
                </button>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
