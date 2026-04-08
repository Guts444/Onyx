import type { EpgDirectoryChannel, EpgResolvedChannel } from "../../domain/epg";
import type { Channel } from "../../domain/iptv";

const DIACRITIC_PATTERN = /[\u0300-\u036f]/g;
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]+/g;
const GUIDE_NOISE_TOKENS = new Set([
  "backup",
  "fhd",
  "fullhd",
  "hd",
  "hevc",
  "h264",
  "h265",
  "sd",
  "uhd",
  "4k",
]);

export interface EpgChannelIndex {
  idIndex: Map<string, EpgDirectoryChannel[]>;
  nameIndex: Map<string, EpgDirectoryChannel[]>;
  sourceIdIndex: Map<string, Map<string, EpgDirectoryChannel>>;
  uniqueIdIndex: Map<string, EpgDirectoryChannel>;
}

interface ScopedManualMappings {
  sourceUrl: string;
  mappings: Record<string, string>;
}

function addCandidate(
  target: Map<string, EpgDirectoryChannel[]>,
  key: string,
  value: EpgDirectoryChannel,
) {
  const existing = target.get(key);

  if (existing !== undefined) {
    existing.push(value);
    return;
  }

  target.set(key, [value]);
}

export function normalizeEpgLookupText(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return value
    .normalize("NFKD")
    .replace(DIACRITIC_PATTERN, "")
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_PATTERN, " ")
    .trim();
}

function buildLookupVariants(value: string | null | undefined) {
  const normalizedValue = normalizeEpgLookupText(value);

  if (!normalizedValue) {
    return [];
  }

  const strippedNoiseValue = normalizedValue
    .split(" ")
    .filter((token) => token.length > 0 && !GUIDE_NOISE_TOKENS.has(token))
    .join(" ")
    .trim();

  if (strippedNoiseValue && strippedNoiseValue !== normalizedValue) {
    return [normalizedValue, strippedNoiseValue];
  }

  return [normalizedValue];
}

function getUniqueCandidate(candidates: EpgDirectoryChannel[] | undefined) {
  return candidates?.length === 1 ? candidates[0] : null;
}

function resolveManualMatch(
  manualMappingsBySource: ScopedManualMappings[],
  channel: Channel,
  index: EpgChannelIndex,
) {
  for (const scopedMappings of manualMappingsBySource) {
    const sourceIdIndex = index.sourceIdIndex.get(normalizeEpgUrlKey(scopedMappings.sourceUrl));

    if (!sourceIdIndex) {
      continue;
    }

    for (const key of getChannelManualMappingKeys(channel)) {
      const mappedChannelId = scopedMappings.mappings[key];

      if (!mappedChannelId) {
        continue;
      }

      const resolved = sourceIdIndex.get(normalizeEpgLookupText(mappedChannelId));

      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

function findIdMatch(index: EpgChannelIndex, value: string | null | undefined) {
  for (const variant of buildLookupVariants(value)) {
    const directMatch = getUniqueCandidate(index.idIndex.get(variant));

    if (directMatch) {
      return directMatch;
    }

    const displayNameMatch = getUniqueCandidate(index.nameIndex.get(variant));

    if (displayNameMatch) {
      return displayNameMatch;
    }
  }

  return null;
}

function findDisplayNameMatch(index: EpgChannelIndex, value: string | null | undefined) {
  for (const variant of buildLookupVariants(value)) {
    const match = getUniqueCandidate(index.nameIndex.get(variant));

    if (match) {
      return match;
    }
  }

  return null;
}

function getChannelIdentityTerms(channel: Channel) {
  return new Set([
    ...buildLookupVariants(channel.tvgId),
    ...buildLookupVariants(channel.tvgName),
    ...buildLookupVariants(channel.name),
  ]);
}

function getSearchScore(
  identityTerms: Set<string>,
  epgChannel: EpgDirectoryChannel,
  normalizedQuery: string,
) {
  const candidates = [epgChannel.id, ...epgChannel.displayNames];
  let bestScore = 0;

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeEpgLookupText(candidate);

    if (!normalizedCandidate) {
      continue;
    }

    if (identityTerms.has(normalizedCandidate)) {
      bestScore = Math.max(bestScore, 500);
    }

    if (!normalizedQuery) {
      continue;
    }

    if (normalizedCandidate === normalizedQuery) {
      bestScore = Math.max(bestScore, 420);
    } else if (normalizedCandidate.startsWith(normalizedQuery)) {
      bestScore = Math.max(bestScore, 320);
    } else if (normalizedCandidate.includes(normalizedQuery)) {
      bestScore = Math.max(bestScore, 220);
    }
  }

  return bestScore;
}

export function normalizeEpgUrlKey(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "";
  }

  const normalizedValue = trimmedValue.replace(/^xmltv\s*:\s*/i, "");

  try {
    return new URL(normalizedValue).toString().toLowerCase();
  } catch {
    return normalizedValue.toLowerCase();
  }
}

export function createEpgMappingScope(scopeId: string, epgUrl: string) {
  return `${normalizeEpgUrlKey(epgUrl)}\u0001${scopeId}`;
}

export function createEpgChannelIndex(channels: EpgDirectoryChannel[]): EpgChannelIndex {
  const idIndex = new Map<string, EpgDirectoryChannel[]>();
  const nameIndex = new Map<string, EpgDirectoryChannel[]>();
  const sourceIdIndex = new Map<string, Map<string, EpgDirectoryChannel>>();
  const uniqueIdIndex = new Map<string, EpgDirectoryChannel>();

  for (const channel of channels) {
    const sourceUrlKey = normalizeEpgUrlKey(channel.sourceUrl);

    uniqueIdIndex.set(channel.uniqueId, channel);

    for (const variant of buildLookupVariants(channel.id)) {
      addCandidate(idIndex, variant, channel);
    }

    for (const displayName of channel.displayNames) {
      for (const variant of buildLookupVariants(displayName)) {
        addCandidate(nameIndex, variant, channel);
      }
    }

    let scopedIndex = sourceIdIndex.get(sourceUrlKey);

    if (scopedIndex === undefined) {
      scopedIndex = new Map<string, EpgDirectoryChannel>();
      sourceIdIndex.set(sourceUrlKey, scopedIndex);
    }

    scopedIndex.set(normalizeEpgLookupText(channel.id), channel);
  }

  return {
    idIndex,
    nameIndex,
    sourceIdIndex,
    uniqueIdIndex,
  };
}

export function getChannelManualMappingKeys(channel: Channel) {
  const mappingKeys = new Set<string>([`channel:${channel.id}`]);
  const normalizedGroup = normalizeEpgLookupText(channel.group);

  for (const variant of buildLookupVariants(channel.tvgId)) {
    mappingKeys.add(`tvg-id:${variant}`);
  }

  for (const variant of buildLookupVariants(channel.tvgName)) {
    mappingKeys.add(`tvg-name:${variant}`);
  }

  for (const variant of buildLookupVariants(channel.name)) {
    mappingKeys.add(`name:${variant}`);

    if (normalizedGroup) {
      mappingKeys.add(`name-group:${variant}\u0001${normalizedGroup}`);
    }
  }

  return [...mappingKeys];
}

export function resolveEpgChannelMatch(
  channel: Channel,
  manualMappingsBySource: ScopedManualMappings[],
  index: EpgChannelIndex,
): EpgResolvedChannel | null {
  const manualMatch = resolveManualMatch(manualMappingsBySource, channel, index);

  if (manualMatch) {
    return {
      epgChannel: manualMatch,
      matchSource: "manual",
    };
  }

  const idMatch = findIdMatch(index, channel.tvgId);

  if (idMatch) {
    return {
      epgChannel: idMatch,
      matchSource: "auto",
    };
  }

  const tvgNameMatch = findDisplayNameMatch(index, channel.tvgName);

  if (tvgNameMatch) {
    return {
      epgChannel: tvgNameMatch,
      matchSource: "auto",
    };
  }

  const nameMatch = findDisplayNameMatch(index, channel.name);

  if (nameMatch) {
    return {
      epgChannel: nameMatch,
      matchSource: "auto",
    };
  }

  return null;
}

export function searchEpgChannelsForChannel(
  channel: Channel,
  epgChannels: EpgDirectoryChannel[],
  searchQuery: string,
  limit = 60,
) {
  const normalizedQuery = normalizeEpgLookupText(searchQuery);

  if (normalizedQuery.length === 0) {
    return epgChannels.slice(0, limit);
  }

  const identityTerms = getChannelIdentityTerms(channel);

  return epgChannels
    .map((epgChannel) => ({
      epgChannel,
      score: getSearchScore(identityTerms, epgChannel, normalizedQuery),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      const leftName = left.epgChannel.displayNames[0] ?? left.epgChannel.id;
      const rightName = right.epgChannel.displayNames[0] ?? right.epgChannel.id;
      const nameComparison = leftName.localeCompare(rightName);

      if (nameComparison !== 0) {
        return nameComparison;
      }

      return left.epgChannel.sourceUrl.localeCompare(right.epgChannel.sourceUrl);
    })
    .slice(0, limit)
    .map(({ epgChannel }) => epgChannel);
}
