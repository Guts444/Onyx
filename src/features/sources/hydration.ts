import type { SavedPlaylistSource } from "../../domain/sourceProfiles";

const MAX_REPORTED_FAILURE_COUNT = 99;

export interface XtreamCredentialHydrationSettlement {
  sourceId: string;
  result: PromiseSettledResult<string | null>;
}

export interface XtreamCredentialHydrationResult {
  sources: Record<string, SavedPlaylistSource>;
  passwordsBySourceId: Record<string, string>;
  failureCount: number;
  message: string | null;
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
    if (!source || source.kind !== "xtream") {
      continue;
    }

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
