import {
  EPG_AUTO_UPDATE_OPTIONS,
  getEpgSourceLabel,
  isEpgSourceReady,
  type EpgDirectoryResponse,
  type EpgSource,
} from "../domain/epg";
import { normalizeEpgUrlKey } from "../features/epg/matching";

interface EpgSettingsPanelProps {
  sources: EpgSource[];
  directoriesByUrlKey: Record<string, EpgDirectoryResponse>;
  matchedChannelCount: number;
  updatingSourceIds: string[];
  statusMessage: string | null;
  onAddSource: () => void;
  onToggleSourceEnabled: (sourceId: string) => void;
  onRemoveSource: (sourceId: string) => void;
  onUpdateSource: (sourceId: string, patch: Partial<EpgSource>) => void;
  onRefreshSource: (sourceId: string) => void;
  onRefreshEnabledSources: () => void;
}

function formatUpdatedAt(value: string | null) {
  if (!value) {
    return "Not updated yet";
  }

  return new Date(value).toLocaleString();
}

export function EpgSettingsPanel({
  sources,
  directoriesByUrlKey,
  matchedChannelCount,
  updatingSourceIds,
  statusMessage,
  onAddSource,
  onToggleSourceEnabled,
  onRemoveSource,
  onUpdateSource,
  onRefreshSource,
  onRefreshEnabledSources,
}: EpgSettingsPanelProps) {
  const enabledSources = sources.filter((source) => source.enabled);
  const uniqueEnabledGuideKeys = new Set<string>();
  let enabledGuideChannelCount = 0;
  let enabledProgrammeCount = 0;
  let latestEnabledGuideUpdateAt: string | null = null;

  for (const source of enabledSources) {
    if (!isEpgSourceReady(source)) {
      continue;
    }

    const urlKey = normalizeEpgUrlKey(source.url);

    if (!urlKey || uniqueEnabledGuideKeys.has(urlKey)) {
      continue;
    }

    uniqueEnabledGuideKeys.add(urlKey);

    const directory = directoriesByUrlKey[urlKey];

    if (!directory) {
      continue;
    }

    enabledGuideChannelCount += directory.channelCount;
    enabledProgrammeCount += directory.programmeCount;

    if (
      !latestEnabledGuideUpdateAt ||
      new Date(directory.fetchedAt).getTime() > new Date(latestEnabledGuideUpdateAt).getTime()
    ) {
      latestEnabledGuideUpdateAt = directory.fetchedAt;
    }
  }

  const isUpdatingAny = updatingSourceIds.length > 0;

  return (
    <div className="sources-panel epg-panel">
      <div className="settings-toolbar">
        <div className="settings-toolbar__summary">
          <div className="settings-toolbar__stats">
            <div className="settings-stat">
              <strong>{sources.length}</strong>
              <span>Guides</span>
            </div>
            <div className="settings-stat">
              <strong>{enabledSources.length}</strong>
              <span>Enabled</span>
            </div>
            <div className="settings-stat">
              <strong>{enabledGuideChannelCount}</strong>
              <span>Guide channels</span>
            </div>
            <div className="settings-stat">
              <strong>{enabledProgrammeCount}</strong>
              <span>Programmes</span>
            </div>
            <div className="settings-stat">
              <strong>{matchedChannelCount}</strong>
              <span>Matched now</span>
            </div>
          </div>

          <div className="settings-toolbar__meta">
            <span>Latest enabled update</span>
            <strong>{formatUpdatedAt(latestEnabledGuideUpdateAt)}</strong>
          </div>
        </div>

        <div className="settings-toolbar__actions">
          <button type="button" className="control-button" onClick={onAddSource}>
            Add EPG URL
          </button>
          <button
            type="button"
            className="control-button"
            onClick={onRefreshEnabledSources}
            disabled={uniqueEnabledGuideKeys.size === 0 || isUpdatingAny}
          >
            {isUpdatingAny ? "Updating..." : "Update Enabled"}
          </button>
        </div>
      </div>

      {statusMessage ? <div className="settings-notice">{statusMessage}</div> : null}

      {sources.length === 0 ? (
        <div className="settings-empty">
          <strong>No EPG guides configured yet</strong>
          <span>Add one or more XMLTV URLs, then enable the guides you want available for channel matching.</span>
        </div>
      ) : (
        <div className="settings-list">
          {sources.map((source) => {
            const urlKey = normalizeEpgUrlKey(source.url);
            const directory = urlKey ? directoriesByUrlKey[urlKey] ?? null : null;
            const isReady = isEpgSourceReady(source);
            const isUpdating = updatingSourceIds.includes(source.id);

            return (
              <article key={source.id} className="source-card">
                <div className="source-card__header">
                  <div className="source-card__summary epg-source-card__summary">
                    <div className="source-card__badges">
                      <span className="tag">XMLTV</span>
                      {!source.enabled ? <span className="tag tag--danger">Disabled</span> : null}
                      {directory ? <span className="tag tag--active">Cached</span> : null}
                    </div>

                    <div className="source-card__summary-row">
                      <span className="source-card__summary-name">
                        {getEpgSourceLabel(source)}
                      </span>
                    </div>

                    <span className="source-card__summary-meta">
                      {formatUpdatedAt(directory?.fetchedAt ?? null)}
                    </span>
                    <span className="source-card__summary-meta">
                      {directory
                        ? `${directory.channelCount} guide channels and ${directory.programmeCount} programmes cached locally.`
                        : "Update this guide once to cache it locally for matching and now/next data."}
                    </span>
                  </div>

                  <div className="source-card__actions">
                    <button
                      type="button"
                      className={`visibility-toggle ${source.enabled ? "visibility-toggle--enabled" : ""}`}
                      onClick={() => onToggleSourceEnabled(source.id)}
                    >
                      {source.enabled ? "Enabled" : "Disabled"}
                    </button>
                    <button
                      type="button"
                      className="control-button"
                      onClick={() => onRefreshSource(source.id)}
                      disabled={!isReady || isUpdating}
                    >
                      {isUpdating ? "Updating..." : "Update Now"}
                    </button>
                    <button
                      type="button"
                      className="control-button"
                      onClick={() => onRemoveSource(source.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="source-card__fields source-card__fields--single">
                  <input
                    type="url"
                    value={source.url}
                    onChange={(event) =>
                      onUpdateSource(source.id, {
                        url: event.currentTarget.value,
                      })
                    }
                    placeholder="https://provider.example/guide.xml.gz"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="epg-settings-grid">
                  <div className="epg-options-card">
                    <div className="epg-options-card__copy">
                      <strong>Auto update</strong>
                      <span>Refresh this guide on a timer while Onyx stays open.</span>
                    </div>

                    <button
                      type="button"
                      className={`visibility-toggle ${source.autoUpdateEnabled ? "visibility-toggle--enabled" : ""}`}
                      onClick={() =>
                        onUpdateSource(source.id, {
                          autoUpdateEnabled: !source.autoUpdateEnabled,
                        })
                      }
                    >
                      {source.autoUpdateEnabled ? "Enabled" : "Disabled"}
                    </button>
                  </div>

                  <label className="settings-field">
                    <span className="settings-field__label">Update interval</span>
                    <select
                      value={source.updateIntervalHours}
                      onChange={(event) =>
                        onUpdateSource(source.id, {
                          updateIntervalHours: Number(event.currentTarget.value),
                        })
                      }
                      disabled={!source.autoUpdateEnabled}
                    >
                      {EPG_AUTO_UPDATE_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          Every {option} hours
                        </option>
                      ))}
                    </select>
                    <span className="settings-field__hint">
                      Stored per guide, so each country or provider feed can refresh on its own schedule.
                    </span>
                  </label>

                  <div className="epg-options-card">
                    <div className="epg-options-card__copy">
                      <strong>Update on startup</strong>
                      <span>Refresh this enabled guide once when the app opens.</span>
                    </div>

                    <button
                      type="button"
                      className={`visibility-toggle ${source.updateOnStartup ? "visibility-toggle--enabled" : ""}`}
                      onClick={() =>
                        onUpdateSource(source.id, {
                          updateOnStartup: !source.updateOnStartup,
                        })
                      }
                    >
                      {source.updateOnStartup ? "Enabled" : "Disabled"}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
