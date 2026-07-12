import { invoke, isTauri } from "@tauri-apps/api/core";
import type { EpgSource } from "../../domain/epg.ts";
import { enqueuePersistentWork } from "../../hooks/usePersistentState.ts";

export const EPG_SOURCES_STORAGE_KEY = "iptv-player:epg-sources";
const EPG_SAVE_ERROR = "EPG URL changes could not be secured. Existing saved data was kept.";
const EPG_DELETE_ERROR = "The saved EPG URL could not be removed. Existing saved data was kept.";
export const EPG_URL_VALIDATION_ERROR = "Enter a complete HTTP or HTTPS EPG URL.";
const browserEpgUrlStore = new Map<string, string>();

export type EpgUrlDrafts = Readonly<Record<string, string>>;

export function editEpgUrlDraft(drafts: EpgUrlDrafts, sourceId: string, value: string): EpgUrlDrafts {
  return { ...drafts, [sourceId]: value };
}

export function canRunEpgMappingMigration(readiness: {
  epgSourcesHydrated: boolean;
  epgSecretsHydrated: boolean;
  savedEpgMappingsHydrated: boolean;
}) {
  return readiness.epgSourcesHydrated && readiness.epgSecretsHydrated && readiness.savedEpgMappingsHydrated;
}

export async function loadEpgUrl(sourceId: string) {
  if (!isTauri()) return browserEpgUrlStore.get(sourceId) ?? null;
  return invoke<string | null>("load_epg_url", { sourceId });
}

export async function saveEpgUrl(sourceId: string, url: string) {
  if (!isTauri()) { browserEpgUrlStore.set(sourceId, url); return; }
  await invoke("save_epg_url", { sourceId, url });
}

export async function deleteEpgUrl(sourceId: string) {
  if (!isTauri()) { browserEpgUrlStore.delete(sourceId); return; }
  await invoke("delete_epg_url", { sourceId });
}

type SaveEpgUrl = (sourceId: string, url: string) => Promise<void>;

export async function saveEpgUrlsBeforePersist(
  sources: readonly EpgSource[],
  save: SaveEpgUrl = saveEpgUrl,
) {
  try {
    await Promise.all(sources.flatMap((source) =>
      source.url.trim().length > 0 ? [save(source.id, source.url)] : [],
    ));
  } catch {
    throw new Error(EPG_SAVE_ERROR);
  }
}

export function serializeEpgSources(sources: readonly EpgSource[]) {
  return sources.map((source) => ({
    id: source.id,
    url: "",
    enabled: source.enabled,
    autoUpdateEnabled: source.autoUpdateEnabled,
    updateOnStartup: source.updateOnStartup,
    updateIntervalHours: source.updateIntervalHours,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  } satisfies EpgSource));
}

export function getEpgSecretHydrationFingerprint(source: EpgSource) {
  return JSON.stringify({
    id: source.id,
    enabled: source.enabled,
    autoUpdateEnabled: source.autoUpdateEnabled,
    updateOnStartup: source.updateOnStartup,
    updateIntervalHours: source.updateIntervalHours,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  });
}

export interface EpgSecretHydrationSettlement {
  sourceId: string;
  expectedFingerprint: string;
  result: PromiseSettledResult<string | null>;
}

export function hydrateEpgSecrets(
  currentSources: readonly EpgSource[],
  settlements: readonly EpgSecretHydrationSettlement[],
) {
  const nextSources = [...currentSources];
  let failureCount = 0;
  for (const settlement of settlements) {
    if (settlement.result.status === "rejected") { failureCount += 1; continue; }
    const index = nextSources.findIndex((source) => source.id === settlement.sourceId);
    const source = nextSources[index];
    if (!source || getEpgSecretHydrationFingerprint(source) !== settlement.expectedFingerprint) continue;
    const url = settlement.result.value ?? source.url;
    if (url !== source.url) nextSources[index] = { ...source, url };
  }
  return {
    sources: nextSources,
    failureCount,
    message: failureCount === 0
      ? null
      : `${Math.min(failureCount, 99)}${failureCount > 99 ? " or more" : ""} saved EPG URL${failureCount === 1 ? "" : "s"} could not be loaded.`,
  };
}

export async function requireEpgMappingMigrationReady(ready: boolean) {
  if (!ready) {
    throw new Error("EPG guide mappings are waiting for secure URL hydration.");
  }
}

type DeleteEpgUrl = (sourceId: string) => Promise<void>;

function normalizeCompleteEpgUrlDraft(draft: string) {
  const value = draft.trim().replace(/^xmltv\s*:\s*/i, "");
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      throw new Error(EPG_URL_VALIDATION_ERROR);
    }
    return value;
  } catch {
    throw new Error(EPG_URL_VALIDATION_ERROR);
  }
}

export async function applyEpgUrlDraft(
  sourceId: string,
  draft: string,
  commit: (url: string) => void,
  save: SaveEpgUrl = saveEpgUrl,
  remove: DeleteEpgUrl = deleteEpgUrl,
) {
  const url = normalizeCompleteEpgUrlDraft(draft);
  if (!url) {
    await deleteEpgUrlBeforeCommit(sourceId, () => commit(""), remove);
    return true;
  }
  await saveEpgUrlBeforeCommit(sourceId, url, () => commit(url), save);
  return true;
}

export async function saveEpgUrlBeforeCommit(
  sourceId: string,
  url: string,
  commit: () => void,
  save: SaveEpgUrl = saveEpgUrl,
) {
  try {
    await enqueuePersistentWork(EPG_SOURCES_STORAGE_KEY, () => save(sourceId, url));
  } catch {
    throw new Error(EPG_SAVE_ERROR);
  }
  commit();
}

export async function deleteEpgUrlBeforeCommit(
  sourceId: string,
  commit: () => void,
  remove: DeleteEpgUrl = deleteEpgUrl,
) {
  try {
    await enqueuePersistentWork(EPG_SOURCES_STORAGE_KEY, () => remove(sourceId));
  } catch {
    throw new Error(EPG_DELETE_ERROR);
  }
  commit();
}
