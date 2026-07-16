import { useEffect, useRef } from "react";
import type { VodNavigationState } from "../domain/vod";

interface ChannelSidebarProps {
  activeSection: "live" | "movies" | "series";
  playlistName: string | null;
  enabledGroups: string[];
  isAllChannelsActive: boolean;
  isFavoritesActive: boolean;
  activeGroup: string | null;
  favoritesCount: number;
  allChannelCount: number;
  channelCountByGroup: Record<string, number>;
  searchQuery: string;
  message: string | null;
  vodNavigation: VodNavigationState | null;
  vodSourceName: string | null;
  onSearchChange: (value: string) => void;
  onSelectAllChannels: () => void;
  onSelectFavorites: () => void;
  onSelectGroup: (group: string) => void;
  onSelectSection: (section: "live" | "movies" | "series") => void;
  onVodSearchChange: (value: string) => void;
  onSelectVodCategory: (categoryId: string) => void;
  onOpenUserGuide: () => void;
  onOpenSettings: () => void;
}

interface SidebarIconProps {
  type: "tv" | "movie" | "series" | "guide" | "settings";
}

function SidebarIcon({ type }: SidebarIconProps) {
  if (type === "movie") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="m8 5 2.5 4M14 5l2.5 4M3.5 9h17" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="m10 12 5 2.5-5 2.5v-5Z" fill="currentColor" />
      </svg>
    );
  }

  if (type === "series") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="6" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="m9 3 3 3 3-3M7 10h7M7 14h5M17.5 11v3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === "guide") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4.5h10.5A3.5 3.5 0 0 1 19 8v11.5H8.5A3.5 3.5 0 0 1 5 16V4.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M8.5 19.5A3.5 3.5 0 0 1 12 16h7M9 8h6M9 11.5h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
  activeSection,
  playlistName,
  enabledGroups,
  isAllChannelsActive,
  isFavoritesActive,
  activeGroup,
  favoritesCount,
  allChannelCount,
  channelCountByGroup,
  searchQuery,
  message,
  vodNavigation,
  vodSourceName,
  onSearchChange,
  onSelectAllChannels,
  onSelectFavorites,
  onSelectGroup,
  onSelectSection,
  onVodSearchChange,
  onSelectVodCategory,
  onOpenUserGuide,
  onOpenSettings,
}: ChannelSidebarProps) {
  const hasPlaylist = playlistName !== null;
  const activeGroupRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const activeNavigationId = activeSection === "live" ? activeGroup : vodNavigation?.activeCategoryId;
    if (!activeNavigationId) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      activeGroupRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeGroup, activeSection, vodNavigation?.activeCategoryId]);

  return (
    <aside className="panel sidebar">
      <nav className="sidebar__rail" aria-label="Primary navigation">
          <button
            type="button"
            className={`sidebar__rail-button sidebar__rail-current ${activeSection === "live" ? "sidebar__rail-button--active" : ""}`}
            aria-current={activeSection === "live" ? "page" : undefined}
            onClick={() => onSelectSection("live")}
          >
            <SidebarIcon type="tv" />
            <span>Live TV</span>
          </button>

          <button
            type="button"
            className={`sidebar__rail-button ${activeSection === "movies" ? "sidebar__rail-button--active" : ""}`}
            aria-current={activeSection === "movies" ? "page" : undefined}
            onClick={() => onSelectSection("movies")}
          >
            <SidebarIcon type="movie" />
            <span>Movies</span>
          </button>

          <button
            type="button"
            className={`sidebar__rail-button ${activeSection === "series" ? "sidebar__rail-button--active" : ""}`}
            aria-current={activeSection === "series" ? "page" : undefined}
            onClick={() => onSelectSection("series")}
          >
            <SidebarIcon type="series" />
            <span>TV Shows</span>
          </button>

          <div className="sidebar__rail-spacer" />

          <button type="button" className="sidebar__rail-button" onClick={onOpenUserGuide}>
            <SidebarIcon type="guide" />
            <span>User Guide</span>
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

      <div className="sidebar__panel">
        {activeSection === "live" ? (
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

            {hasPlaylist ? (
              <label className="sidebar__search-field">
                <span className="sidebar__search-label">Search channels</span>
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
                <strong>Nothing loaded yet</strong>
                <span>Your saved sources stay local. Add one from Settings to build the guide.</span>
              </div>
            ) : (
              <div className="sidebar__group-list">
                <button
                  ref={isAllChannelsActive ? activeGroupRef : undefined}
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
                  ref={isFavoritesActive ? activeGroupRef : undefined}
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
                      ref={isActive ? activeGroupRef : undefined}
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

        ) : (
          <div className="sidebar__section">
            <header className="sidebar__section-header">
              <span className="sidebar__eyebrow">On Demand</span>
              <h2>{vodSourceName ?? (activeSection === "movies" ? "Movies" : "TV Shows")}</h2>
              <p>
                {vodNavigation?.categories.length ?? 0} groups available. Catalogs load one group at a time.
              </p>
            </header>

            <label className="sidebar__search-field">
              <span className="sidebar__search-label">Search {activeSection === "movies" ? "movies" : "TV shows"}</span>
              <input
                type="search"
                value={vodNavigation?.searchQuery ?? ""}
                onChange={(event) => onVodSearchChange(event.currentTarget.value)}
                placeholder="Search this group"
                disabled={!vodNavigation?.activeCategoryId}
              />
            </label>

            {vodNavigation?.loadingCategories ? (
              <div className="empty-state"><strong>Loading groups…</strong></div>
            ) : vodNavigation && vodNavigation.categories.length > 0 ? (
              <div className="sidebar__group-list">
                {vodNavigation.categories.map((category) => {
                  const isActive = category.id === vodNavigation.activeCategoryId;
                  return (
                    <button
                      key={category.id}
                      ref={isActive ? activeGroupRef : undefined}
                      type="button"
                      className={`sidebar__group-card ${isActive ? "sidebar__group-card--active" : ""}`}
                      onClick={() => onSelectVodCategory(category.id)}
                    >
                      <span className="sidebar__group-name">{category.name}</span>
                      <span className="sidebar__group-count">
                        {isActive && vodNavigation.activeCatalogCount > 0
                          ? `${vodNavigation.activeCatalogCount} titles`
                          : activeSection === "movies" ? "Movie group" : "TV show group"}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">
                <strong>No visible groups</strong>
                <span>Enable groups under Settings → Library.</span>
              </div>
            )}
          </div>
        )}

        {message ? <div className="sidebar__notice">{message}</div> : null}
      </div>
    </aside>
  );
}
