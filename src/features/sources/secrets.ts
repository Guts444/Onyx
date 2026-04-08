import { invoke, isTauri } from "@tauri-apps/api/core";

const browserPasswordStore = new Map<string, string>();

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
