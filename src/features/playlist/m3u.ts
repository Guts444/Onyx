import type { Channel, PlaylistImport } from "../../domain/iptv";
import {
  buildChannel,
  sanitizeLabel,
  sanitizeOptionalLabel,
  type StreamOriginContext,
} from "./channelFactory.ts";
import {
  PLAYLIST_CANCELLED_MESSAGE,
  throwIfAborted,
  yieldToEventLoop,
} from "./cooperative.ts";

export { PLAYLIST_CANCELLED_MESSAGE };

interface PendingChannelMeta {
  name: string;
  group: string;
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
}

export interface M3uParseProgressOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Work allowed before yielding back to the event loop. */
  sliceBudgetMs?: number;
}

const DEFAULT_SLICE_BUDGET_MS = 8;
const PROGRESS_STEP = 0.01;

function parseAttributes(source: string) {
  const attributes: Record<string, string> = {};
  const matcher = /([A-Za-z0-9_-]+)="([^"]*)"/g;

  for (const match of source.matchAll(matcher)) {
    const [, key, value] = match;
    attributes[key] = value;
  }

  return attributes;
}

function findMetadataSeparator(source: string) {
  let insideQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === "\"") {
      insideQuotes = !insideQuotes;
    }

    if (character === "," && !insideQuotes) {
      return index;
    }
  }

  return -1;
}

function parseExtinfLine(line: string, fallbackIndex: number, fallbackGroup: string | null) {
  const extinfContent = line.slice(line.indexOf(":") + 1);
  const separatorIndex = findMetadataSeparator(extinfContent);
  const metadataPart =
    separatorIndex >= 0 ? extinfContent.slice(0, separatorIndex) : extinfContent;
  const displayName =
    separatorIndex >= 0 ? extinfContent.slice(separatorIndex + 1) : "";
  const attributes = parseAttributes(metadataPart);

  return {
    name: sanitizeLabel(
      attributes["tvg-name"] ?? displayName,
      `Channel ${fallbackIndex}`,
      120,
    ),
    group: sanitizeLabel(attributes["group-title"] ?? fallbackGroup ?? "Ungrouped", "Ungrouped", 80),
    logo: sanitizeOptionalLabel(attributes["tvg-logo"], 240),
    tvgId: sanitizeOptionalLabel(attributes["tvg-id"], 120),
    tvgName: sanitizeOptionalLabel(attributes["tvg-name"], 120),
  } satisfies PendingChannelMeta;
}

/**
 * The one M3U line state machine. `parseM3u` and `parseM3uInChunks` are thin
 * drivers over this, so the two paths cannot drift.
 */
function createM3uDocumentParser(origin: StreamOriginContext) {
  const channels: Channel[] = [];
  let pendingChannel: PendingChannelMeta | null = null;
  let fallbackGroup: string | null = null;
  let disabledChannelCount = 0;
  let skippedEntryCount = 0;

  function consumeLine(rawLine: string) {
    const line = rawLine.trim();

    if (line.length === 0) {
      return;
    }

    if (line.startsWith("#EXTINF")) {
      if (pendingChannel !== null) {
        skippedEntryCount += 1;
      }

      pendingChannel = parseExtinfLine(line, channels.length + 1, fallbackGroup);
      fallbackGroup = pendingChannel.group;
      return;
    }

    if (line.startsWith("#EXTGRP:")) {
      fallbackGroup = sanitizeLabel(line.slice(8), "Ungrouped", 80);

      if (pendingChannel !== null) {
        pendingChannel = {
          ...pendingChannel,
          group: fallbackGroup,
        };
      }

      return;
    }

    if (line.startsWith("#")) {
      return;
    }

    const channel = buildChannel(
      {
        name: pendingChannel?.name ?? `Channel ${channels.length + 1}`,
        group: pendingChannel?.group ?? fallbackGroup ?? "Ungrouped",
        stream: line,
        originalStream: line,
        logo: pendingChannel?.logo,
        tvgId: pendingChannel?.tvgId,
        tvgName: pendingChannel?.tvgName,
      },
      origin,
    );

    if (!channel.isPlayable) {
      disabledChannelCount += 1;
    }

    channels.push(channel);
    pendingChannel = null;
    fallbackGroup = null;
  }

  function finish(fileName: string): PlaylistImport {
    if (pendingChannel !== null) {
      skippedEntryCount += 1;
    }

    if (channels.length === 0) {
      throw new Error("The playlist did not contain any channels that could be listed.");
    }

    const groups = [...new Set(channels.map((channel) => channel.group))].sort((left, right) =>
      left.localeCompare(right),
    );

    return {
      name: sanitizeLabel(fileName.replace(/\.[^.]+$/, ""), "Imported playlist", 80),
      channels,
      groups,
      importedAt: new Date().toISOString(),
      disabledChannelCount,
      skippedEntryCount,
    };
  }

  return { consumeLine, finish };
}

export function parseM3u(
  playlistText: string,
  fileName: string,
  origin: StreamOriginContext,
): PlaylistImport {
  const parser = createM3uDocumentParser(origin);
  const normalizedText = playlistText.replace(/^\uFEFF/, "");

  for (const rawLine of normalizedText.split(/\r?\n/)) {
    parser.consumeLine(rawLine);
  }

  return parser.finish(fileName);
}

/**
 * Same parse, sliced so the webview can paint, show progress and cancel.
 * The caller's AbortSignal is checked at every yield.
 */
export async function parseM3uInChunks(
  playlistText: string,
  fileName: string,
  origin: StreamOriginContext,
  options: M3uParseProgressOptions = {},
): Promise<PlaylistImport> {
  const parser = createM3uDocumentParser(origin);
  const { signal, onProgress, sliceBudgetMs = DEFAULT_SLICE_BUDGET_MS } = options;
  const totalLength = playlistText.length;
  let cursor = 0;
  let lastReported = 0;

  while (cursor < totalLength) {
    const sliceStartedAt = performance.now();

    do {
      let newlineIndex = playlistText.indexOf("\n", cursor);
      if (newlineIndex === -1) {
        newlineIndex = totalLength;
      }

      let lineEnd = newlineIndex;
      if (lineEnd > cursor && playlistText.charCodeAt(lineEnd - 1) === 13) {
        lineEnd -= 1;
      }

      let line = playlistText.slice(cursor, lineEnd);
      if (cursor === 0 && line.charCodeAt(0) === 0xfeff) {
        line = line.slice(1);
      }

      parser.consumeLine(line);
      cursor = newlineIndex + 1;
    } while (cursor < totalLength && performance.now() - sliceStartedAt < sliceBudgetMs);

    const fraction = Math.min(1, cursor / totalLength);
    if (onProgress && fraction - lastReported >= PROGRESS_STEP) {
      lastReported = fraction;
      onProgress(fraction);
    }

    throwIfAborted(signal);
    await yieldToEventLoop();
  }

  throwIfAborted(signal);
  onProgress?.(1);
  return parser.finish(fileName);
}
