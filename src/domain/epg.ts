import { hashString } from "../utils/hash.ts";

export interface EpgSource {
  id: string;
  url: string;
  enabled: boolean;
  autoUpdateEnabled: boolean;
  updateOnStartup: boolean;
  updateIntervalHours: number;
  createdAt: string;
  updatedAt: string;
}

export const EPG_AUTO_UPDATE_OPTIONS = [2, 4, 6, 12, 24, 48] as const;

export function sanitizeUpdateIntervalHours(value: unknown) {
  const numericValue =
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 24;

  return EPG_AUTO_UPDATE_OPTIONS.includes(
    numericValue as (typeof EPG_AUTO_UPDATE_OPTIONS)[number],
  )
    ? numericValue
    : 24;
}

export function createEpgSource(
  url = "",
  overrides: Partial<Omit<EpgSource, "id" | "url" | "createdAt" | "updatedAt">> = {},
): EpgSource {
  const timestamp = new Date().toISOString();

  return {
    // 🛡️ Sentinel: Use crypto.randomUUID() instead of Math.random() for secure, guaranteed unique ID generation
    id: `epg_${crypto.randomUUID()}`,
    url,
    enabled: overrides.enabled ?? true,
    autoUpdateEnabled: overrides.autoUpdateEnabled ?? false,
    updateOnStartup: overrides.updateOnStartup ?? true,
    updateIntervalHours: sanitizeUpdateIntervalHours(overrides.updateIntervalHours),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updateEpgSource(
  source: EpgSource,
  patch: Partial<Omit<EpgSource, "id" | "createdAt">>,
): EpgSource {
  return {
    ...source,
    ...patch,
    updateIntervalHours: sanitizeUpdateIntervalHours(
      patch.updateIntervalHours ?? source.updateIntervalHours,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeEpgSources(value: unknown): EpgSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        return null;
      }

      const source = candidate as Partial<EpgSource>;
      const createdAt =
        typeof source.createdAt === "string" && source.createdAt.trim().length > 0
          ? source.createdAt
          : new Date().toISOString();
      const updatedAt =
        typeof source.updatedAt === "string" && source.updatedAt.trim().length > 0
          ? source.updatedAt
          : createdAt;

      return {
        id:
          typeof source.id === "string" && source.id.trim().length > 0
            ? source.id
            : `epg_${hashString(
                `${typeof source.url === "string" ? source.url : ""}\u0001${createdAt}`,
              )}`,
        url: typeof source.url === "string" ? source.url : "",
        enabled: source.enabled !== false,
        autoUpdateEnabled: source.autoUpdateEnabled === true,
        updateOnStartup: source.updateOnStartup !== false,
        updateIntervalHours: sanitizeUpdateIntervalHours(source.updateIntervalHours),
        createdAt,
        updatedAt,
      } satisfies EpgSource;
    })
    .filter((source): source is EpgSource => source !== null);
}

export function isEpgSourceReady(source: Pick<EpgSource, "url">) {
  return source.url.trim().length > 0;
}

export function getEpgSourceLabel(sourceOrUrl: Pick<EpgSource, "url"> | string) {
  const rawUrl = typeof sourceOrUrl === "string" ? sourceOrUrl : sourceOrUrl.url;
  const trimmedUrl = rawUrl.trim();

  if (!trimmedUrl) {
    return "EPG guide";
  }

  const normalizedUrl = trimmedUrl.replace(/^xmltv\s*:\s*/i, "");

  try {
    const parsedUrl = new URL(normalizedUrl);
    return parsedUrl.hostname.length > 0 ? parsedUrl.hostname : parsedUrl.toString();
  } catch {
    return trimmedUrl;
  }
}

export interface EpgDirectoryChannel {
  id: string;
  uniqueId: string;
  sourceUrl: string;
  displayNames: string[];
  icon: string | null;
}

export interface EpgDirectoryResponse {
  sourceUrl: string;
  fetchedAt: string;
  channelCount: number;
  programmeCount: number;
  channels: EpgDirectoryChannel[];
}

export interface EpgProgrammeSummary {
  startMs: number;
  stopMs: number | null;
  title: string;
  subTitle: string | null;
  description: string | null;
  icon: string | null;
}

export interface EpgProgrammeSnapshot {
  epgChannelKey: string;
  current: EpgProgrammeSummary | null;
  next: EpgProgrammeSummary | null;
}

export interface EpgChannelProgrammeWindow {
  epgChannelKey: string;
  programmes: EpgProgrammeSummary[];
}

export interface EpgResolvedChannel {
  epgChannel: EpgDirectoryChannel;
  matchSource: "manual" | "auto";
}

export interface EpgResolvedGuide extends EpgResolvedChannel {
  current: EpgProgrammeSummary | null;
  next: EpgProgrammeSummary | null;
}

export type SavedEpgMappingStore = Record<string, Record<string, string>>;

export function getProgrammeStopMs(
  programmes: EpgProgrammeSummary[],
  index: number,
  fallbackStopMs: number | null = null,
) {
  return programmes[index]?.stopMs ?? programmes[index + 1]?.startMs ?? fallbackStopMs;
}

export function getProgrammeSnapshot(
  programmes: EpgProgrammeSummary[],
  atMs: number,
): Pick<EpgResolvedGuide, "current" | "next"> {
  for (let index = 0; index < programmes.length; index += 1) {
    const programme = programmes[index];
    const inferredStopMs = getProgrammeStopMs(programmes, index);

    if (programme.startMs <= atMs && (inferredStopMs === null || atMs < inferredStopMs)) {
      return {
        current: programme,
        next: programmes[index + 1] ?? null,
      };
    }

    if (programme.startMs > atMs) {
      return {
        current: null,
        next: programme,
      };
    }
  }

  return {
    current: null,
    next: null,
  };
}
