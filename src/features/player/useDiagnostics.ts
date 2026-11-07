import { useEffect, useMemo, useState } from "react";
import { getProperty } from "tauri-plugin-libmpv-api";
import { version as appVersion } from "../../../package.json";
import type { MpvPlayerState } from "./mpv";
import {
  DIAGNOSTIC_PROPERTIES,
  EMPTY_SAMPLE,
  redactDiagnostics,
  shortenRenderer,
  type DiagnosticsMeta,
  type DiagnosticsSample,
} from "./diagnostics";

type SampleValues = Omit<
  DiagnosticsSample,
  "recoveryPhase" | "recoveryAttempt" | "recoveryError"
>;

const EMPTY_VALUES: SampleValues = {
  videoCodec: EMPTY_SAMPLE.videoCodec,
  audioCodec: EMPTY_SAMPLE.audioCodec,
  width: EMPTY_SAMPLE.width,
  height: EMPTY_SAMPLE.height,
  fps: EMPTY_SAMPLE.fps,
  hwdec: EMPTY_SAMPLE.hwdec,
  cacheSeconds: EMPTY_SAMPLE.cacheSeconds,
  cacheSpeed: EMPTY_SAMPLE.cacheSpeed,
  bufferPercent: EMPTY_SAMPLE.bufferPercent,
  droppedFrames: EMPTY_SAMPLE.droppedFrames,
  decoderDrops: EMPTY_SAMPLE.decoderDrops,
};

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reads a fixed property set about once a second, only while the overlay is
 * open. Closed, the effect is not mounted and no property is read at all.
 */
export function useDiagnostics(
  player: MpvPlayerState,
  open: boolean,
): { sample: DiagnosticsSample; meta: DiagnosticsMeta } {
  const [values, setValues] = useState<SampleValues>(EMPTY_VALUES);
  const [mpvVersion, setMpvVersion] = useState<string | null>(null);
  const renderer = useMemo(() => shortenRenderer(navigator.userAgent), []);

  useEffect(() => {
    if (!open || player.environment !== "tauri") {
      return undefined;
    }

    let cancelled = false;
    let inFlight = false;

    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      if (import.meta.env.DEV) {
        const holder = window as unknown as { __diagReads?: number };
        holder.__diagReads = (holder.__diagReads ?? 0) + 1;
      }
      const results = await Promise.allSettled(
        DIAGNOSTIC_PROPERTIES.map((entry) =>
          getProperty(entry.property, entry.format as "string"),
        ),
      );
      inFlight = false;
      if (cancelled) return;

      const next: SampleValues = { ...EMPTY_VALUES };
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const entry = DIAGNOSTIC_PROPERTIES[index];
        const raw = result.value;
        if (entry.format === "string") {
          (next as Record<string, unknown>)[entry.key] = readText(raw);
        } else {
          (next as Record<string, unknown>)[entry.key] = readNumber(raw);
        }
      });
      setValues(next);
    };

    void getProperty("mpv-version", "string")
      .then((value) => {
        if (!cancelled) setMpvVersion(readText(value));
      })
      .catch(() => {
        if (!cancelled) setMpvVersion(null);
      });
    void read();
    const timer = window.setInterval(() => void read(), 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, player.environment]);

  const sample = useMemo<DiagnosticsSample>(
    () => ({
      ...values,
      recoveryPhase: player.recovery.phase,
      recoveryAttempt: player.recovery.attempt,
      recoveryError: player.recovery.lastError
        ? redactDiagnostics(player.recovery.lastError)
        : null,
    }),
    [values, player.recovery.phase, player.recovery.attempt, player.recovery.lastError],
  );

  return {
    sample,
    meta: { appVersion, mpvVersion, renderer },
  };
}
