export type XtreamStreamType = "live" | "movie" | "series";

export interface XtreamStreamDescriptor {
  kind: "xtream";
  streamType: XtreamStreamType;
  streamId: string;
  container: string | null;
}

export interface RemoteM3uStreamDescriptor {
  kind: "remote-m3u";
}

export interface DirectStreamDescriptor {
  kind: "direct";
}

export type StreamDescriptor =
  | XtreamStreamDescriptor
  | RemoteM3uStreamDescriptor
  | DirectStreamDescriptor;

export interface Channel {
  id: string;
  name: string;
  group: string;
  stream: string | null;
  originalStream: string | null;
  streamDescriptor?: StreamDescriptor;
  legacyIds?: string[];
  isPlayable: boolean;
  playabilityError: string | null;
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
}

export type MaterializedChannel = Omit<Channel, "stream" | "isPlayable" | "playabilityError"> & {
  stream: string;
  isPlayable: true;
  playabilityError: null;
};

export interface PlaylistImport {
  name: string;
  channels: Channel[];
  groups: string[];
  importedAt: string;
  disabledChannelCount: number;
  skippedEntryCount: number;
}

export type LibraryView = "all" | "favorites" | "recents";
