import type { Channel } from "../../domain/iptv";
import { decodeSafePathSegments } from "./redaction.ts";

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]+/g;
const COLLAPSE_WHITESPACE = /\s+/g;
const WINDOWS_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const UNC_PATH_PATTERN = /^\\\\/;
const ALLOWED_REMOTE_PROTOCOLS = new Set([
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
]);
const SHA_256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA_256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SENSITIVE_QUERY_PARAMETER = /^(?:access_?token|api_?key|auth|authorization|credential|key|pass|password|secret|signature|token|user|username)$/i;
const XTREAM_PATH_KINDS = new Set(["live", "movie", "series"]);
const SAFE_TERMINAL_STREAM_FILE = /^[0-9]+\.(?:avi|m3u8|mkv|mov|mp4|ts)$/i;

export interface ChannelSeed {
  name: string;
  group?: string | null;
  stream: string;
  originalStream?: string;
  logo?: string | null;
  tvgId?: string | null;
  tvgName?: string | null;
}

export type StreamTrust = "remote" | "trusted-local";

export interface StreamOriginContext {
  sourceId: string;
  trust: StreamTrust;
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

function rotateRight(value: number, distance: number) {
  return (value >>> distance) | (value << (32 - distance));
}

function sha256(value: string) {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(input);
  message[input.length] = 0x80;

  const bitLength = input.length * 8;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = [...SHA_256_INITIAL_STATE];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }

    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA_256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rawUrlPath(value: string) {
  const authorityIndex = value.indexOf("//");
  const pathIndex = value.indexOf("/", authorityIndex + 2);
  return pathIndex < 0 ? "/" : value.slice(pathIndex).split(/[?#]/, 1)[0];
}

function looksLikeXtreamKind(rawSegment: string) {
  let decoded = rawSegment;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === decoded) break;
    decoded = next;
  }

  const normalized = decoded.toLowerCase().replace(/%[0-9a-z]{2}/g, "");
  return Array.from(XTREAM_PATH_KINDS).some(
    (kind) => normalized === kind || normalized.startsWith(`${kind}/`) || normalized.startsWith(`${kind}\\`),
  );
}

function opaqueStreamIdentity(url: URL, originalPath: string) {
  const pathSegments = originalPath.split("/");
  const xtreamKindIndex = pathSegments.findIndex(looksLikeXtreamKind);
  if (xtreamKindIndex >= 0) {
    const terminalSegment = [...pathSegments].reverse().find((segment) => segment.length > 0) ?? "";
    const safeTerminal = SAFE_TERMINAL_STREAM_FILE.test(terminalSegment)
      ? terminalSegment.toLowerCase()
      : "__unknown_stream__";

    // Unsafe or ambiguous Xtream path structure means no middle path or query value is
    // trustworthy: any of them may be a shifted credential. Keep only origin metadata
    // and a narrowly allowlisted terminal stream file.
    return `opaque-stream:${sha256(JSON.stringify([
      url.protocol,
      url.hostname.toLowerCase(),
      url.port,
      "__malformed_xtream__",
      safeTerminal,
    ]))}`;
  }

  for (const key of Array.from(url.searchParams.keys())) {
    if (SENSITIVE_QUERY_PARAMETER.test(key)) url.searchParams.set(key, "__secret__");
  }
  url.searchParams.sort();

  return `opaque-stream:${sha256(JSON.stringify([
    url.protocol,
    url.hostname.toLowerCase(),
    url.port,
    pathSegments.join("/"),
    url.search,
  ]))}`;
}

export function canonicalizeStreamIdentity(stream: string) {
  const trimmedStream = stream.trim();

  try {
    const url = new URL(trimmedStream);
    url.username = "";
    url.password = "";

    const pathSegments = url.pathname.split("/");
    const originalPath = rawUrlPath(trimmedStream);
    let decodedSegments: string[];
    try {
      decodedSegments = decodeSafePathSegments(originalPath);
    } catch {
      return opaqueStreamIdentity(url, originalPath);
    }
    const xtreamKindIndex = decodedSegments.findIndex((segment) =>
      XTREAM_PATH_KINDS.has(segment.toLowerCase()),
    );

    if (xtreamKindIndex >= 0 && pathSegments.length > xtreamKindIndex + 3) {
      pathSegments[xtreamKindIndex] = decodedSegments[xtreamKindIndex].toLowerCase();
      pathSegments[xtreamKindIndex + 1] = "__user__";
      pathSegments[xtreamKindIndex + 2] = "__secret__";
      url.pathname = pathSegments.join("/");
    }

    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMETER.test(key)) {
        url.searchParams.set(key, "__secret__");
      }
    }
    url.searchParams.sort();
    url.hash = "";
    return url.href;
  } catch {
    return `opaque-stream:${sha256(trimmedStream)}`;
  }
}

function createChannelId(sourceId: string, stream: string) {
  return `channel_${sha256(JSON.stringify([sourceId, canonicalizeStreamIdentity(stream)]))}`;
}

export function createLegacyChannelId(name: string, group: string, stream: string) {
  const seed = `${name}\u0001${group}\u0001${stream}`;
  let hash = 0;

  for (const character of seed) {
    hash = (hash << 5) - hash + character.charCodeAt(0);
    hash |= 0;
  }

  return `channel_${Math.abs(hash).toString(36)}`;
}

export function createLocalM3uSourceIdentity(fileName: string, playlistText: string) {
  return `local-file_${sha256(JSON.stringify([fileName.trim().toLowerCase(), sha256(playlistText)]))}`;
}

export function normalizeStreamReference(
  stream: string,
  context: Pick<StreamOriginContext, "trust"> = { trust: "remote" },
) {
  const trimmedStream = stream.trim();
  const isFileSystemPath =
    WINDOWS_PATH_PATTERN.test(trimmedStream) || UNC_PATH_PATTERN.test(trimmedStream);

  if (isFileSystemPath) {
    if (context.trust !== "trusted-local") {
      return {
        stream: trimmedStream,
        isPlayable: false,
        playabilityError: "Local stream targets are not allowed for remote sources.",
      };
    }

    return {
      stream: trimmedStream,
      isPlayable: true,
      playabilityError: null,
    };
  }

  try {
    const parsedUrl = new URL(trimmedStream);

    if (parsedUrl.protocol === "file:") {
      if (context.trust !== "trusted-local") {
        return {
          stream: trimmedStream,
          isPlayable: false,
          playabilityError: "Local stream targets are not allowed for remote sources.",
        };
      }

      return {
        stream: parsedUrl.href,
        isPlayable: true,
        playabilityError: null,
      };
    }

    if (!ALLOWED_REMOTE_PROTOCOLS.has(parsedUrl.protocol)) {
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

export function buildChannel(seed: ChannelSeed, context: StreamOriginContext): Channel {
  const name = sanitizeLabel(seed.name, "Unnamed channel", 120);
  const group = sanitizeLabel(seed.group ?? "Ungrouped", "Ungrouped", 80);
  const normalizedStream = normalizeStreamReference(seed.stream, context);

  return {
    id: createChannelId(context.sourceId, normalizedStream.stream),
    legacyIds: [createLegacyChannelId(name, group, normalizedStream.stream)],
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
