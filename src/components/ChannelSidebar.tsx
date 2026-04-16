import type { Channel } from "../domain/iptv";

export type NavigationSection = "search" | "tv";

interface ChannelSidebarProps {
  showRail: boolean;
  navigationSection: NavigationSection;
  playlistName: string | null;
  enabledGroups: string[];
  isAllChannelsActive: boolean;
  isFavoritesActive: boolean;
  activeGroup: string | null;
  favoritesCount: number;
  allChannelCount: number;
  channelCountByGroup: Record<string, number>;
  searchQuery: string;
  searchResults: Channel[];
  selectedChannelId: string | null;
  favoriteIdSet: Set<string>;
  message: string | null;
  onSelectNavigationSection: (section: NavigationSection) => void;
  onSearchChange: (value: string) => void;
  onSelectChannel: (channel: Channel) => void;
  onSelectAllChannels: () => void;
  onSelectFavorites: () => void;
  onSelectGroup: (group: string) => void;
  onOpenSettings: () => void;
}

interface SidebarIconProps {
  type: "search" | "tv" | "settings";
}

function SidebarIcon({ type }: SidebarIconProps) {
  if (type === "search") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M15.5 15.5 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  if (type === "settings") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M19.4 13.5c.04-.49.04-.99 0-1.5l1.52-1.18a.9.9 0 0 0 .23-1.13l-1.44-2.5a.9.9 0 0 0-1.07-.42l-1.79.72a6.95 6.95 0 0 0-1.3-.75l-.27-1.89a.9.9 0 0 0-.89-.77h-2.88a.9.9 0 0 0-.89.77l-.27 1.89c-.45.18-.89.43-1.3.75l-1.79-.72a.9.9 0 0 0-1.07.42L3.85 9.7a.9.9 0 0 0 .23 1.13L5.6 12c-.04.51-.04 1.01 0 1.5l-1.52 1.18a.9.9 0 0 0-.23 1.13l1.44 2.5a.9.9 0 0 0 1.07.42l1.79-.72c.41.32.85.57 1.3.75l.27 1.89a.9.9 0 0 0 .89.77h2.88a.9.9 0 0 0 .89-.77l.27-1.89c.45-.18.89-.43 1.3-.75l1.79.72a.9.9 0 0 0 1.07-.42l1.44-2.5a.9.9 0 0 0-.23-1.13L19.4 13.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="12" rx="2.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8 19h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ChannelSidebar({
  showRail,
  navigationSection,
  playlistName,
  enabledGroups,
  isAllChannelsActive,
  isFavoritesActive,
  activeGroup,
  favoritesCount,
  allChannelCount,
  channelCountByGroup,
  searchQuery,
  searchResults,
  selectedChannelId,
  favoriteIdSet,
  message,
  onSelectNavigationSection,
  onSearchChange,
  onSelectChannel,
  onSelectAllChannels,
  onSelectFavorites,
  onSelectGroup,
  onOpenSettings,
}: ChannelSidebarProps) {
  const hasPlaylist = playlistName !== null;

  return (
    <aside className={`panel sidebar ${showRail ? "" : "sidebar--groups-only"}`}>
      {showRail ? (
        <nav className="sidebar__rail" aria-label="Primary navigation">
          <button
            type="button"
            className={`sidebar__rail-button ${
              navigationSection === "search" ? "sidebar__rail-button--active" : ""
            }`}
            onClick={() => onSelectNavigationSection("search")}
          >
            <SidebarIcon type="search" />
            <span>Search</span>
          </button>

          <button
            type="button"
            className={`sidebar__rail-button ${
              navigationSection === "tv" ? "sidebar__rail-button--active" : ""
            }`}
            onClick={() => onSelectNavigationSection("tv")}
          >
            <SidebarIcon type="tv" />
            <span>Live TV</span>
          </button>

          <button
            type="button"
            className="sidebar__rail-button"
            onClick={onOpenSettings}
          >
            <SidebarIcon type="settings" />
            <span>Settings</span>
          </button>
        </nav>
      ) : null}

      <div className="sidebar__panel">
        {navigationSection === "search" ? (
          <div className="sidebar__section">
            <header className="sidebar__section-header">
              <span className="sidebar__eyebrow">Search</span>
              <h2>Find channels</h2>
              <p>
                {hasPlaylist
                  ? "Search across the loaded source, then jump straight into the guide."
                  : "Load a source first, then search for channels here."}
              </p>
            </header>

            {hasPlaylist ? (
              <label className="sidebar__search-field">
                <span className="sidebar__search-label">Channel search</span>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => onSearchChange(event.currentTarget.value)}
                  placeholder="Search all channels"
                />
              </label>
            ) : null}

            {!hasPlaylist ? (
              <div className="empty-state">
                <strong>No source loaded</strong>
                <span>Open Settings to add an M3U or Xtream source, then return here to search.</span>
              </div>
            ) : searchQuery.trim().length === 0 ? (
              <div className="empty-state">
                <strong>Type to search</strong>
                <span>Results update as you type so you can jump straight into the guide.</span>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="empty-state">
                <strong>No channels match this search</strong>
                <span>Try a different channel name, provider label, or a shorter search term.</span>
              </div>
            ) : (
              <div className="sidebar__result-list">
                {searchResults.map((channel) => {
                  const isSelected = selectedChannelId === channel.id;
                  const isFavorite = favoriteIdSet.has(channel.id);

                  return (
                    <button
                      key={channel.id}
                      type="button"
                      className={`sidebar__result-card ${isSelected ? "sidebar__result-card--active" : ""}`}
                      onClick={() => onSelectChannel(channel)}
                    >
                      <span className="sidebar__result-name">{channel.name}</span>
                      <span className="sidebar__result-meta">{channel.group}</span>
                      {isFavorite ? <span className="tag">Favorite</span> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="sidebar__section">
            <header className="sidebar__section-header">
              <span className="sidebar__eyebrow">Live TV</span>
              <h2>{playlistName ?? "No source loaded"}</h2>
              <p>
                {hasPlaylist
                  ? `${enabledGroups.length} groups ready in the guide.`
                  : "Open Settings to add a source and start browsing live channels."}
              </p>
            </header>

            {!hasPlaylist ? (
              <div className="empty-state">
                <strong>Nothing loaded yet</strong>
                <span>Your saved sources stay local. Add one from Settings to build the guide.</span>
              </div>
            ) : (
              <div className="sidebar__group-list">
                <button
                  type="button"
                  className={`sidebar__group-card ${
                    isAllChannelsActive ? "sidebar__group-card--active" : ""
                  }`}
                  onClick={onSelectAllChannels}
                >
                  <span className="sidebar__group-name">All channels</span>
                  <span className="sidebar__group-count">{allChannelCount} channels</span>
                </button>

                <button
                  type="button"
                  className={`sidebar__group-card ${
                    isFavoritesActive ? "sidebar__group-card--active" : ""
                  }`}
                  onClick={onSelectFavorites}
                >
                  <span className="sidebar__group-name">Favorites</span>
                  <span className="sidebar__group-count">{favoritesCount} channels</span>
                </button>

                {enabledGroups.map((group) => {
                  const isActive = activeGroup === group;

                  return (
                    <button
                      key={group}
                      type="button"
                      className={`sidebar__group-card ${isActive ? "sidebar__group-card--active" : ""}`}
                      onClick={() => onSelectGroup(group)}
                    >
                      <span className="sidebar__group-name">{group}</span>
                      <span className="sidebar__group-count">{channelCountByGroup[group] ?? 0} channels</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {message ? <div className="sidebar__notice">{message}</div> : null}
      </div>
    </aside>
  );
}
