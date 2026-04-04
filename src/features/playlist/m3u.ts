import type { PlaylistImport } from "../../domain/iptv";
import { buildChannel, sanitizeLabel, sanitizeOptionalLabel } from "./channelFactory";

interface PendingChannelMeta {
  name: string;
  group: string;
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
}

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

export function parseM3u(playlistText: string, fileName: string): PlaylistImport {
  const normalizedText = playlistText.replace(/^\uFEFF/, "");
  const lines = normalizedText.split(/\r?\n/);
  const channels = [];

  let pendingChannel: PendingChannelMeta | null = null;
  let fallbackGroup: string | null = null;
  let disabledChannelCount = 0;
  let skippedEntryCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    if (line.startsWith("#EXTINF")) {
      if (pendingChannel !== null) {
        skippedEntryCount += 1;
      }

      pendingChannel = parseExtinfLine(line, channels.length + 1, fallbackGroup);
      fallbackGroup = pendingChannel.group;
      continue;
    }

    if (line.startsWith("#EXTGRP:")) {
      fallbackGroup = sanitizeLabel(line.slice(8), "Ungrouped", 80);

      if (pendingChannel !== null) {
        pendingChannel = {
          ...pendingChannel,
          group: fallbackGroup,
        };
      }

      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    const channel = buildChannel({
      name: pendingChannel?.name ?? `Channel ${channels.length + 1}`,
      group: pendingChannel?.group ?? fallbackGroup ?? "Ungrouped",
      stream: line,
      originalStream: line,
      logo: pendingChannel?.logo,
      tvgId: pendingChannel?.tvgId,
      tvgName: pendingChannel?.tvgName,
    });

    if (!channel.isPlayable) {
      disabledChannelCount += 1;
    }

    channels.push(channel);
    pendingChannel = null;
    fallbackGroup = null;
  }

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
