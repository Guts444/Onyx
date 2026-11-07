export type VodPositionKind = "movie" | "episode";

export interface VodPositionEntry {
  position: number;
  duration: number;
  updatedAt: number;
}

export type VodPositionStore = Record<string, VodPositionEntry>;

export const VOD_POSITION_LIMIT = 500;
export const VOD_MINIMUM_SECONDS = 10;
export const VOD_END_FRACTION = 0.95;

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

/** Identifies one playable item without ever touching its stream URL. */
export function vodPositionKey(
  sourceId: string | null,
  kind: VodPositionKind,
  itemId: string,
): string | null {
  if (sourceId === null || !SAFE_SEGMENT.test(sourceId) || !SAFE_SEGMENT.test(itemId)) {
    return null;
  }
  return `${sourceId}|${kind}|${itemId}`;
}

export function isVodPositionWorthSaving(position: number | null, duration: number | null): boolean {
  if (position === null || duration === null) return false;
  if (!Number.isFinite(position) || !Number.isFinite(duration)) return false;
  if (duration <= 0) return false;
  if (position < VOD_MINIMUM_SECONDS) return false;
  return position < duration * VOD_END_FRACTION;
}

function sameEntry(left: VodPositionEntry | undefined, right: VodPositionEntry): boolean {
  if (!left) return false;
  return (
    Math.abs(left.position - right.position) < 1 &&
    Math.abs(left.duration - right.duration) < 1
  );
}

function prune(store: VodPositionStore, limit: number): VodPositionStore {
  const keys = Object.keys(store);
  if (keys.length <= limit) return store;
  const ordered = keys
    .map((key) => [key, store[key].updatedAt] as const)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
  const next: VodPositionStore = {};
  for (const [key] of ordered) next[key] = store[key];
  return next;
}

/**
 * Returns the same store object when nothing changed, so a periodic flush does
 * not rewrite app state every ten seconds.
 */
export function saveVodPosition(
  store: VodPositionStore,
  key: string | null,
  position: number | null,
  duration: number | null,
  now: number,
): VodPositionStore {
  if (key === null) return store;
  // Unknown state must never erase a good position: a failed open or a quit
  // that raced the player reports null, not "started over".
  if (position === null || !Number.isFinite(position)) return store;
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return store;
  if (!isVodPositionWorthSaving(position, duration)) {
    return clearVodPosition(store, key);
  }
  const entry: VodPositionEntry = {
    position: Math.floor(position),
    duration: Math.floor(duration),
    updatedAt: now,
  };
  if (sameEntry(store[key], entry)) return store;
  return prune({ ...store, [key]: entry }, VOD_POSITION_LIMIT);
}

export function clearVodPosition(store: VodPositionStore, key: string | null): VodPositionStore {
  if (key === null || !(key in store)) return store;
  const next = { ...store };
  delete next[key];
  return next;
}

export function removeSourcePositions(store: VodPositionStore, sourceId: string): VodPositionStore {
  const prefix = `${sourceId}|`;
  const keys = Object.keys(store).filter((key) => key.startsWith(prefix));
  if (keys.length === 0) return store;
  const next = { ...store };
  for (const key of keys) delete next[key];
  return next;
}

/** Defensive read of persisted data: anything malformed is treated as absent. */
export function reviveVodPositions(value: unknown): VodPositionStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const store: VodPositionStore = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]{1,100}\|(movie|episode)\|[A-Za-z0-9._-]{1,100}$/.test(key)) continue;
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Partial<VodPositionEntry>;
    if (
      typeof candidate.position !== "number" ||
      typeof candidate.duration !== "number" ||
      typeof candidate.updatedAt !== "number" ||
      !Number.isFinite(candidate.position) ||
      !Number.isFinite(candidate.duration) ||
      !Number.isFinite(candidate.updatedAt)
    ) {
      continue;
    }
    store[key] = {
      position: candidate.position,
      duration: candidate.duration,
      updatedAt: candidate.updatedAt,
    };
  }
  return prune(store, VOD_POSITION_LIMIT);
}
