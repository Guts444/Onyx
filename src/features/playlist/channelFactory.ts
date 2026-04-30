import type { Channel } from "../../domain/iptv";

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]+/g;
const COLLAPSE_WHITESPACE = /\s+/g;
const WINDOWS_PATH_PATTERN = /^[a-zA-Z]:\\/;
const UNC_PATH_PATTERN = /^\\\\/;
const ALLOWED_PROTOCOLS = new Set([
  "http:",
  "https:",
  "rtsp:",
  "rtmp:",
  "rtmps:",
  "udp:",
  "tcp:",
  "mms:",
  "mmsh:",
  "rtp:",
  "srt:",
  "file:",
]);

export interface ChannelSeed {
  name: string;
  group?: string | null;
  stream: string;
  originalStream?: string;
  logo?: string | null;
  tvgId?: string | null;
  tvgName?: string | null;
}

export function sanitizeLabel(value: string, fallback: string, maxLength: number) {
  const cleaned = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(COLLAPSE_WHITESPACE, " ")
    .trim();

  if (cleaned.length === 0) {
    return fallback;
  }

  return cleaned.slice(0, maxLength);
}

export function sanitizeOptionalLabel(value: string | undefined | null, maxLength: number) {
  if (!value) {
    return null;
  }

  const cleaned = sanitizeLabel(value, "", maxLength);
  return cleaned.length === 0 ? null : cleaned;
}

function createChannelId(name: string, group: string, stream: string) {
  const seed = `${name}\u0001${group}\u0001${stream}`;
  let hash = 0;

  for (const character of seed) {
    hash = (hash << 5) - hash + character.charCodeAt(0);
    hash |= 0;
  }

  return `channel_${Math.abs(hash).toString(36)}`;
}

export function normalizeStreamReference(stream: string) {
  const trimmedStream = stream.trim();

  if (WINDOWS_PATH_PATTERN.test(trimmedStream) || UNC_PATH_PATTERN.test(trimmedStream)) {
    return {
      stream: trimmedStream,
      isPlayable: true,
      playabilityError: null,
    };
  }

  try {
    const parsedUrl = new URL(trimmedStream);

    if (!ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
      return {
        stream: trimmedStream,
        isPlayable: false,
        playabilityError: `Unsupported stream protocol: ${parsedUrl.protocol}`,
      };
    }

    return {
      stream: parsedUrl.href,
      isPlayable: true,
      playabilityError: null,
    };
  } catch {
    return {
      stream: trimmedStream,
      isPlayable: false,
      playabilityError: "Unsupported stream format or malformed URL.",
    };
  }
}

export function buildChannel(seed: ChannelSeed): Channel {
  const name = sanitizeLabel(seed.name, "Unnamed channel", 120);
  const group = sanitizeLabel(seed.group ?? "Ungrouped", "Ungrouped", 80);
  const normalizedStream = normalizeStreamReference(seed.stream);

  return {
    id: createChannelId(name, group, normalizedStream.stream),
    name,
    group,
    stream: normalizedStream.stream,
    originalStream: (seed.originalStream ?? seed.stream).trim(),
    isPlayable: normalizedStream.isPlayable,
    playabilityError: normalizedStream.playabilityError,
    logo: sanitizeOptionalLabel(seed.logo, 240),
    tvgId: sanitizeOptionalLabel(seed.tvgId, 120),
    tvgName: sanitizeOptionalLabel(seed.tvgName, 120),
  };
}
