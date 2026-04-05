export interface EpgSettings {
  url: string;
  autoUpdateEnabled: boolean;
  updateOnStartup: boolean;
  updateIntervalHours: number;
}

export const DEFAULT_EPG_SETTINGS: EpgSettings = {
  url: "",
  autoUpdateEnabled: false,
  updateOnStartup: true,
  updateIntervalHours: 24,
};

export const EPG_AUTO_UPDATE_OPTIONS = [2, 4, 6, 12, 24, 48] as const;

export interface EpgDirectoryChannel {
  id: string;
  displayNames: string[];
  icon: string | null;
}

export interface EpgDirectoryResponse {
  sourceUrl: string;
  fetchedAt: string;
  channelCount: number;
  programmeCount: number;
  channels: EpgDirectoryChannel[];
}

export interface EpgProgrammeSummary {
  startMs: number;
  stopMs: number | null;
  title: string;
  subTitle: string | null;
  description: string | null;
  icon: string | null;
}

export interface EpgProgrammeSnapshot {
  epgChannelId: string;
  current: EpgProgrammeSummary | null;
  next: EpgProgrammeSummary | null;
}

export interface EpgResolvedChannel {
  epgChannel: EpgDirectoryChannel;
  matchSource: "manual" | "auto";
}

export interface EpgResolvedGuide extends EpgResolvedChannel {
  current: EpgProgrammeSummary | null;
  next: EpgProgrammeSummary | null;
}

export type SavedEpgMappingStore = Record<string, Record<string, string>>;
