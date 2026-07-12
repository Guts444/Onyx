import { useState } from "react";
import {
  EPG_AUTO_UPDATE_OPTIONS,
  getEpgSourceLabel,
  isEpgSourceReady,
  type EpgDirectoryResponse,
  type EpgSource,
} from "../domain/epg";

import {
  formatEpgDirectoryDiagnostics,
  sanitizeEpgSourceLabel,
} from "../features/epg/diagnostics";
import { editEpgUrlDraft } from "../features/epg/secrets";

interface EpgSettingsPanelProps {
  sources: EpgSource[];
  directoriesBySourceId: Record<string, EpgDirectoryResponse>;
  matchedChannelCount: number;
  updatingSourceIds: string[];
  statusMessage: string | null;
  onAddSource: () => void;
  onToggleSourceEnabled: (sourceId: string) => void;
  onRemoveSource: (sourceId: string) => void;
  onUpdateSource: (sourceId: string, patch: Partial<EpgSource>) => void;
  onApplySourceUrl: (sourceId: string, draft: string) => Promise<boolean>;
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
  directoriesBySourceId,
  matchedChannelCount,
  updatingSourceIds,
  statusMessage,
  onAddSource,
  onToggleSourceEnabled,
  onRemoveSource,
  onUpdateSource,
  onApplySourceUrl,
  onRefreshSource,
  onRefreshEnabledSources,
}: EpgSettingsPanelProps) {
  const enabledSources = sources.filter((source) => source.enabled);
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string>>({});
  const [applyingSourceIds, setApplyingSourceIds] = useState<string[]>([]);

  async function applySourceUrl(sourceId: string, draft: string) {
    if (applyingSourceIds.includes(sourceId)) return;
    setApplyingSourceIds((current) => [...current, sourceId]);
    try {
      const applied = await onApplySourceUrl(sourceId, draft);
      if (applied) {
        setUrlDrafts((current) => ({
          ...current,
          [sourceId]: draft.trim().replace(/^xmltv\s*:\s*/i, ""),
        }));
      }
    } finally {
      setApplyingSourceIds((current) => current.filter((id) => id !== sourceId));
    }
  }

  let enabledGuideChannelCount = 0;
  let enabledProgrammeCount = 0;
  let latestEnabledGuideUpdateAt: string | null = null;

  for (const source of enabledSources) {
    if (!isEpgSourceReady(source)) {
      continue;
    }

    const directory = directoriesBySourceId[source.id];

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
            disabled={!enabledSources.some(isEpgSourceReady) || isUpdatingAny}
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
            const directory = directoriesBySourceId[source.id] ?? null;
            const isReady = isEpgSourceReady(source);
            const isUpdating = updatingSourceIds.includes(source.id);
            const isApplying = applyingSourceIds.includes(source.id);
            const urlDraft = Object.prototype.hasOwnProperty.call(urlDrafts, source.id)
              ? urlDrafts[source.id]
              : source.url;
            const directoryDiagnostics = directory
              ? formatEpgDirectoryDiagnostics(directory)
              : "";

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
                        {sanitizeEpgSourceLabel(getEpgSourceLabel(source))}
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
                    {directoryDiagnostics ? (
                      <span className="source-card__summary-meta">{directoryDiagnostics}</span>
                    ) : null}
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
                    type="text"
                    inputMode="url"
                    value={urlDraft}
                    onChange={(event) => setUrlDrafts((current) =>
                      editEpgUrlDraft(current, source.id, event.currentTarget.value),
                    )}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !isApplying) {
                        event.preventDefault();
                        void applySourceUrl(source.id, urlDraft);
                      }
                    }}
                    placeholder="https://provider.example/guide.xml.gz"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`EPG URL for ${sanitizeEpgSourceLabel(getEpgSourceLabel(source))}`}
                  />
                  <button
                    type="button"
                    className="control-button"
                    onClick={() => { void applySourceUrl(source.id, urlDraft); }}
                    disabled={isApplying || urlDraft === source.url}
                    aria-label={`Apply EPG URL for ${sanitizeEpgSourceLabel(getEpgSourceLabel(source))}`}
                  >
                    {isApplying ? "Applying..." : "Apply URL"}
                  </button>
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
