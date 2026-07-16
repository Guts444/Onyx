import { useState } from "react";
import type { EpgDirectoryResponse, EpgSource } from "../domain/epg";
import type { PlaylistImport } from "../domain/iptv";
import type { SavedPlaylistSource, SavedXtreamSource } from "../domain/sourceProfiles";
import type { VodKind } from "../domain/vod";
import { EpgSettingsPanel } from "./EpgSettingsPanel";
import { GeneralSettingsPanel, type AutoResumeMode } from "./GeneralSettingsPanel";
import { SourceProfilesPanel } from "./SourceProfilesPanel";
import { VodCategorySettingsPanel } from "./VodCategorySettingsPanel";

export type SettingsTab = "general" | "library" | "epg" | "sources";

interface SettingsDrawerProps {
  isOpen: boolean;
  activeTab: SettingsTab;
  playlist: PlaylistImport | null;
  playlistDisplayName: string | null;
  channelCountByGroup: Record<string, number>;
  enabledGroups: string[];
  hiddenGroups: string[];
  epgSources: EpgSource[];
  epgDirectoriesBySourceId: Record<string, EpgDirectoryResponse>;
  matchedEpgChannelCount: number;
  updatingEpgSourceIds: string[];
  epgStatusMessage: string | null;
  savedSources: SavedPlaylistSource[];
  activeSourceId: string | null;
  collapsedSourceIds: string[];
  loadingSourceId: string | null;
  isImportingFile: boolean;
  notice: string | null;
  autoResumeMode: AutoResumeMode;
  vodSources: SavedXtreamSource[];
  preferredVodSourceId: string | null;
  onClose: () => void;
  onSelectTab: (tab: SettingsTab) => void;
  onAutoResumeModeChange: (mode: AutoResumeMode) => void;
  onEnableAllGroups: () => void;
  onDisableAllGroups: () => void;
  onToggleGroup: (group: string) => void;
  getHiddenVodCategoryIds: (sourceId: string, kind: VodKind) => string[];
  onChangeHiddenVodCategoryIds: (sourceId: string, kind: VodKind, ids: string[]) => void;
  onAddEpgSource: () => void;
  onToggleEpgSourceEnabled: (sourceId: string) => void;
  onRemoveEpgSource: (sourceId: string) => void;
  onUpdateEpgSource: (sourceId: string, patch: Partial<EpgSource>) => void;
  onApplyEpgSourceUrl: (sourceId: string, draft: string) => Promise<boolean>;
  onRefreshEpgSource: (sourceId: string) => void;
  onRefreshEnabledEpgSources: () => void;
  onAddM3uProfile: () => void;
  onAddXtreamProfile: () => void;
  onImportFile: (file: File) => void;
  onToggleSourceCollapsed: (sourceId: string) => void;
  onToggleSourceEnabled: (sourceId: string) => void;
  onLoadSource: (sourceId: string) => void;
  onRemoveSource: (sourceId: string) => void;
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
  epgSources,
  epgDirectoriesBySourceId,
  matchedEpgChannelCount,
  updatingEpgSourceIds,
  epgStatusMessage,
  savedSources,
  activeSourceId,
  collapsedSourceIds,
  loadingSourceId,
  isImportingFile,
  notice,
  autoResumeMode,
  vodSources,
  preferredVodSourceId,
  onClose,
  onSelectTab,
  onAutoResumeModeChange,
  onEnableAllGroups,
  onDisableAllGroups,
  onToggleGroup,
  getHiddenVodCategoryIds,
  onChangeHiddenVodCategoryIds,
  onAddEpgSource,
  onToggleEpgSourceEnabled,
  onRemoveEpgSource,
  onUpdateEpgSource,
  onApplyEpgSourceUrl,
  onRefreshEpgSource,
  onRefreshEnabledEpgSources,
  onAddM3uProfile,
  onAddXtreamProfile,
  onImportFile,
  onToggleSourceCollapsed,
  onToggleSourceEnabled,
  onLoadSource,
  onRemoveSource,
  onUpdateSource,
}: SettingsDrawerProps) {
  const [groupSearchQuery, setGroupSearchQuery] = useState("");
  const [librarySection, setLibrarySection] = useState<"live" | VodKind>("live");
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
            <h2 id="settings-title">
              {activeTab === "general"
                ? "General"
                : activeTab === "library"
                ? "Library"
                : activeTab === "epg"
                ? "EPG"
                : "Saved Sources"}
            </h2>
            <p>
              {activeTab === "general"
                ? "Choose how Onyx behaves when it reopens a channel that was playing."
                : activeTab === "library"
                ? `Choose which groups should appear in the main channel browser for ${playlistDisplayName ?? "the current library"}.`
                : activeTab === "epg"
                ? "Guide data is cached locally per XMLTV source, and enabled guides are merged together when you match channels."
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
            className={`chip ${activeTab === "general" ? "chip--active" : ""}`}
            onClick={() => onSelectTab("general")}
          >
            General
          </button>
          <button
            type="button"
            className={`chip ${activeTab === "library" ? "chip--active" : ""}`}
            onClick={() => onSelectTab("library")}
          >
            Library
          </button>
          <button
            type="button"
            className={`chip ${activeTab === "epg" ? "chip--active" : ""}`}
            onClick={() => onSelectTab("epg")}
          >
            EPG
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

        {activeTab === "general" ? (
          <GeneralSettingsPanel
            autoResumeMode={autoResumeMode}
            onAutoResumeModeChange={onAutoResumeModeChange}
          />
        ) : activeTab === "library" ? (
          <>
            <div className="settings-tabs settings-tabs--secondary" aria-label="Library type">
              <button type="button" className={`chip ${librarySection === "live" ? "chip--active" : ""}`} onClick={() => setLibrarySection("live")}>Live TV</button>
              <button type="button" className={`chip ${librarySection === "movie" ? "chip--active" : ""}`} onClick={() => setLibrarySection("movie")}>Movies</button>
              <button type="button" className={`chip ${librarySection === "series" ? "chip--active" : ""}`} onClick={() => setLibrarySection("series")}>TV Shows</button>
            </div>
            {librarySection === "live" ? (
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
                        aria-label={isEnabled ? `Hide group ${group}` : `Enable group ${group}`}
                      >
                        {isEnabled ? "Enabled" : "Hidden"}
                      </button>
                    </article>
                  );
                })}
              </div>
            </>
          )) : (
            <VodCategorySettingsPanel
              kind={librarySection}
              sources={vodSources}
              preferredSourceId={preferredVodSourceId}
              getHiddenCategoryIds={getHiddenVodCategoryIds}
              onChangeHiddenCategoryIds={onChangeHiddenVodCategoryIds}
            />
          )}
          </>
        ) : activeTab === "epg" ? (
          <EpgSettingsPanel
            sources={epgSources}
            directoriesBySourceId={epgDirectoriesBySourceId}
            matchedChannelCount={matchedEpgChannelCount}
            updatingSourceIds={updatingEpgSourceIds}
            statusMessage={epgStatusMessage}
            onAddSource={onAddEpgSource}
            onToggleSourceEnabled={onToggleEpgSourceEnabled}
            onRemoveSource={onRemoveEpgSource}
            onUpdateSource={onUpdateEpgSource}
            onApplySourceUrl={onApplyEpgSourceUrl}
            onRefreshSource={onRefreshEpgSource}
            onRefreshEnabledSources={onRefreshEnabledEpgSources}
          />
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
            onRemoveSource={onRemoveSource}
            onUpdateSource={onUpdateSource}
          />
        )}
      </section>
    </div>
  );
}
