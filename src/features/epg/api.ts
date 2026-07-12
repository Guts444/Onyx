import { invoke } from "@tauri-apps/api/core";
import type {
  EpgCacheDiagnostics,
  EpgChannelProgrammeWindow,
  EpgDirectoryResponse,
  EpgProgrammeSnapshot,
} from "../../domain/epg";

export function refreshEpgCache(sourceId: string, url: string) {
  return invoke<EpgDirectoryResponse>("refresh_epg_cache", {
    sourceId,
    url,
  });
}

export function loadEpgCacheDirectories() {
  return invoke<EpgDirectoryResponse[]>("load_epg_cache_directories");
}

export function getEpgCacheDiagnostics() {
  return invoke<EpgCacheDiagnostics>("get_epg_cache_diagnostics");
}

export function deleteEpgCache(sourceId: string) {
  return invoke<boolean>("delete_epg_cache", {
    sourceId,
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
