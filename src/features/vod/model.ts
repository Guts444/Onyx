import type { SavedXtreamSource } from "../../domain/sourceProfiles";
import type { VodCatalogItem } from "../../domain/vod";

const SAFE_ID = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_EXTENSION = /^[A-Za-z0-9]{1,12}$/;

export function buildXtreamVodStreamUrl(
  source: SavedXtreamSource,
  streamOrigin: string,
  kind: "movie" | "episode",
  itemId: string,
  containerExtension: string,
) {
  const username = source.username.trim();
  const password = source.password;
  if (
    !source.enabled ||
    username.length === 0 ||
    password.length === 0 ||
    !SAFE_ID.test(itemId) ||
    !SAFE_EXTENSION.test(containerExtension)
  ) {
    throw new Error("The VOD playback descriptor is not valid.");
  }

  let origin: URL;
  try {
    origin = new URL(streamOrigin);
  } catch {
    throw new Error("The VOD playback descriptor is not valid.");
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username.length > 0 ||
    origin.password.length > 0
  ) {
    throw new Error("The VOD playback descriptor is not valid.");
  }

  const section = kind === "movie" ? "movie" : "series";
  origin.pathname = [
    "",
    section,
    encodeURIComponent(username),
    encodeURIComponent(password),
    `${encodeURIComponent(itemId)}.${containerExtension.toLowerCase()}`,
  ].join("/");
  origin.search = "";
  origin.hash = "";
  return origin.toString();
}

export function filterVodCatalog(items: readonly VodCatalogItem[], rawQuery: string) {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (query.length === 0) return [...items];
  return items.filter((item) =>
    [item.title, item.plot ?? "", item.year ?? ""]
      .some((value) => value.toLocaleLowerCase().includes(query)),
  );
}
