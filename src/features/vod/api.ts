import { invoke } from "@tauri-apps/api/core";
import type { SavedXtreamSource } from "../../domain/sourceProfiles";
import type { VodCatalogResponse, VodCategoriesResponse, VodDetails, VodKind } from "../../domain/vod";

function sourceArgs(source: SavedXtreamSource) {
  return {
    domain: source.domain,
    username: source.username,
    password: source.password,
  };
}

export function createVodOperationId(prefix: string) {
  return `vod_${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function fetchVodCategories(
  source: SavedXtreamSource,
  kind: VodKind,
  operationId: string,
) {
  return invoke<VodCategoriesResponse>("fetch_xtream_vod_categories", {
    ...sourceArgs(source),
    kind,
    operationId,
  });
}

export async function fetchVodCatalog(
  source: SavedXtreamSource,
  kind: VodKind,
  categoryId: string,
  operationId: string,
) {
  return invoke<VodCatalogResponse>("fetch_xtream_vod_catalog", {
    ...sourceArgs(source),
    kind,
    categoryId,
    operationId,
  });
}

export async function fetchVodDetails(
  source: SavedXtreamSource,
  kind: VodKind,
  itemId: string,
  operationId: string,
) {
  return invoke<VodDetails>("fetch_xtream_vod_details", {
    ...sourceArgs(source),
    kind,
    itemId,
    operationId,
  });
}

export async function cancelVodOperation(operationId: string) {
  await invoke("cancel_playlist_operation", { operationId });
}
