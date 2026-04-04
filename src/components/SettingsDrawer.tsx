import { useState } from "react";
import type { PlaylistImport } from "../domain/iptv";
import type { SavedPlaylistSource } from "../domain/sourceProfiles";
import { SourceProfilesPanel } from "./SourceProfilesPanel";

export type SettingsTab = "library" | "sources";

interface SettingsDrawerProps {
  isOpen: boolean;
  activeTab: SettingsTab;
  playlist: PlaylistImport | null;
  playlistDisplayName: string | null;
  channelCountByGroup: Record<string, number>;
  enabledGroups: string[];
  hiddenGroups: string[];
  savedSources: SavedPlaylistSource[];
  activeSourceId: string | null;
  collapsedSourceIds: string[];
  loadingSourceId: string | null;
  isImportingFile: boolean;
  notice: string | null;
  onClose: () => void;
  onSelectTab: (tab: SettingsTab) => void;
  onEnableAllGroups: () => void;
  onDisableAllGroups: () => void;
  onToggleGroup: (group: string) => void;
  onAddM3uProfile: () => void;
  onAddXtreamProfile: () => void;
  onImportFile: (file: File) => void;
  onToggleSourceCollapsed: (sourceId: string) => void;
  onToggleSourceEnabled: (sourceId: string) => void;
  onLoadSource: (sourceId: string) => void;
  onUpdateSource: (sourceId: string, patch: Partial<SavedPlaylistSource>) => void;
}

export function SettingsDrawer({
  isOpen,
  activeTab,
  playlist,
  playlistDisplayName,
  channelCountByGroup,
  enabledGroups,
  hiddenGroups,
  savedSources,
  activeSourceId,
  collapsedSourceIds,
  loadingSourceId,
  isImportingFile,
  notice,
  onClose,
  onSelectTab,
  onEnableAllGroups,
  onDisableAllGroups,
  onToggleGroup,
  onAddM3uProfile,
  onAddXtreamProfile,
  onImportFile,
  onToggleSourceCollapsed,
  onToggleSourceEnabled,
  onLoadSource,
  onUpdateSource,
}: SettingsDrawerProps) {
  const [groupSearchQuery, setGroupSearchQuery] = useState("");
  const groups = playlist?.groups ?? [];
  const normalizedGroupSearchQuery = groupSearchQuery.trim().toLowerCase();
  const filteredGroups = groups.filter((group) =>
    group.toLowerCase().includes(normalizedGroupSearchQuery),
  );

  if (!isOpen) {
    return null;
  }

  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <section
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-drawer__header">
          <div>
            <span className="settings-drawer__eyebrow">Settings</span>
            <h2 id="settings-title">{activeTab === "library" ? "Library" : "Saved Sources"}</h2>
            <p>
              {activeTab === "library"
                ? `Choose which groups should appear in the main channel browser for ${playlistDisplayName ?? "the current library"}.`
                : "Saved source details stay local on this machine so you can reopen the app without typing them again."}
            </p>
          </div>

          <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </header>

        <div className="settings-tabs">
          <button
            type="button"
            className={`chip ${activeTab === "library" ? "chip--active" : ""}`}
            onClick={() => onSelectTab("library")}
          >
            Library
          </button>
          <button
            type="button"
            className={`chip ${activeTab === "sources" ? "chip--active" : ""}`}
            onClick={() => onSelectTab("sources")}
          >
            Sources
          </button>
        </div>

        {notice ? <div className="settings-notice">{notice}</div> : null}

        {activeTab === "library" ? (
          !playlist ? (
            <div className="settings-empty">
              <strong>No library loaded</strong>
              <span>Import a playlist first, then you can manage which groups appear in the sidebar.</span>
            </div>
          ) : (
            <>
              <div className="settings-toolbar">
                <div className="settings-toolbar__stats">
                  <div className="settings-stat">
                    <strong>{playlist.channels.length}</strong>
                    <span>Channels</span>
                  </div>
                  <div className="settings-stat">
                    <strong>{enabledGroups.length}</strong>
                    <span>Visible groups</span>
                  </div>
                  <div className="settings-stat">
                    <strong>{hiddenGroups.length}</strong>
                    <span>Hidden groups</span>
                  </div>
                  <div className="settings-stat">
                    <strong>{playlist.disabledChannelCount}</strong>
                    <span>Unavailable</span>
                  </div>
                </div>
              </div>

              <div className="settings-toolbar settings-toolbar--controls">
                <label className="settings-group-search">
                  <input
                    type="search"
                    value={groupSearchQuery}
                    onChange={(event) => setGroupSearchQuery(event.currentTarget.value)}
                    placeholder="Search groups"
                  />
                </label>

                <div className="settings-toolbar__actions">
                  <button type="button" className="control-button" onClick={onEnableAllGroups}>
                    Enable all
                  </button>
                  <button type="button" className="control-button" onClick={onDisableAllGroups}>
                    Disable all
                  </button>
                </div>
              </div>

              <div className="settings-list">
                {filteredGroups.length === 0 ? (
                  <div className="settings-empty">
                    <strong>No groups match this search</strong>
                    <span>Try a different group name or clear the search box.</span>
                  </div>
                ) : null}

                {filteredGroups.map((group) => {
                  const isEnabled = !hiddenGroups.includes(group);

                  return (
                    <article key={group} className="settings-list__item">
                      <div className="settings-list__copy">
                        <strong>{group}</strong>
                        <span>{channelCountByGroup[group] ?? 0} channels</span>
                      </div>

                      <button
                        type="button"
                        className={`visibility-toggle ${isEnabled ? "visibility-toggle--enabled" : ""}`}
                        onClick={() => onToggleGroup(group)}
                      >
                        {isEnabled ? "Enabled" : "Hidden"}
                      </button>
                    </article>
                  );
                })}
              </div>
            </>
          )
        ) : (
          <SourceProfilesPanel
            sources={savedSources}
            activeSourceId={activeSourceId}
            collapsedSourceIds={collapsedSourceIds}
            loadingSourceId={loadingSourceId}
            isImportingFile={isImportingFile}
            onAddM3uProfile={onAddM3uProfile}
            onAddXtreamProfile={onAddXtreamProfile}
            onImportFile={onImportFile}
            onToggleCollapsed={onToggleSourceCollapsed}
            onToggleEnabled={onToggleSourceEnabled}
            onLoadSource={onLoadSource}
            onUpdateSource={onUpdateSource}
          />
        )}
      </section>
    </div>
  );
}
