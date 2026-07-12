import type { SavedPlaylistSource } from "../../domain/sourceProfiles";

const MAX_REPORTED_FAILURE_COUNT = 99;

export interface SourceSecretHydrationSettlement {
  sourceId: string;
  kind: SavedPlaylistSource["kind"];
  expectedFingerprint: string;
  result: PromiseSettledResult<string | null>;
}

export interface SourceSecretHydrationResult {
  sources: Record<string, SavedPlaylistSource>;
  failureCount: number;
  message: string | null;
}

export function getSourceSecretHydrationFingerprint(source: SavedPlaylistSource): string {
  const common = {
    id: source.id,
    kind: source.kind,
    name: source.name,
    enabled: source.enabled,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
  return source.kind === "xtream"
    ? JSON.stringify({ ...common, domain: source.domain, username: source.username })
    : JSON.stringify(common);
}

export function hydrateSourceSecrets(
  currentSources: Record<string, SavedPlaylistSource>,
  settlements: readonly SourceSecretHydrationSettlement[],
): SourceSecretHydrationResult {
  const nextSources = { ...currentSources };
  let failureCount = 0;

  for (const settlement of settlements) {
    if (settlement.result.status === "rejected") {
      failureCount += 1;
      continue;
    }
    const source = currentSources[settlement.sourceId];
    if (
      !source || source.id !== settlement.sourceId || source.kind !== settlement.kind ||
      getSourceSecretHydrationFingerprint(source) !== settlement.expectedFingerprint
    ) continue;

    if (source.kind === "m3u_url") {
      // Missing keyring data must not destroy a legacy in-file URL before migration.
      const url = settlement.result.value ?? source.url;
      if (url !== source.url) nextSources[source.id] = { ...source, url };
    } else {
      const password = settlement.result.value ?? "";
      if (password !== source.password) nextSources[source.id] = { ...source, password };
    }
  }

  const reported = Math.min(failureCount, MAX_REPORTED_FAILURE_COUNT);
  const qualifier = failureCount > MAX_REPORTED_FAILURE_COUNT ? " or more" : "";
  return {
    sources: nextSources,
    failureCount: reported,
    message: failureCount === 0
      ? null
      : `${reported}${qualifier} saved source secret${reported === 1 ? "" : "s"} could not be loaded.`,
  };
}

// Compatibility API for focused Xtream callers and existing tests.
export interface XtreamCredentialHydrationSettlement {
  sourceId: string;
  expectedFingerprint: string;
  result: PromiseSettledResult<string | null>;
}

export interface XtreamCredentialHydrationResult extends SourceSecretHydrationResult {
  passwordsBySourceId: Record<string, string>;
}

export function getXtreamCredentialHydrationFingerprint(source: SavedPlaylistSource): string {
  return getSourceSecretHydrationFingerprint(source);
}

export function hydrateXtreamCredentials(
  currentSources: Record<string, SavedPlaylistSource>,
  settlements: readonly XtreamCredentialHydrationSettlement[],
): XtreamCredentialHydrationResult {
  const typedSettlements = settlements.map((settlement) => ({ ...settlement, kind: "xtream" as const }));
  const hydrated = hydrateSourceSecrets(currentSources, typedSettlements);
  const passwordsBySourceId: Record<string, string> = {};
  for (const settlement of typedSettlements) {
    if (settlement.result.status !== "fulfilled") continue;
    const source = hydrated.sources[settlement.sourceId];
    const original = currentSources[settlement.sourceId];
    if (
      source?.kind === "xtream" && original?.kind === "xtream" &&
      original.id === settlement.sourceId &&
      getSourceSecretHydrationFingerprint(original) === settlement.expectedFingerprint
    ) passwordsBySourceId[source.id] = source.password;
  }
  const reported = hydrated.failureCount;
  const qualifier = settlements.filter((item) => item.result.status === "rejected").length > MAX_REPORTED_FAILURE_COUNT
    ? " or more" : "";
  return {
    ...hydrated,
    passwordsBySourceId,
    message: reported === 0
      ? null
      : `${reported}${qualifier} saved Xtream credential${reported === 1 ? "" : "s"} could not be loaded.`,
  };
}
