import { useState } from "react";
import {
  formatBytesPerSecond,
  formatDiagnostics,
  type DiagnosticsMeta,
  type DiagnosticsSample,
} from "../features/player/diagnostics";

interface DiagnosticsOverlayProps {
  sample: DiagnosticsSample;
  meta: DiagnosticsMeta;
  onClose: () => void;
}

function show(value: string | null): string {
  return value === null || value.trim().length === 0 ? "—" : value;
}

function showNumber(value: number | null, digits = 0): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

export function DiagnosticsOverlay({ sample, meta, onClose }: DiagnosticsOverlayProps) {
  const [copied, setCopied] = useState(false);
  const text = formatDiagnostics(sample, meta);
  const size =
    sample.width !== null && sample.height !== null ? `${sample.width}x${sample.height}` : "—";

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <aside className="diagnostics-overlay" aria-label="Playback diagnostics">
      <header className="diagnostics-overlay__header">
        <strong>Diagnostics</strong>
        <button type="button" className="control-button" onClick={onClose} aria-label="Close diagnostics">
          ✕
        </button>
      </header>

      <dl className="diagnostics-overlay__rows">
        <div><dt>Codec</dt><dd>{show(sample.videoCodec)} / {show(sample.audioCodec)}</dd></div>
        <div><dt>Size</dt><dd>{size} · {showNumber(sample.fps, 2)} fps</dd></div>
        <div><dt>Hardware</dt><dd>{show(sample.hwdec)}</dd></div>
        <div>
          <dt>Cache</dt>
          <dd>
            {showNumber(sample.cacheSeconds, 1)} s · {formatBytesPerSecond(sample.cacheSpeed)} ·{" "}
            {showNumber(sample.bufferPercent)}%
          </dd>
        </div>
        <div>
          <dt>Dropped</dt>
          <dd>{showNumber(sample.droppedFrames)} (decoder {showNumber(sample.decoderDrops)})</dd>
        </div>
        <div>
          <dt>Recovery</dt>
          <dd>
            {sample.recoveryPhase === "idle"
              ? "idle"
              : `${sample.recoveryPhase} · attempt ${sample.recoveryAttempt}/5`}
            {sample.recoveryError ? ` · ${sample.recoveryError}` : ""}
          </dd>
        </div>
        <div><dt>mpv</dt><dd>{show(meta.mpvVersion)}</dd></div>
        <div><dt>Renderer</dt><dd>{show(meta.renderer)}</dd></div>
      </dl>

      <div className="diagnostics-overlay__actions">
        <button type="button" className="control-button control-button--primary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
        <span>No URLs or credentials are included.</span>
      </div>
    </aside>
  );
}
