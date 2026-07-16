export type AutoResumeMode = "fullscreen" | "mini-player";

interface GeneralSettingsPanelProps {
  autoResumeMode: AutoResumeMode;
  onAutoResumeModeChange: (mode: AutoResumeMode) => void;
}

export function GeneralSettingsPanel({
  autoResumeMode,
  onAutoResumeModeChange,
}: GeneralSettingsPanelProps) {
  return (
    <div className="general-settings" aria-label="General settings">
      <section className="settings-section">
        <div className="settings-section__copy">
          <span className="settings-drawer__eyebrow">Startup</span>
          <h3 id="automatic-resume-heading">Automatic resume</h3>
          <p>
            When Onyx reopens a channel that was playing when the app closed, choose how the player should appear.
          </p>
        </div>

        <fieldset className="resume-mode-options" aria-labelledby="automatic-resume-heading">
          <label className={`resume-mode-card ${autoResumeMode === "fullscreen" ? "resume-mode-card--active" : ""}`}>
            <input
              type="radio"
              name="auto-resume-mode"
              value="fullscreen"
              checked={autoResumeMode === "fullscreen"}
              onChange={() => onAutoResumeModeChange("fullscreen")}
            />
            <strong>Fullscreen</strong>
            <span>Resume directly into fullscreen playback. This is the default.</span>
          </label>
          <label className={`resume-mode-card ${autoResumeMode === "mini-player" ? "resume-mode-card--active" : ""}`}>
            <input
              type="radio"
              name="auto-resume-mode"
              value="mini-player"
              checked={autoResumeMode === "mini-player"}
              onChange={() => onAutoResumeModeChange("mini-player")}
            />
            <strong>Mini-player</strong>
            <span>Resume inside the player above the TV guide, with navigation still visible.</span>
          </label>
        </fieldset>
      </section>
    </div>
  );
}
