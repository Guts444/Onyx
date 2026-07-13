import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SavedPlaylistSource } from "../../domain/sourceProfiles";
import { enqueuePersistentWork } from "../../hooks/usePersistentState.ts";

export const SAVED_SOURCES_PERSISTENCE_KEY = "iptv-player:saved-sources";
const SOURCE_SECRET_DELETE_ERROR =
  "The saved source credential could not be removed. Existing saved data was kept.";

const browserPasswordStore = new Map<string, string>();
const browserM3uUrlStore = new Map<string, string>();

export async function loadM3uUrl(sourceId: string) {
  if (!isTauri()) return browserM3uUrlStore.get(sourceId) ?? null;
  return invoke<string | null>("load_m3u_url", { sourceId });
}

export async function saveM3uUrl(sourceId: string, url: string) {
  if (!isTauri()) {
    browserM3uUrlStore.set(sourceId, url);
    return;
  }
  await invoke("save_m3u_url", { sourceId, url });
}

export async function deleteM3uUrl(sourceId: string) {
  if (!isTauri()) {
    browserM3uUrlStore.delete(sourceId);
    return;
  }
  await invoke("delete_m3u_url", { sourceId });
}

export async function saveSourceSecretsBeforePersist(
  sources: Record<string, SavedPlaylistSource>,
  secretStore: {
    loadM3uUrl: typeof loadM3uUrl;
    saveM3uUrl: typeof saveM3uUrl;
    loadXtreamPassword: typeof loadXtreamPassword;
    saveXtreamPassword: typeof saveXtreamPassword;
  } = { loadM3uUrl, saveM3uUrl, loadXtreamPassword, saveXtreamPassword },
) {
  const compareAndSave = async (
    sourceId: string,
    secret: string,
    load: (sourceId: string) => Promise<string | null>,
    save: (sourceId: string, secret: string) => Promise<void>,
  ) => {
    let existing: string | null;
    try {
      existing = await load(sourceId);
    } catch {
      const error = new Error("Saved source secret verification failed.");
      Object.defineProperty(error, "persistenceStage", { value: "prepare-load" });
      throw error;
    }
    if (existing === secret) return;
    try {
      await save(sourceId, secret);
    } catch {
      const error = new Error("Changed source secret storage failed.");
      Object.defineProperty(error, "persistenceStage", { value: "prepare-save" });
      throw error;
    }
  };
  const writes = Object.values(sources).flatMap((source) => {
    if (source.kind === "m3u_url") {
      if (source.url.trim().length === 0) return [];
      return [compareAndSave(source.id, source.url, secretStore.loadM3uUrl, secretStore.saveM3uUrl)];
    }
    // Xtream passwords are secured transactionally when the password field is
    // edited. Metadata-only saves must not be coupled to another keyring read.
    return [];
  });
  try {
    await Promise.all(writes);
  } catch (error) {
    const safeError = new Error("Saved source changes could not be secured. Existing saved data was kept.");
    if (error instanceof Error && "persistenceStage" in error) {
      Object.defineProperty(safeError, "persistenceStage", {
        value: (error as Error & { persistenceStage: string }).persistenceStage,
      });
    }
    throw safeError;
  }
}

export async function saveXtreamPasswordBeforeCommit(
  sourceId: string,
  password: string,
  commit: () => void,
  save: typeof saveXtreamPassword = saveXtreamPassword,
) {
  try {
    await enqueuePersistentWork(SAVED_SOURCES_PERSISTENCE_KEY, () => save(sourceId, password));
  } catch {
    throw new Error("Saved source changes could not be secured. Existing saved data was kept.");
  }
  commit();
}

/** @deprecated Use saveSourceSecretsBeforePersist so both source kinds share ordering. */
export const saveM3uUrlsBeforePersist = saveSourceSecretsBeforePersist;

export async function loadXtreamPassword(sourceId: string) {
  if (!isTauri()) {
    return browserPasswordStore.get(sourceId) ?? null;
  }

  return invoke<string | null>("load_xtream_password", { sourceId });
}

export async function saveXtreamPassword(sourceId: string, password: string) {
  if (!isTauri()) {
    if (password.length === 0) {
      browserPasswordStore.delete(sourceId);
    } else {
      browserPasswordStore.set(sourceId, password);
    }
    return;
  }

  await invoke("save_xtream_password", { sourceId, password });
}

export async function deleteXtreamPassword(sourceId: string) {
  if (!isTauri()) {
    browserPasswordStore.delete(sourceId);
    return;
  }

  await invoke("delete_xtream_password", { sourceId });
}

type DeleteSourceSecret = (source: SavedPlaylistSource) => Promise<void>;

async function deleteSourceSecret(source: SavedPlaylistSource) {
  if (source.kind === "m3u_url") {
    await deleteM3uUrl(source.id);
  } else {
    await deleteXtreamPassword(source.id);
  }
}

export async function deleteSourceSecretBeforeCommit(
  source: SavedPlaylistSource,
  commit: () => void,
  removeSecret: DeleteSourceSecret = deleteSourceSecret,
) {
  try {
    await enqueuePersistentWork(SAVED_SOURCES_PERSISTENCE_KEY, () => removeSecret(source));
  } catch {
    throw new Error(SOURCE_SECRET_DELETE_ERROR);
  }
  commit();
}
