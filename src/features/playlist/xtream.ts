import { invoke } from "@tauri-apps/api/core";
import type { PlaylistImport } from "../../domain/iptv";
import { buildChannel, sanitizeLabel } from "./channelFactory";

interface XtreamChannelPayload {
  name: string;
  group: string;
  stream: string;
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
}

interface XtreamImportResponse {
  providerName: string;
  channels: XtreamChannelPayload[];
}

export async function importXtreamPlaylist(
  domain: string,
  username: string,
  password: string,
): Promise<PlaylistImport> {
  const response = await invoke<XtreamImportResponse>("fetch_xtream_live_channels", {
    domain,
    username,
    password,
  });

  const channels = response.channels.map((channel) =>
    buildChannel({
      name: channel.name,
      group: channel.group,
      stream: channel.stream,
      logo: channel.logo,
      tvgId: channel.tvgId,
      tvgName: channel.tvgName,
    }),
  );

  if (channels.length === 0) {
    throw new Error("The Xtream account returned no live channels.");
  }

  const groups = [...new Set(channels.map((channel) => channel.group))].sort((left, right) =>
    left.localeCompare(right),
  );

  return {
    name: sanitizeLabel(`${response.providerName} Xtream`, "Xtream playlist", 80),
    channels,
    groups,
    importedAt: new Date().toISOString(),
    disabledChannelCount: channels.filter((channel) => !channel.isPlayable).length,
    skippedEntryCount: 0,
  };
}
