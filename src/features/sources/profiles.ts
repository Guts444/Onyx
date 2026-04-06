import type {
  SavedM3uUrlSource,
  SavedPlaylistSource,
  SavedXtreamSource,
} from "../../domain/sourceProfiles";

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
    // 🛡️ Sentinel: Use crypto.randomUUID() instead of Math.random() for secure, guaranteed unique ID generation
    id: `source_${kind}_${crypto.randomUUID()}`,
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

