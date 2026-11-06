import { redactCredentials } from "../playlist/redaction.ts";

/**
 * Turns an unknown rejection into a message that is safe to show.
 *
 * Tauri commands return `Result<_, String>`, so `invoke` rejects with a plain
 * string. `error instanceof Error` is therefore false on every command
 * failure, and the real reason is dropped in favour of a generic fallback.
 * Every invoke-backed catch funnels through here instead of pattern-matching
 * the rejection itself.
 *
 * The fallback is reserved for rejections that carry no usable text at all,
 * and every message is redacted before it reaches the UI, because raw reqwest
 * and keyring strings are now visible for the first time.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? redactCredentials(message) : fallback;
  }

  if (typeof error === "string") {
    const message = error.trim();
    return message.length > 0 ? redactCredentials(message) : fallback;
  }

  return fallback;
}
