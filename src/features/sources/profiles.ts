import type {
  SavedM3uUrlSource,
  SavedPlaylistSource,
  SavedXtreamSource,
} from "../../domain/sourceProfiles";

function hashString(source: string) {
  let hash = 0;

  for (const character of source) {
    hash = (hash << 5) - hash + character.charCodeAt(0);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}

interface BaseSourceDraft<K extends SavedPlaylistSource["kind"]> {
  id: string;
  kind: K;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoadedAt: string | null;
}

function createBaseSource<K extends SavedPlaylistSource["kind"]>(
  kind: K,
  name: string,
): BaseSourceDraft<K> {
  const timestamp = new Date().toISOString();

  return {
    id: `source_${kind}_${hashString(`${name}\u0001${timestamp}\u0001${Math.random()}`)}`,
    kind,
    name,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastLoadedAt: null,
  };
}

export function createM3uUrlSource(url = "", name = "Saved M3U URL"): SavedM3uUrlSource {
  return {
    ...createBaseSource("m3u_url", name),
    url,
  };
}

export function createXtreamSource(
  domain = "",
  username = "",
  password = "",
  name = "Saved Xtream Login",
): SavedXtreamSource {
  return {
    ...createBaseSource("xtream", name),
    domain,
    username,
    password,
  };
}

export function getDefaultSourceName(source: SavedPlaylistSource) {
  if (source.kind === "m3u_url") {
    try {
      const parsedUrl = new URL(source.url.trim());
      return parsedUrl.hostname.length > 0 ? parsedUrl.hostname : "Saved M3U URL";
    } catch {
      return source.name;
    }
  }

  const normalizedDomain = source.domain.trim().replace(/^https?:\/\//, "");
  return source.username.trim().length > 0
    ? `${normalizedDomain || "Xtream"} (${source.username.trim()})`
    : normalizedDomain || source.name;
}

export function isSourceProfileReady(source: SavedPlaylistSource) {
  if (!source.enabled) {
    return false;
  }

  if (source.kind === "m3u_url") {
    return source.url.trim().length > 0;
  }

  return (
    source.domain.trim().length > 0 &&
    source.username.trim().length > 0 &&
    source.password.length > 0
  );
}

export function markSourceLoaded(source: SavedPlaylistSource) {
  const timestamp = new Date().toISOString();

  return {
    ...source,
    updatedAt: timestamp,
    lastLoadedAt: timestamp,
  };
}

export function updateSourceProfile(
  source: SavedPlaylistSource,
  patch: Partial<SavedPlaylistSource>,
): SavedPlaylistSource {
  return {
    ...source,
    ...patch,
    updatedAt: new Date().toISOString(),
  } as SavedPlaylistSource;
}

