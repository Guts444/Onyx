import {
  EPG_AUTO_UPDATE_OPTIONS,
  type EpgDirectoryResponse,
  type EpgSettings,
} from "../domain/epg";

interface EpgSettingsPanelProps {
  settings: EpgSettings;
  epgDirectory: EpgDirectoryResponse | null;
  matchedChannelCount: number;
  isUpdating: boolean;
  statusMessage: string | null;
  onUpdateSettings: (patch: Partial<EpgSettings>) => void;
  onRefresh: () => void;
}

function formatUpdatedAt(value: string | null) {
  if (!value) {
    return "Not updated yet";
  }

  return new Date(value).toLocaleString();
}

export function EpgSettingsPanel({
  settings,
  epgDirectory,
  matchedChannelCount,
  isUpdating,
  statusMessage,
  onUpdateSettings,
  onRefresh,
}: EpgSettingsPanelProps) {
  const hasGuideUrl = settings.url.trim().length > 0;

  return (
    <div className="sources-panel epg-panel">
      <div className="settings-toolbar">
        <div className="settings-toolbar__stats">
          <div className="settings-stat">
            <strong>{epgDirectory?.channelCount ?? 0}</strong>
            <span>Guide channels</span>
          </div>
          <div className="settings-stat">
            <strong>{epgDirectory?.programmeCount ?? 0}</strong>
            <span>Programmes</span>
          </div>
          <div className="settings-stat">
            <strong>{matchedChannelCount}</strong>
            <span>Matched now</span>
          </div>
          <div className="settings-stat">
            <strong>{formatUpdatedAt(epgDirectory?.fetchedAt ?? null)}</strong>
            <span>Last update</span>
          </div>
        </div>

        <div className="settings-toolbar__actions">
          <button
            type="button"
            className="control-button"
            onClick={onRefresh}
            disabled={!hasGuideUrl || isUpdating}
          >
            {isUpdating ? "Updating..." : "Update Now"}
          </button>
        </div>
      </div>

      {statusMessage ? <div className="settings-notice">{statusMessage}</div> : null}

      <div className="epg-settings-grid">
        <label className="settings-field">
          <span className="settings-field__label">EPG URL</span>
          <input
            type="url"
            value={settings.url}
            onChange={(event) =>
              onUpdateSettings({
                url: event.currentTarget.value,
              })
            }
            placeholder="https://provider.example/guide.xml.gz"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="settings-field__hint">
            XMLTV URLs are supported, including compressed `.xml.gz` feeds.
          </span>
        </label>

        <div className="epg-options-card">
          <div className="epg-options-card__copy">
            <strong>Auto update</strong>
            <span>Refresh the saved guide on a timer while the app stays open.</span>
          </div>

          <button
            type="button"
            className={`visibility-toggle ${settings.autoUpdateEnabled ? "visibility-toggle--enabled" : ""}`}
            onClick={() =>
              onUpdateSettings({
                autoUpdateEnabled: !settings.autoUpdateEnabled,
              })
            }
          >
            {settings.autoUpdateEnabled ? "Enabled" : "Disabled"}
          </button>
        </div>

        <label className="settings-field">
          <span className="settings-field__label">Update interval</span>
          <select
            value={settings.updateIntervalHours}
            onChange={(event) =>
              onUpdateSettings({
                updateIntervalHours: Number(event.currentTarget.value),
              })
            }
            disabled={!settings.autoUpdateEnabled}
          >
            {EPG_AUTO_UPDATE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                Every {option} hours
              </option>
            ))}
          </select>
          <span className="settings-field__hint">
            Similar to TiviMate-style guide refresh scheduling, but stored locally for Onyx.
          </span>
        </label>

        <div className="epg-options-card">
          <div className="epg-options-card__copy">
            <strong>Update on startup</strong>
            <span>Load the cached guide immediately, then refresh it once when the app opens.</span>
          </div>

          <button
            type="button"
            className={`visibility-toggle ${settings.updateOnStartup ? "visibility-toggle--enabled" : ""}`}
            onClick={() =>
              onUpdateSettings({
                updateOnStartup: !settings.updateOnStartup,
              })
            }
          >
            {settings.updateOnStartup ? "Enabled" : "Disabled"}
          </button>
        </div>
      </div>

      {!epgDirectory && !hasGuideUrl ? (
        <div className="settings-empty">
          <strong>No EPG configured yet</strong>
          <span>Add an XMLTV URL, then update it once to cache the guide on this machine.</span>
        </div>
      ) : null}
    </div>
  );
}
