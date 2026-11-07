import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_SAMPLE,
  formatBytesPerSecond,
  formatDiagnostics,
  redactDiagnostics,
  shortenRenderer,
  type DiagnosticsSample,
} from "./diagnostics.ts";

const META = { appVersion: "0.7.0", mpvVersion: "mpv 0.38.0", renderer: "WebView2 130.0.2849.68" };

const SAMPLE: DiagnosticsSample = {
  videoCodec: "h264 (High)",
  audioCodec: "aac",
  width: 1920,
  height: 1080,
  fps: 25,
  hwdec: "d3d11va",
  cacheSeconds: 4.2,
  cacheSpeed: 3_355_443,
  bufferPercent: 100,
  droppedFrames: 2,
  decoderDrops: 0,
  recoveryPhase: "idle",
  recoveryAttempt: 0,
  recoveryError: null,
};

test("a full sample formats every field", () => {
  const text = formatDiagnostics(SAMPLE, META);
  assert.match(text, /Onyx 0\.7\.0/);
  assert.match(text, /mpv: mpv 0\.38\.0/);
  assert.match(text, /codec: h264 \(High\) \/ aac/);
  assert.match(text, /size: 1920x1080 · 25\.00 fps/);
  assert.match(text, /hardware decoding: d3d11va/);
  assert.match(text, /cache: 4\.2 s · 3\.2 MB\/s · 100%/);
  assert.match(text, /dropped frames: 2 \(decoder 0\)/);
  assert.match(text, /recovery: idle/);
});

test("missing properties format as a dash, never as an error", () => {
  const text = formatDiagnostics(EMPTY_SAMPLE, { appVersion: "0.7.0", mpvVersion: null, renderer: null });
  assert.match(text, /codec: — \/ —/);
  assert.match(text, /size: — · — fps/);
  assert.match(text, /hardware decoding: —/);
  assert.match(text, /cache: — s · — · —%/);
  assert.match(text, /mpv: —/);
});

test("recovery attempt and last error are reported", () => {
  const text = formatDiagnostics(
    { ...SAMPLE, recoveryPhase: "waiting", recoveryAttempt: 2, recoveryError: "loading failed" },
    META,
  );
  assert.match(text, /recovery: waiting · attempt 2\/5 · last error: loading failed/);
});

test("a stream URL never reaches the copied text", () => {
  const hostile =
    "failed to open http://user:hunter2@provider.example:8080/live/abc/def/12345.ts";
  const text = formatDiagnostics({ ...SAMPLE, recoveryError: hostile }, META);
  assert.doesNotMatch(text, /provider\.example/);
  assert.doesNotMatch(text, /hunter2/);
  assert.match(text, /\[removed\]/);
});

test("redaction covers URLs, userinfo and Xtream paths", () => {
  assert.equal(redactDiagnostics("see https://a.example/x?y=1 now"), "see [removed] now");
  assert.equal(redactDiagnostics("rtsp://u:p@1.2.3.4/live"), "[removed]");
  assert.equal(redactDiagnostics("path live/abc/def/98765.ts"), "path [removed]");
  assert.equal(redactDiagnostics("h264 (High)"), "h264 (High)");
});

test("a credential-bearing codec string is removed too", () => {
  const text = formatDiagnostics(
    { ...SAMPLE, videoCodec: "x http://host/live/user/secret/9.ts" },
    META,
  );
  assert.doesNotMatch(text, /secret/);
  assert.doesNotMatch(text, /host\/live/);
});

test("cache speed switches units", () => {
  assert.equal(formatBytesPerSecond(null), "—");
  assert.equal(formatBytesPerSecond(0), "—");
  assert.equal(formatBytesPerSecond(800 * 1024), "800 kB/s");
  assert.equal(formatBytesPerSecond(3.5 * 1024 * 1024), "3.5 MB/s");
});

test("the renderer is shortened to something a user can paste", () => {
  assert.equal(
    shortenRenderer("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68"),
    "WebView2 130.0.2849.68",
  );
  assert.equal(shortenRenderer("Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36"), "Chromium 130.0.0.0");
  assert.equal(shortenRenderer(null), null);
});
