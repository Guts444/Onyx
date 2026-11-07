export interface DiagnosticsSample {
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hwdec: string | null;
  cacheSeconds: number | null;
  cacheSpeed: number | null;
  bufferPercent: number | null;
  droppedFrames: number | null;
  decoderDrops: number | null;
  recoveryPhase: string;
  recoveryAttempt: number;
  recoveryError: string | null;
}

export interface DiagnosticsMeta {
  appVersion: string;
  mpvVersion: string | null;
  renderer: string | null;
}

/**
 * The exact properties the overlay may read. Nothing here can contain a stream
 * URL or a credential: `path`, `stream-open-filename` and `media-title` are
 * deliberately absent, and mpv never puts the URL in a codec name.
 */
export const DIAGNOSTIC_PROPERTIES = [
  { key: "videoCodec", property: "video-codec", format: "string" },
  { key: "audioCodec", property: "audio-codec", format: "string" },
  { key: "width", property: "video-params/w", format: "int64" },
  { key: "height", property: "video-params/h", format: "int64" },
  { key: "fps", property: "estimated-vf-fps", format: "double" },
  { key: "hwdec", property: "hwdec-current", format: "string" },
  { key: "cacheSeconds", property: "demuxer-cache-time", format: "double" },
  { key: "cacheSpeed", property: "cache-speed", format: "int64" },
  { key: "bufferPercent", property: "cache-buffering-state", format: "int64" },
  { key: "droppedFrames", property: "frame-drop-count", format: "int64" },
  { key: "decoderDrops", property: "decoder-frame-drop-count", format: "int64" },
] as const;

export const EMPTY_SAMPLE: DiagnosticsSample = {
  videoCodec: null,
  audioCodec: null,
  width: null,
  height: null,
  fps: null,
  hwdec: null,
  cacheSeconds: null,
  cacheSpeed: null,
  bufferPercent: null,
  droppedFrames: null,
  decoderDrops: null,
  recoveryPhase: "idle",
  recoveryAttempt: 0,
  recoveryError: null,
};

const URL_PATTERN = /\b(?:https?|rtsp|rtmp|udp|tcp|ftp):\/\/\S+/gi;
const USERINFO_PATTERN = /\/\/[^\s/@:]+:[^\s/@]*@/g;
const XTREAM_PATH_PATTERN = /\b(?:live|movie|series)\/[^\s/]+\/[^\s/]+\/\d+(?:\.[a-z0-9]+)?/gi;

/**
 * Defence in depth for the copied block: every value is numeric or a codec
 * name, but a provider can return a hostile codec string, and a future
 * property could carry a URL. Anything that looks like a stream URL or an
 * Xtream path is removed before it can reach the clipboard.
 */
export function redactDiagnostics(value: string): string {
  return value
    .replace(URL_PATTERN, "[removed]")
    .replace(USERINFO_PATTERN, "//[removed]@")
    .replace(XTREAM_PATH_PATTERN, "[removed]");
}

function dash(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "—";
}

function number(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function formatBytesPerSecond(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.round(value / 1024)} kB/s`;
}

export function formatDiagnostics(
  sample: DiagnosticsSample,
  meta: DiagnosticsMeta,
): string {
  const codec = [dash(sample.videoCodec), dash(sample.audioCodec)].join(" / ");
  const size =
    sample.width !== null && sample.height !== null
      ? `${sample.width}x${sample.height}`
      : "—";
  const recovery =
    sample.recoveryPhase === "idle"
      ? "idle"
      : `${sample.recoveryPhase} · attempt ${sample.recoveryAttempt}/5`;
  const failure = sample.recoveryError ? ` · last error: ${sample.recoveryError}` : "";
  const lines = [
    `Onyx ${meta.appVersion}`,
    `mpv: ${dash(meta.mpvVersion)}`,
    `renderer: ${dash(meta.renderer)}`,
    `codec: ${codec}`,
    `size: ${size} · ${number(sample.fps, 2)} fps`,
    `hardware decoding: ${dash(sample.hwdec)}`,
    `cache: ${number(sample.cacheSeconds, 1)} s · ${formatBytesPerSecond(sample.cacheSpeed)} · ${number(sample.bufferPercent)}%`,
    `dropped frames: ${number(sample.droppedFrames)} (decoder ${number(sample.decoderDrops)})`,
    `recovery: ${recovery}${failure}`,
  ];
  return redactDiagnostics(lines.join("\n"));
}

export function shortenRenderer(renderer: string | null): string | null {
  if (!renderer) return null;
  const edge = renderer.match(/Edg\/([\d.]+)/);
  if (edge) return `WebView2 ${edge[1]}`;
  const chrome = renderer.match(/Chrome\/([\d.]+)/);
  if (chrome) return `Chromium ${chrome[1]}`;
  return renderer.slice(0, 40);
}
