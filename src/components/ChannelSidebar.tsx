interface ChannelSidebarProps {
  playlistName: string | null;
  enabledGroups: string[];
  isFavoritesActive: boolean;
  activeGroup: string | null;
  favoritesCount: number;
  channelCountByGroup: Record<string, number>;
  groupsCollapsed: boolean;
  message: string | null;
  onSelectFavorites: () => void;
  onSelectGroup: (group: string) => void;
  onToggleGroupsCollapsed: () => void;
  onOpenSettings: () => void;
}

export function ChannelSidebar({
  playlistName,
  enabledGroups,
  isFavoritesActive,
  activeGroup,
  favoritesCount,
  channelCountByGroup,
  groupsCollapsed,
  message,
  onSelectFavorites,
  onSelectGroup,
  onToggleGroupsCollapsed,
  onOpenSettings,
}: ChannelSidebarProps) {
  const hasPlaylist = playlistName !== null;

  return (
    <aside className="panel sidebar">
      <div className="sidebar__header">
        <div className="sidebar__summary">
          <div className="sidebar__title-row">
            <span className="sidebar__eyebrow">Library</span>
            <span className="sidebar__meta">
              {hasPlaylist ? `${enabledGroups.length + 1} groups` : "Open settings"}
            </span>
          </div>
          {!hasPlaylist ? <h2>No library loaded</h2> : null}
        </div>

        <button
          type="button"
          className="settings-button"
          onClick={onOpenSettings}
          aria-label="Open settings"
        >
          <span aria-hidden="true">⚙</span>
        </button>
      </div>

      <div className="group-list">
        {!hasPlaylist ? (
          <div className="empty-state">
            <strong>Nothing loaded yet</strong>
            <span>Your sources stay local and are managed from Settings.</span>
          </div>
        ) : null}

        {hasPlaylist ? (
          <button
            type="button"
            className={`group-card group-card--source ${groupsCollapsed ? "group-card--source-collapsed" : ""}`}
            onClick={onToggleGroupsCollapsed}
          >
            <span className="group-card__name">{playlistName}</span>
            <span className="group-card__count">
              {groupsCollapsed ? "Expand groups" : "Collapse groups"}
            </span>
          </button>
        ) : null}

        {hasPlaylist && !groupsCollapsed ? (
          <button
            type="button"
            className={`group-card ${isFavoritesActive ? "group-card--active" : ""}`}
            onClick={onSelectFavorites}
          >
            <span className="group-card__name">Favorites</span>
            <span className="group-card__count">{favoritesCount} channels</span>
          </button>
        ) : null}

        {hasPlaylist && !groupsCollapsed && enabledGroups.length === 0 ? (
          <div className="empty-state">
            <strong>No regular groups are enabled</strong>
            <span>Favorites stay pinned first. Open Settings to turn other groups back on.</span>
          </div>
        ) : null}

        {!groupsCollapsed &&
          enabledGroups.map((group) => {
          const isActive = activeGroup === group;

          return (
            <button
              key={group}
              type="button"
              className={`group-card ${isActive ? "group-card--active" : ""}`}
              onClick={() => onSelectGroup(group)}
            >
              <span className="group-card__name">{group}</span>
              <span className="group-card__count">{channelCountByGroup[group] ?? 0} channels</span>
            </button>
          );
        })}
      </div>

      {message ? <div className="sidebar__notice">{message}</div> : null}
    </aside>
  );
}
