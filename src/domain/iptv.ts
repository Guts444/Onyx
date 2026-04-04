export interface Channel {
  id: string;
  name: string;
  group: string;
  stream: string;
  originalStream: string;
  isPlayable: boolean;
  playabilityError: string | null;
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
}

export interface PlaylistImport {
  name: string;
  channels: Channel[];
  groups: string[];
  importedAt: string;
  disabledChannelCount: number;
  skippedEntryCount: number;
}

export type LibraryView = "all" | "favorites" | "recents";
