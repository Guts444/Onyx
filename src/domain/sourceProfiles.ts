import type { PlaylistImport } from "./iptv";

export type SavedSourceKind = "m3u_url" | "xtream";

interface SavedSourceBase {
  id: string;
  kind: SavedSourceKind;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoadedAt: string | null;
}

export interface SavedM3uUrlSource extends SavedSourceBase {
  kind: "m3u_url";
  url: string;
}

export interface SavedXtreamSource extends SavedSourceBase {
  kind: "xtream";
  domain: string;
  username: string;
  password: string;
}

export type SavedPlaylistSource = SavedM3uUrlSource | SavedXtreamSource;

export interface PlaylistSnapshot {
  sourceId: string | null;
  playlist: PlaylistImport;
  selectedChannelId: string | null;
  savedAt: string;
}

export interface SourceLibraryIndexEntry {
  channelIds: string[];
  playlistPreferenceKeys: string[];
}

export type SourceLibraryIndex = Record<string, SourceLibraryIndexEntry>;
