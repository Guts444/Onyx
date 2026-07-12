import { invoke, isTauri } from "@tauri-apps/api/core";

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

export async function saveM3uUrlsBeforePersist(
  sources: Record<string, import("../../domain/sourceProfiles").SavedPlaylistSource>,
) {
  const writes = Object.values(sources)
    .filter((source) => source.kind === "m3u_url" && source.url.trim().length > 0)
    .map((source) => saveM3uUrl(source.id, source.kind === "m3u_url" ? source.url : ""));
  try {
    await Promise.all(writes);
  } catch {
    throw new Error("Saved source changes could not be secured. Existing saved data was kept.");
  }
}

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
