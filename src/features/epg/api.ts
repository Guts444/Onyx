import { invoke } from "@tauri-apps/api/core";
import type {
  EpgChannelProgrammeWindow,
  EpgDirectoryResponse,
  EpgProgrammeSnapshot,
} from "../../domain/epg";

export function refreshEpgCache(url: string) {
  return invoke<EpgDirectoryResponse>("refresh_epg_cache", {
    url,
  });
}

export function loadEpgCacheDirectories() {
  return invoke<EpgDirectoryResponse[]>("load_epg_cache_directories");
}

export function deleteEpgCache(url: string) {
  return invoke<boolean>("delete_epg_cache", {
    url,
  });
}

export function getEpgProgrammeSnapshots(epgChannelKeys: string[]) {
  return invoke<EpgProgrammeSnapshot[]>("get_epg_programme_snapshots", {
    epgChannelKeys,
  });
}

export function getEpgProgrammeWindows(
  epgChannelKeys: string[],
  windowStartMs: number,
  windowEndMs: number,
) {
  return invoke<EpgChannelProgrammeWindow[]>("get_epg_programme_windows", {
    epgChannelKeys,
    windowStartMs,
    windowEndMs,
  });
}
