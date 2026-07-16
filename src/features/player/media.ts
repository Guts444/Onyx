export interface SubtitleTrack {
  id: number;
  label: string;
  language: string | null;
  selected: boolean;
  external: boolean;
}

export function parseSubtitleTracks(value: unknown): SubtitleTrack[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((track): SubtitleTrack[] => {
    if (
      typeof track !== "object" ||
      track === null ||
      (track as Record<string, unknown>).type !== "sub" ||
      typeof (track as Record<string, unknown>).id !== "number"
    ) {
      return [];
    }
    const raw = track as Record<string, unknown>;
    const language = typeof raw.lang === "string" && raw.lang.trim().length > 0
      ? raw.lang.trim().slice(0, 32)
      : null;
    const title = typeof raw.title === "string" && raw.title.trim().length > 0
      ? raw.title.trim().slice(0, 120)
      : null;
    return [{
      id: raw.id as number,
      label: title ?? language?.toLocaleUpperCase() ?? `Subtitle ${raw.id as number}`,
      language,
      selected: raw.selected === true,
      external: raw.external === true,
    }];
  });
}

export function clampSeekPosition(position: number, duration: number | null) {
  const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
  return typeof duration === "number" && Number.isFinite(duration) && duration >= 0
    ? Math.min(safePosition, duration)
    : safePosition;
}
