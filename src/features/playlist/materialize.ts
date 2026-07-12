import type { Channel, MaterializedChannel, XtreamStreamDescriptor, XtreamStreamType } from "../../domain/iptv";
import { normalizeXtreamDomain, validateXtreamStreamDescriptor } from "../../domain/iptv.ts";
import type { SavedPlaylistSource } from "../../domain/sourceProfiles";
import { buildChannel, type ChannelSeed } from "./channelFactory.ts";
import { decodeSafePathSegments } from "./redaction.ts";

const XTREAM_STREAM_TYPES = new Set<XtreamStreamType>(["live", "movie", "series"]);
const SAFE_CONTAINER = /^[a-zA-Z0-9]{1,12}$/;
export { validateXtreamStreamDescriptor } from "../../domain/iptv.ts";

function originalPath(value: string) {
  const authorityIndex = value.indexOf("//");
  const pathIndex = value.indexOf("/", authorityIndex + 2);
  return pathIndex < 0 ? "/" : value.slice(pathIndex).split(/[?#]/, 1)[0];
}

export function createXtreamStreamDescriptor(streamUrl: string): XtreamStreamDescriptor {
  try { new URL(streamUrl); } catch {
    throw new Error("The provider returned an invalid Xtream stream descriptor.");
  }

  let segments: string[];
  try { segments = decodeSafePathSegments(originalPath(streamUrl)).filter(Boolean); }
  catch { throw new Error("The provider returned an invalid Xtream stream descriptor."); }
  const typeIndex = segments.findIndex((segment) => XTREAM_STREAM_TYPES.has(segment.toLowerCase() as XtreamStreamType));
  const streamType = segments[typeIndex]?.toLowerCase() as XtreamStreamType | undefined;
  const streamFile = typeIndex >= 0 ? segments[typeIndex + 3] : undefined;
  if (!streamType || !streamFile || typeIndex + 3 !== segments.length - 1) {
    throw new Error("The provider returned an invalid Xtream stream descriptor.");
  }

  const extensionIndex = streamFile.lastIndexOf(".");
  const streamId = extensionIndex > 0 ? streamFile.slice(0, extensionIndex) : streamFile;
  const candidateContainer = extensionIndex > 0 ? streamFile.slice(extensionIndex + 1) : null;
  const descriptor = validateXtreamStreamDescriptor({ kind: "xtream", streamType, streamId, container: candidateContainer });
  if (!descriptor || (candidateContainer && !SAFE_CONTAINER.test(candidateContainer))) {
    throw new Error("The provider returned an invalid Xtream stream descriptor.");
  }
  return descriptor;
}

export function stripXtreamChannelCredentials(channel: Channel, streamUrl: string): Channel {
  return { ...channel, stream: null, originalStream: null, streamDescriptor: createXtreamStreamDescriptor(streamUrl) };
}

export function buildCredentialFreeXtreamChannel(seed: ChannelSeed, sourceId: string): Channel {
  const channel = buildChannel(seed, { sourceId, trust: "remote" });
  try { return stripXtreamChannelCredentials(channel, seed.stream); }
  catch {
    return {
      ...channel,
      stream: null,
      originalStream: null,
      streamDescriptor: { kind: "direct" },
      isPlayable: false,
      playabilityError: "This provider direct source cannot be saved safely. Refresh the source to retry.",
    };
  }
}

export function materializeChannelForPlayback(
  channel: Channel,
  source: Pick<SavedPlaylistSource, "id" | "kind"> & Partial<Pick<Extract<SavedPlaylistSource, { kind: "xtream" }>, "domain" | "username" | "password">>,
): MaterializedChannel {
  const descriptor = channel.streamDescriptor;
  if (!channel.isPlayable) throw new Error(channel.playabilityError ?? "This channel is not playable.");
  if (!descriptor || descriptor.kind !== "xtream") {
    if (!channel.stream) throw new Error("Refresh this saved source before playback.");
    return channel as MaterializedChannel;
  }

  const validatedDescriptor = validateXtreamStreamDescriptor(descriptor);
  if (!validatedDescriptor) throw new Error("The saved channel has an invalid Xtream stream descriptor.");
  if (source.id.length === 0 || source.kind !== "xtream" || !source.domain?.trim() || !source.username?.trim() || !source.password) {
    throw new Error("The Xtream credentials are unavailable. Re-enter them before playback.");
  }

  let baseUrl: URL;
  try { baseUrl = normalizeXtreamDomain(source.domain); }
  catch { throw new Error("The Xtream provider address is invalid."); }

  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const extension = validatedDescriptor.container ? `.${validatedDescriptor.container}` : "";
  baseUrl.pathname = `${basePath}/${validatedDescriptor.streamType}/${encodeURIComponent(source.username.trim())}/${encodeURIComponent(source.password)}/${encodeURIComponent(validatedDescriptor.streamId)}${extension}`;
  return { ...channel, streamDescriptor: validatedDescriptor, stream: baseUrl.href, originalStream: null, isPlayable: true, playabilityError: null };
}
