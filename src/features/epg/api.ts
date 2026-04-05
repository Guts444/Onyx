import { invoke } from "@tauri-apps/api/core";
import type { EpgDirectoryResponse, EpgProgrammeSnapshot } from "../../domain/epg";

export function refreshEpgCache(url: string) {
  return invoke<EpgDirectoryResponse>("refresh_epg_cache", {
    url,
  });
}

export function loadEpgCacheDirectory() {
  return invoke<EpgDirectoryResponse | null>("load_epg_cache_directory");
}

export function getEpgProgrammeSnapshots(epgChannelIds: string[]) {
  return invoke<EpgProgrammeSnapshot[]>("get_epg_programme_snapshots", {
    epgChannelIds,
  });
}
