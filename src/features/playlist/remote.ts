import { invoke } from "@tauri-apps/api/core";

const M3U_PREFIX_PATTERN = /^m3u\s*:\s*/i;

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

export async function downloadPlaylistFromUrl(rawInput: string) {
  const normalizedInput = normalizeUrlInput(rawInput);

  if (normalizedInput.length === 0) {
    throw new Error("Enter a playlist URL first.");
  }

  const playlistText = await invoke<string>("fetch_playlist_from_url", {
    url: normalizedInput,
  });

  return {
    fileName: getPlaylistFileNameFromUrl(normalizedInput),
    playlistText,
  };
}
