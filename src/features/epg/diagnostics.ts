const MAX_VISIBLE_WARNING_CATEGORIES = 3;

interface EpgDiagnosticInput {
  recovered: boolean;
  corrupt: boolean;
  warnings: string[];
}

interface EpgDirectoryDiagnosticInput extends EpgDiagnosticInput {
  skippedProgrammeCount: number;
}

function isStorageRepairWarning(warning: string) {
  const normalized = warning.toLowerCase();
  return (
    normalized.includes("recovered") &&
    normalized.includes("epg cache") &&
    normalized.includes("disk") &&
    (normalized.includes("could not be repaired") || normalized.includes("repair failed"))
  );
}

function categorizeParserWarning(warning: string) {
  const normalized = warning.toLowerCase();
  if (normalized.includes("timestamp") || normalized.includes("time")) {
    return "Some programmes had invalid times.";
  }
  if (normalized.includes("channel")) {
    return "Some programmes referenced missing channels.";
  }
  if (normalized.includes("xml") || normalized.includes("malformed") || normalized.includes("parse")) {
    return "Some malformed guide entries were skipped.";
  }
  return "Some guide entries could not be parsed.";
}

function formatSafeWarningCategories(warnings: string[]) {
  const categories: string[] = [];
  for (const warning of warnings) {
    if (isStorageRepairWarning(warning)) continue;
    const category = categorizeParserWarning(warning);
    if (!categories.includes(category)) categories.push(category);
    if (categories.length >= MAX_VISIBLE_WARNING_CATEGORIES) break;
  }
  return categories.map((category) => `Warning: ${category}`);
}

function formatRecoveryDiagnostics(input: EpgDiagnosticInput) {
  const messages: string[] = [];
  const repairFailed = input.recovered && input.warnings.some(isStorageRepairWarning);
  if (repairFailed) {
    const corruptDescription = input.corrupt ? " of the corrupt saved EPG cache" : "";
    messages.push(
      `A usable recovered copy${corruptDescription} is loaded in memory; disk repair failed and will retry on the next cache load.`,
    );
  } else if (input.recovered && input.corrupt) {
    messages.push("The corrupt saved EPG cache was recovered from backup.");
  } else if (input.recovered) {
    messages.push("The saved EPG cache was recovered from backup.");
  } else if (input.corrupt) {
    messages.push("The corrupt saved EPG cache was reset.");
  }
  return messages;
}

export function formatEpgDirectoryDiagnostics(input: EpgDirectoryDiagnosticInput) {
  const messages = formatRecoveryDiagnostics(input);
  if (input.skippedProgrammeCount > 0) {
    messages.unshift(`Skipped ${input.skippedProgrammeCount} malformed programmes.`);
  }
  messages.push(...formatSafeWarningCategories(input.warnings));
  return messages.join(" ");
}

export function formatEpgStoreDiagnostics(input: EpgDiagnosticInput) {
  const messages = formatRecoveryDiagnostics(input);
  messages.push(...formatSafeWarningCategories(input.warnings));
  return messages.join(" ");
}

export function sanitizeEpgSourceLabel(sourceLabel: string) {
  const trimmed = sourceLabel.trim();
  return /^[a-z0-9.-]+(?::\d+)?$/i.test(trimmed) ? trimmed : "EPG guide";
}

export function formatEpgFailureStatus(sourceLabel: string) {
  return `${sanitizeEpgSourceLabel(sourceLabel)}: the guide could not be updated.`;
}
