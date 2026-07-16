import type { VodKind } from "../../domain/vod";

export interface VodCategoryVisibility {
  movie: string[];
  series: string[];
}

export type VodCategoryVisibilityStore = Record<string, VodCategoryVisibility>;

function normalizeIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 100))]
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeVodCategoryVisibilityStore(value: unknown): VodCategoryVisibilityStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: VodCategoryVisibilityStore = {};
  for (const [sourceId, entry] of Object.entries(value)) {
    if (!sourceId || sourceId.length > 100 || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    result[sourceId] = {
      movie: normalizeIds(record.movie),
      series: normalizeIds(record.series),
    };
  }
  return result;
}

export function getHiddenVodCategoryIds(
  store: VodCategoryVisibilityStore,
  sourceId: string | null,
  kind: VodKind,
) {
  if (!sourceId) return [];
  return store[sourceId]?.[kind] ?? [];
}

export function updateHiddenVodCategoryIds(
  store: VodCategoryVisibilityStore,
  sourceId: string,
  kind: VodKind,
  hiddenIds: string[],
): VodCategoryVisibilityStore {
  return {
    ...store,
    [sourceId]: {
      movie: kind === "movie" ? normalizeIds(hiddenIds) : store[sourceId]?.movie ?? [],
      series: kind === "series" ? normalizeIds(hiddenIds) : store[sourceId]?.series ?? [],
    },
  };
}

export function removeVodCategoryVisibilitySource(
  store: VodCategoryVisibilityStore,
  sourceId: string,
): VodCategoryVisibilityStore {
  if (!(sourceId in store)) return store;
  const next = { ...store };
  delete next[sourceId];
  return next;
}
