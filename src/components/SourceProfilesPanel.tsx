import type { SavedPlaylistSource } from "../domain/sourceProfiles";
import { isSourceProfileReady } from "../features/sources/profiles";

interface SourceProfilesPanelProps {
  sources: SavedPlaylistSource[];
  activeSourceId: string | null;
  collapsedSourceIds: string[];
  loadingSourceId: string | null;
  isImportingFile: boolean;
  onAddM3uProfile: () => void;
  onAddXtreamProfile: () => void;
  onImportFile: (file: File) => void;
  onToggleCollapsed: (sourceId: string) => void;
  onToggleEnabled: (sourceId: string) => void;
  onLoadSource: (sourceId: string) => void;
  onRemoveSource: (sourceId: string) => void;
  onUpdateSource: (sourceId: string, patch: Partial<SavedPlaylistSource>) => void;
}

function formatLastLoaded(lastLoadedAt: string | null) {
  if (!lastLoadedAt) {
    return "Not loaded yet";
  }

  const parsedDate = new Date(lastLoadedAt);
  return `Last loaded ${parsedDate.toLocaleString()}`;
}

export function SourceProfilesPanel({
  sources,
  activeSourceId,
  collapsedSourceIds,
  loadingSourceId,
  isImportingFile,
  onAddM3uProfile,
  onAddXtreamProfile,
  onImportFile,
  onToggleCollapsed,
  onToggleEnabled,
  onLoadSource,
  onRemoveSource,
  onUpdateSource,
}: SourceProfilesPanelProps) {
  return (
    <div className="sources-panel">
      <div className="settings-toolbar">
        <div className="settings-stat">
          <strong>{sources.length}</strong>
          <span>Saved sources</span>
        </div>
        <div className="settings-stat">
          <strong>{sources.filter((source) => source.enabled).length}</strong>
          <span>Enabled</span>
        </div>
        <div className="settings-toolbar__actions">
          <label className={`control-button source-import-button ${isImportingFile ? "source-import-button--busy" : ""}`}>
            <input
              type="file"
              accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];

                if (file) {
                  onImportFile(file);
                }

                event.currentTarget.value = "";
              }}
              disabled={isImportingFile}
            />
            {isImportingFile ? "Importing..." : "Import .m3u"}
          </label>
          <button type="button" className="control-button" onClick={onAddM3uProfile}>
            Add M3U URL
          </button>
          <button type="button" className="control-button" onClick={onAddXtreamProfile}>
            Add Xtream
          </button>
        </div>
      </div>

      {sources.length === 0 ? (
        <div className="settings-empty">
          <strong>No saved sources yet</strong>
          <span>Import a remote playlist once, or create a new source profile here.</span>
        </div>
      ) : (
        <div className="settings-list">
          {sources.map((source) => {
            const isActive = source.id === activeSourceId;
            const isCollapsed = collapsedSourceIds.includes(source.id);
            const isReady = isSourceProfileReady(source);
            const isLoading = loadingSourceId === source.id;
            const sourceLabel = source.name.trim().length > 0 ? source.name.trim() : "Untitled source";
            const toggleLabel = isCollapsed ? "Expand source" : "Collapse source";

            return (
              <article
                key={source.id}
                className={`source-card ${isCollapsed ? "source-card--collapsed" : ""}`}
              >
                <div className="source-card__header">
                  <button
                    type="button"
                    className="source-card__summary"
                    onClick={() => onToggleCollapsed(source.id)}
                    aria-expanded={!isCollapsed}
                    aria-label={`${toggleLabel}: ${sourceLabel}`}
                  >
                    <div className="source-card__badges">
                      <span className="tag">{source.kind === "xtream" ? "Xtream" : "M3U URL"}</span>
                      {isActive ? <span className="tag tag--active">Current</span> : null}
                      {!source.enabled ? <span className="tag tag--danger">Disabled</span> : null}
                    </div>

                    <div className="source-card__summary-row">
                      <span className="source-card__summary-name">
                        {sourceLabel}
                      </span>
                      <span className="source-card__toggle-icon" aria-hidden="true">
                        {isCollapsed ? "v" : "^"}
                      </span>
                    </div>

                    <span className="source-card__summary-meta">
                      {formatLastLoaded(source.lastLoadedAt)}
                    </span>
                  </button>

                  <div className="source-card__actions">
                    <button
                      type="button"
                      className={`visibility-toggle ${source.enabled ? "visibility-toggle--enabled" : ""}`}
                      onClick={() => onToggleEnabled(source.id)}
                      aria-label={`${source.enabled ? "Disable" : "Enable"} source ${sourceLabel}`}
                    >
                      {source.enabled ? "Enabled" : "Disabled"}
                    </button>
                    <button
                      type="button"
                      className="control-button"
                      onClick={() => onLoadSource(source.id)}
                      disabled={!isReady || isLoading}
                      aria-label={`Load source ${sourceLabel}`}
                    >
                      {isLoading ? "Loading..." : "Load Now"}
                    </button>
                    <button
                      type="button"
                      className="control-button control-button--danger"
                      onClick={() => onRemoveSource(source.id)}
                      aria-label={`Delete source ${sourceLabel}`}
                    >
                      Delete Source
                    </button>
                  </div>
                </div>

                {!isCollapsed && source.kind === "m3u_url" ? (
                  <div className="source-card__fields source-card__fields--single">
                    <input
                      type="text"
                      value={source.name}
                      onChange={(event) =>
                        onUpdateSource(source.id, {
                          name: event.currentTarget.value,
                        })
                      }
                      placeholder="Profile name"
                      aria-label={`Profile name for ${sourceLabel}`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <input
                      type="url"
                      value={source.url}
                      onChange={(event) =>
                        onUpdateSource(source.id, {
                          url: event.currentTarget.value,
                        } as Partial<SavedPlaylistSource>)
                      }
                      placeholder="Playlist URL"
                      aria-label={`Playlist URL for ${sourceLabel}`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                ) : null}

                {!isCollapsed && source.kind === "xtream" ? (
                  <div className="source-card__fields">
                    <input
                      type="text"
                      value={source.name}
                      onChange={(event) =>
                        onUpdateSource(source.id, {
                          name: event.currentTarget.value,
                        })
                      }
                      placeholder="Profile name"
                      aria-label={`Profile name for ${sourceLabel}`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <input
                      type="text"
                      value={source.domain}
                      onChange={(event) =>
                        onUpdateSource(source.id, {
                          domain: event.currentTarget.value,
                        } as Partial<SavedPlaylistSource>)
                      }
                      placeholder="Domain"
                      aria-label={`Domain for ${sourceLabel}`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <input
                      type="text"
                      value={source.username}
                      onChange={(event) =>
                        onUpdateSource(source.id, {
                          username: event.currentTarget.value,
                        } as Partial<SavedPlaylistSource>)
                      }
                      placeholder="Username"
                      aria-label={`Username for ${sourceLabel}`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <input
                      type="password"
                      value={source.password}
                      onChange={(event) =>
                        onUpdateSource(source.id, {
                          password: event.currentTarget.value,
                        } as Partial<SavedPlaylistSource>)
                      }
                      placeholder="Password"
                      aria-label={`Password for ${sourceLabel}`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
