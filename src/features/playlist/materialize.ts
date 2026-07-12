import type {
  Channel,
  MaterializedChannel,
  XtreamStreamDescriptor,
  XtreamStreamType,
} from "../../domain/iptv";
import type { SavedPlaylistSource } from "../../domain/sourceProfiles";
import { buildChannel, type ChannelSeed } from "./channelFactory.ts";

const XTREAM_STREAM_TYPES = new Set<XtreamStreamType>(["live", "movie", "series"]);
const SAFE_CONTAINER = /^[a-zA-Z0-9]{1,12}$/;

export function createXtreamStreamDescriptor(streamUrl: string): XtreamStreamDescriptor {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(streamUrl);
  } catch {
    throw new Error("The provider returned an invalid Xtream stream descriptor.");
  }

  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  const typeIndex = segments.findIndex((segment) =>
    XTREAM_STREAM_TYPES.has(segment.toLowerCase() as XtreamStreamType),
  );
  const streamType = segments[typeIndex]?.toLowerCase() as XtreamStreamType | undefined;
  const streamFile = typeIndex >= 0 ? segments[typeIndex + 3] : undefined;

  if (!streamType || !streamFile || typeIndex + 3 !== segments.length - 1) {
    throw new Error("The provider returned an invalid Xtream stream descriptor.");
  }

  const extensionIndex = streamFile.lastIndexOf(".");
  const streamId = extensionIndex > 0 ? streamFile.slice(0, extensionIndex) : streamFile;
  const candidateContainer = extensionIndex > 0 ? streamFile.slice(extensionIndex + 1) : null;

  if (!streamId || streamId.includes("/") || (candidateContainer && !SAFE_CONTAINER.test(candidateContainer))) {
    throw new Error("The provider returned an invalid Xtream stream descriptor.");
  }

  return {
    kind: "xtream",
    streamType,
    streamId,
    container: candidateContainer,
  };
}

export function stripXtreamChannelCredentials(channel: Channel, streamUrl: string): Channel {
  return {
    ...channel,
    stream: null,
    originalStream: null,
    streamDescriptor: createXtreamStreamDescriptor(streamUrl),
  };
}

export function buildCredentialFreeXtreamChannel(seed: ChannelSeed, sourceId: string): Channel {
  const channel = buildChannel(seed, { sourceId, trust: "remote" });
  return stripXtreamChannelCredentials(channel, seed.stream);
}

export function materializeChannelForPlayback(
  channel: Channel,
  source: Pick<SavedPlaylistSource, "id" | "kind"> &
    Partial<Pick<Extract<SavedPlaylistSource, { kind: "xtream" }>, "domain" | "username" | "password">>,
): MaterializedChannel {
  const descriptor = channel.streamDescriptor;

  if (!channel.isPlayable) {
    throw new Error(channel.playabilityError ?? "This channel is not playable.");
  }

  if (!descriptor || descriptor.kind !== "xtream") {
    if (!channel.stream) {
      throw new Error("Refresh this saved source before playback.");
    }
    return channel as MaterializedChannel;
  }

  if (
    source.id.length === 0 ||
    source.kind !== "xtream" ||
    !source.domain?.trim() ||
    !source.username?.trim() ||
    !source.password
  ) {
    throw new Error("The Xtream credentials are unavailable. Re-enter them before playback.");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(source.domain.trim());
  } catch {
    throw new Error("The Xtream provider address is invalid.");
  }

  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("The Xtream provider address must use HTTP or HTTPS.");
  }

  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const extension = descriptor.container ? `.${descriptor.container}` : "";
  baseUrl.username = "";
  baseUrl.password = "";
  baseUrl.search = "";
  baseUrl.hash = "";
  baseUrl.pathname = `${basePath}/${descriptor.streamType}/${encodeURIComponent(
    source.username.trim(),
  )}/${encodeURIComponent(source.password)}/${encodeURIComponent(descriptor.streamId)}${extension}`;

  return {
    ...channel,
    stream: baseUrl.href,
    originalStream: null,
    isPlayable: true,
    playabilityError: null,
  };
}
