import type { SavedPlaylistSource } from "../../domain/sourceProfiles";

const MAX_REPORTED_FAILURE_COUNT = 99;

export interface XtreamCredentialHydrationSettlement {
  sourceId: string;
  expectedFingerprint: string;
  result: PromiseSettledResult<string | null>;
}

export interface XtreamCredentialHydrationResult {
  sources: Record<string, SavedPlaylistSource>;
  passwordsBySourceId: Record<string, string>;
  failureCount: number;
  message: string | null;
}

export function getXtreamCredentialHydrationFingerprint(source: SavedPlaylistSource): string {
  if (source.kind !== "xtream") {
    return JSON.stringify({ id: source.id, kind: source.kind });
  }

  // Deliberately omit the password: fingerprints may be persisted or logged.
  return JSON.stringify({
    id: source.id,
    kind: source.kind,
    name: source.name,
    enabled: source.enabled,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    domain: source.domain,
    username: source.username,
  });
}

export function hydrateXtreamCredentials(
  currentSources: Record<string, SavedPlaylistSource>,
  settlements: readonly XtreamCredentialHydrationSettlement[],
): XtreamCredentialHydrationResult {
  const nextSources = { ...currentSources };
  const passwordsBySourceId: Record<string, string> = {};
  let failureCount = 0;

  for (const settlement of settlements) {
    if (settlement.result.status === "rejected") {
      failureCount += 1;
      continue;
    }

    const source = currentSources[settlement.sourceId];
    if (
      !source ||
      source.id !== settlement.sourceId ||
      source.kind !== "xtream" ||
      getXtreamCredentialHydrationFingerprint(source) !== settlement.expectedFingerprint
    ) {
      continue;
    }

    // A fulfilled null means the keyring intentionally has no credential. It may
    // clear the cached password only after the identity checks above succeed.
    const password = settlement.result.value ?? "";
    passwordsBySourceId[source.id] = password;
    if (source.password !== password) {
      nextSources[source.id] = { ...source, password };
    }
  }

  const reportedFailureCount = Math.min(failureCount, MAX_REPORTED_FAILURE_COUNT);
  const failureQualifier = failureCount > MAX_REPORTED_FAILURE_COUNT ? " or more" : "";

  return {
    sources: nextSources,
    passwordsBySourceId,
    failureCount: reportedFailureCount,
    message:
      failureCount === 0
        ? null
        : `${reportedFailureCount}${failureQualifier} saved Xtream credential${reportedFailureCount === 1 ? "" : "s"} could not be loaded.`,
  };
}
