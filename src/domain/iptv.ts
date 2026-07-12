export type XtreamStreamType = "live" | "movie" | "series";

const XTREAM_STREAM_TYPES = new Set<XtreamStreamType>(["live", "movie", "series"]);
const SAFE_XTREAM_IDENTIFIER = /^[A-Za-z0-9_-]+$/;
const SAFE_XTREAM_CONTAINER = /^[A-Za-z0-9]{1,12}$/;

export interface XtreamStreamDescriptor {
  kind: "xtream";
  streamType: XtreamStreamType;
  streamId: string;
  container: string | null;
}

export function validateXtreamStreamDescriptor(value: unknown): XtreamStreamDescriptor | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "xtream" ||
    typeof candidate.streamType !== "string" ||
    !XTREAM_STREAM_TYPES.has(candidate.streamType as XtreamStreamType) ||
    typeof candidate.streamId !== "string" ||
    !SAFE_XTREAM_IDENTIFIER.test(candidate.streamId) ||
    (candidate.container !== null &&
      (typeof candidate.container !== "string" || !SAFE_XTREAM_CONTAINER.test(candidate.container)))
  ) return null;

  return {
    kind: "xtream",
    streamType: candidate.streamType as XtreamStreamType,
    streamId: candidate.streamId,
    container: candidate.container as string | null,
  };
}

export function normalizeXtreamDomain(value: string): URL {
  const trimmed = value.trim();
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The Xtream provider address must use HTTP or HTTPS.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

export interface RemoteM3uStreamDescriptor { kind: "remote-m3u"; }
export interface DirectStreamDescriptor { kind: "direct"; }
export type StreamDescriptor = XtreamStreamDescriptor | RemoteM3uStreamDescriptor | DirectStreamDescriptor;

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
