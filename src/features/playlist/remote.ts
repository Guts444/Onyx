import { invoke, isTauri } from "@tauri-apps/api/core";

const M3U_PREFIX_PATTERN = /^m3u\s*:\s*/i;
const BROWSER_PLAYLIST_DEADLINE_MS = 90_000;
const MAX_PLAYLIST_BYTES = 32 * 1024 * 1024;

function normalizeUrlInput(rawInput: string) {
  return rawInput.replace(M3U_PREFIX_PATTERN, "").trim();
}

export function getPlaylistFileNameFromUrl(rawInput: string) {
  const normalizedInput = normalizeUrlInput(rawInput);
  const parsedUrl = new URL(normalizedInput);
  const lastPathSegment = parsedUrl.pathname.split("/").filter(Boolean).pop() ?? "";

  if (lastPathSegment.endsWith(".m3u") || lastPathSegment.endsWith(".m3u8")) {
    return lastPathSegment;
  }

  return `${parsedUrl.hostname}-playlist.m3u`;
}

async function downloadPlaylistInBrowser(url: string, signal: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, BROWSER_PLAYLIST_DEADLINE_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`The request failed with HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PLAYLIST_BYTES) {
      throw new Error("The response is too large to import safely.");
    }

    if (!response.body) return await response.text();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_PLAYLIST_BYTES) {
        await reader.cancel();
        throw new Error("The response is too large to import safely.");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  } catch (error) {
    if (timedOut) throw new Error("The playlist import timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export async function cancelPlaylistOperation(operationId: string) {
  if (!isTauri()) return;
  await invoke("cancel_playlist_operation", { operationId });
}

export async function downloadPlaylistFromUrl(
  rawInput: string,
  operationId: string,
  signal: AbortSignal,
) {
  const normalizedInput = normalizeUrlInput(rawInput);

  if (normalizedInput.length === 0) {
    throw new Error("Enter a playlist URL first.");
  }

  const playlistText = isTauri()
    ? await invoke<string>("fetch_playlist_from_url", {
        url: normalizedInput,
        operationId,
      })
    : await downloadPlaylistInBrowser(normalizedInput, signal);

  if (playlistText.trim().length === 0) {
    throw new Error("The URL returned an empty playlist.");
  }

  return {
    fileName: getPlaylistFileNameFromUrl(normalizedInput),
    playlistText,
  };
}
