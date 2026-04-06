import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChannelEpgMatchDialog } from "./components/ChannelEpgMatchDialog";
import { ChannelShelf } from "./components/ChannelShelf";
import { ChannelSidebar } from "./components/ChannelSidebar";
import { PlayerPanel } from "./components/PlayerPanel";
import { SettingsDrawer, type SettingsTab } from "./components/SettingsDrawer";
import {
  createEpgSource,
  getEpgSourceLabel,
  isEpgSourceReady,
  normalizeEpgSources,
  updateEpgSource,
  type EpgDirectoryChannel,
  type EpgDirectoryResponse,
  type EpgProgrammeSnapshot,
  type EpgResolvedGuide,
  type EpgSource,
  type SavedEpgMappingStore,
} from "./domain/epg";
import type { Channel, LibraryView, PlaylistImport } from "./domain/iptv";
import type { PlaylistSnapshot, SavedPlaylistSource } from "./domain/sourceProfiles";
import {
  deleteEpgCache,
  getEpgProgrammeSnapshots,
  loadEpgCacheDirectories,
  refreshEpgCache,
} from "./features/epg/api";
import {
  createEpgChannelIndex,
  createEpgMappingScope,
  getChannelManualMappingKeys,
  normalizeEpgUrlKey,
  resolveEpgChannelMatch,
} from "./features/epg/matching";
import { DEFAULT_PLAYER_VOLUME, useMpvPlayer } from "./features/player/mpv";
import { parseM3u } from "./features/playlist/m3u";
import { downloadPlaylistFromUrl } from "./features/playlist/remote";
import { importXtreamPlaylist } from "./features/playlist/xtream";
import {
  createM3uUrlSource,
  createXtreamSource,
  isSourceProfileReady,
  markSourceLoaded,
  updateSourceProfile,
} from "./features/sources/profiles";
import { usePersistentState } from "./hooks/usePersistentState";
import { hashString } from "./utils/hash";
import "./App.css";

const FAVORITES_STORAGE_KEY = "iptv-player:favorites";
const RECENTS_STORAGE_KEY = "iptv-player:recents";
const GROUP_VISIBILITY_STORAGE_KEY = "iptv-player:hidden-groups";
const COLLAPSED_GROUPS_STORAGE_KEY = "iptv-player:collapsed-groups";
const SAVED_SOURCES_STORAGE_KEY = "iptv-player:saved-sources";
const ACTIVE_SOURCE_STORAGE_KEY = "iptv-player:active-source";
const PLAYLIST_SNAPSHOT_STORAGE_KEY = "iptv-player:playlist-snapshot";
const COLLAPSED_SOURCE_CARDS_STORAGE_KEY = "iptv-player:collapsed-source-cards";
const LEGACY_EPG_SETTINGS_STORAGE_KEY = "iptv-player:epg-settings";
const EPG_SOURCES_STORAGE_KEY = "iptv-player:epg-sources";
const EPG_MANUAL_MATCHES_STORAGE_KEY = "iptv-player:epg-manual-matches";
const PLAYER_RESUME_STORAGE_KEY = "iptv-player:playback-session";
const PLAYER_VOLUME_STORAGE_KEY = "iptv-player:player-volume";
const RECENT_CHANNEL_LIMIT = 12;
const FAVORITES_GROUP_ID = "__iptv_player_favorites__";

interface PlaybackSession {
  sourceId: string | null;
  channelId: string | null;
  shouldResume: boolean;
}

interface LegacyEpgSettings {
  url?: string;
  autoUpdateEnabled?: boolean;
  updateOnStartup?: boolean;
  updateIntervalHours?: number;
}

function pushRecentId(recentIds: string[], channelId: string) {
  const nextIds = [channelId];

  for (const id of recentIds) {
    if (nextIds.length >= RECENT_CHANNEL_LIMIT) {
      break;
    }

    if (id !== channelId) {
      nextIds.push(id);
    }
  }

  return nextIds;
}

function getPlaylistPreferenceKey(playlist: PlaylistImport | null) {
  if (!playlist) {
    return null;
  }

  return `library_${hashString(
    `${playlist.name}\u0001${playlist.channels.length}\u0001${playlist.groups.join("\u0001")}`,
  )}`;
}

function getEpgPlaylistScope(sourceId: string | null, playlist: PlaylistImport | null) {
  if (!playlist) {
    return null;
  }

  return sourceId ?? getPlaylistPreferenceKey(playlist) ?? `playlist_${hashString(playlist.name)}`;
}

function getUniqueReadyEpgSources(sources: EpgSource[], enabledOnly = false) {
  const seenUrlKeys = new Set<string>();
  const uniqueSources: EpgSource[] = [];

  for (const source of sources) {
    if (enabledOnly && !source.enabled) {
      continue;
    }

    if (!isEpgSourceReady(source)) {
      continue;
    }

    const urlKey = normalizeEpgUrlKey(source.url);

    if (!urlKey || seenUrlKeys.has(urlKey)) {
      continue;
    }

    seenUrlKeys.add(urlKey);
    uniqueSources.push(source);
  }

  return uniqueSources;
}

function readLegacyEpgSource() {
  try {
    const rawValue = window.localStorage.getItem(LEGACY_EPG_SETTINGS_STORAGE_KEY);

    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue) as LegacyEpgSettings;

    if (typeof parsedValue.url !== "string" || parsedValue.url.trim().length === 0) {
      return null;
    }

    return createEpgSource(parsedValue.url, {
      autoUpdateEnabled: parsedValue.autoUpdateEnabled === true,
      updateOnStartup: parsedValue.updateOnStartup !== false,
      updateIntervalHours: parsedValue.updateIntervalHours,
    });
  } catch {
    return null;
  }
}

function removeMappingsForGuideUrl(
  currentMappings: SavedEpgMappingStore,
  guideUrl: string,
) {
  const scopePrefix = `${normalizeEpgUrlKey(guideUrl)}\u0001`;
  const nextMappings = { ...currentMappings };

  for (const mappingScope of Object.keys(nextMappings)) {
    if (mappingScope.startsWith(scopePrefix)) {
      delete nextMappings[mappingScope];
    }
  }

  return nextMappings;
}

function App() {
  const [favoriteIds, setFavoriteIds] = usePersistentState<string[]>(FAVORITES_STORAGE_KEY, []);
  const [recentIds, setRecentIds] = usePersistentState<string[]>(RECENTS_STORAGE_KEY, []);
  const [hiddenGroupsByLibrary, setHiddenGroupsByLibrary] = usePersistentState<Record<string, string[]>>(
    GROUP_VISIBILITY_STORAGE_KEY,
    {},
  );
  const [collapsedGroupsByLibrary, setCollapsedGroupsByLibrary] = usePersistentState<
    Record<string, boolean>
  >(COLLAPSED_GROUPS_STORAGE_KEY, {});
  const [collapsedSourceIds, setCollapsedSourceIds] = usePersistentState<string[]>(
    COLLAPSED_SOURCE_CARDS_STORAGE_KEY,
    [],
  );
  const [savedSources, setSavedSources] = usePersistentState<Record<string, SavedPlaylistSource>>(
    SAVED_SOURCES_STORAGE_KEY,
    {},
    (parsedValue) => {
      if (Array.isArray(parsedValue)) {
        const record: Record<string, SavedPlaylistSource> = {};
        for (const source of parsedValue) {
          record[source.id] = source as SavedPlaylistSource;
        }
        return record;
      }
      return parsedValue as Record<string, SavedPlaylistSource>;
    }
  );
  const [activeSourceId, setActiveSourceId] = usePersistentState<string | null>(
    ACTIVE_SOURCE_STORAGE_KEY,
    null,
  );
  const [epgSources, setEpgSources] = usePersistentState<EpgSource[]>(
    EPG_SOURCES_STORAGE_KEY,
    [],
  );
  const [savedEpgMappings, setSavedEpgMappings] = usePersistentState<SavedEpgMappingStore>(
    EPG_MANUAL_MATCHES_STORAGE_KEY,
    {},
  );
  const [playbackSession, setPlaybackSession] = usePersistentState<PlaybackSession>(
    PLAYER_RESUME_STORAGE_KEY,
    {
      sourceId: null,
      channelId: null,
      shouldResume: false,
    },
  );
  const [savedVolume, setSavedVolume] = usePersistentState<number>(
    PLAYER_VOLUME_STORAGE_KEY,
    DEFAULT_PLAYER_VOLUME,
  );
  const [playlistSnapshot, setPlaylistSnapshot] = usePersistentState<PlaylistSnapshot | null>(
    PLAYLIST_SNAPSHOT_STORAGE_KEY,
    null,
  );
  const [playlist, setPlaylist] = useState<PlaylistImport | null>(() => playlistSnapshot?.playlist ?? null);
  const [activeView, setActiveView] = useState<LibraryView>("all");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    () => playlistSnapshot?.selectedChannelId ?? playlistSnapshot?.playlist.channels[0]?.id ?? null,
  );
  const [loadingSourceId, setLoadingSourceId] = useState<string | null>(null);
  const [isImportingFile, setIsImportingFile] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isRestoringStartupSource, setIsRestoringStartupSource] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("library");
  const [message, setMessage] = useState<string | null>(null);
  const [epgDirectoriesByUrlKey, setEpgDirectoriesByUrlKey] = useState<
    Record<string, EpgDirectoryResponse>
  >({});
  const [epgSnapshotsByChannelKey, setEpgSnapshotsByChannelKey] = useState<
    Record<string, EpgProgrammeSnapshot>
  >({});
  const [updatingEpgSourceIds, setUpdatingEpgSourceIds] = useState<string[]>([]);
  const [epgStatusMessage, setEpgStatusMessage] = useState<string | null>(null);
  const [matcherChannel, setMatcherChannel] = useState<Channel | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const playerShellRef = useRef<HTMLDivElement>(null);
  const playerSurfaceRef = useRef<HTMLDivElement>(null);
  const startupRestoreAttemptedRef = useRef(false);
  const startupPlaybackRestoreKeyRef = useRef<string | null>(null);
  const migratedLegacyEpgSettingsRef = useRef(false);
  const startupEpgRefreshAttemptedRef = useRef<Set<string>>(new Set());
  const epgRefreshPromiseRef = useRef<Map<string, Promise<EpgDirectoryResponse | null>>>(
    new Map(),
  );
  const { player, playChannel, reloadPlayback, setVolumeLevel, stopPlayback, toggleMute } =
    useMpvPlayer(playerSurfaceRef, isFullscreen ? "fullscreen" : "windowed", savedVolume);

  useEffect(() => {
    if (migratedLegacyEpgSettingsRef.current) {
      return;
    }

    migratedLegacyEpgSettingsRef.current = true;

    setEpgSources((currentSources) => {
      const normalizedSources = normalizeEpgSources(currentSources);

      if (normalizedSources.length > 0 || currentSources.length > 0) {
        return normalizedSources;
      }

      const legacySource = readLegacyEpgSource();
      return legacySource ? [legacySource] : normalizedSources;
    });
  }, [setEpgSources]);

  useEffect(() => {
    let cancelled = false;

    if (isTauri()) {
      void getCurrentWindow()
        .isFullscreen()
        .then((fullscreen) => {
          if (!cancelled) {
            setIsFullscreen(fullscreen);
          }
        })
        .catch(() => {
          // Window fullscreen state is a convenience for the UI.
        });

      return () => {
        cancelled = true;
      };
    }

    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      cancelled = true;
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen || !isTauri()) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      void handleToggleFullscreen();
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  useEffect(() => {
    const nextVolume = Math.max(0, Math.min(100, Math.round(player.volume)));

    setSavedVolume((currentValue) => (currentValue === nextVolume ? currentValue : nextVolume));
  }, [player.volume, setSavedVolume]);

  function schedulePlayerLayoutSync() {
    const syncDelays = [40, 140, 280];

    syncDelays.forEach((delay) => {
      window.setTimeout(() => {
        window.dispatchEvent(new Event("resize"));
      }, delay);
    });
  }

  async function applyImportedPlaylist(
    importedPlaylist: PlaylistImport,
    options?: {
      sourceId?: string | null;
      preferredChannelId?: string | null;
      preservePlaybackSession?: boolean;
    },
  ) {
    const nextSelectedChannelId =
      options?.preferredChannelId &&
      importedPlaylist.channels.some((channel) => channel.id === options.preferredChannelId)
        ? options.preferredChannelId
        : importedPlaylist.channels[0]?.id ?? null;
    const nextSourceId = options?.sourceId ?? null;

    await stopPlayback();
    setPlaylistSnapshot({
      sourceId: nextSourceId,
      playlist: importedPlaylist,
      selectedChannelId: nextSelectedChannelId,
      savedAt: new Date().toISOString(),
    });
    setActiveSourceId(nextSourceId);

    if (!options?.preservePlaybackSession) {
      setPlaybackSession((currentSession) => ({
        ...currentSession,
        sourceId: nextSourceId,
        channelId: nextSelectedChannelId,
        shouldResume: false,
      }));
    }

    startTransition(() => {
      setPlaylist(importedPlaylist);
      setSelectedChannelId(nextSelectedChannelId);
      setActiveView("all");
      setActiveGroup(null);
      setSearchQuery("");
      setMessage(null);
      setIsSettingsOpen(false);
    });
  }

  function persistSelectedChannel(channelId: string | null) {
    if (!playlist) {
      return;
    }

    setPlaylistSnapshot({
      sourceId: activeSourceId,
      playlist,
      selectedChannelId: channelId,
      savedAt: new Date().toISOString(),
    });
  }

  async function importFromSavedSource(
    source: SavedPlaylistSource,
    options?: {
      preservePlaybackSession?: boolean;
    },
  ) {
    let importedPlaylist: PlaylistImport;

    if (source.kind === "m3u_url") {
      const { fileName, playlistText } = await downloadPlaylistFromUrl(source.url);
      importedPlaylist = parseM3u(playlistText, fileName);
    } else {
      importedPlaylist = await importXtreamPlaylist(source.domain, source.username, source.password);
    }

    await applyImportedPlaylist(importedPlaylist, {
      sourceId: source.id,
      preferredChannelId:
        playlistSnapshot?.sourceId === source.id ? playlistSnapshot.selectedChannelId : null,
      preservePlaybackSession: options?.preservePlaybackSession,
    });
    setSavedSources((currentSources) => {
      const currentSource = currentSources[source.id];
      if (!currentSource) return currentSources;
      return {
        ...currentSources,
        [source.id]: markSourceLoaded(currentSource),
      };
    });
  }

  const startupSourceToRestore =
    activeSourceId && savedSources[activeSourceId] && isSourceProfileReady(savedSources[activeSourceId])
      ? savedSources[activeSourceId]
      : null;
  const shouldDelayResumeForStartupRestore =
    !startupRestoreAttemptedRef.current && startupSourceToRestore !== null;

  useEffect(() => {
    if (startupRestoreAttemptedRef.current) {
      return;
    }

    startupRestoreAttemptedRef.current = true;

    if (!startupSourceToRestore) {
      return;
    }

    setIsRestoringStartupSource(true);

    void importFromSavedSource(startupSourceToRestore, {
      preservePlaybackSession: true,
    })
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : "The saved source could not be refreshed.";
        setMessage(errorMessage);
      })
      .finally(() => {
        setIsRestoringStartupSource(false);
      });
  }, [startupSourceToRestore]);

  async function handleImportFile(file: File) {
    setIsImportingFile(true);

    try {
      const playlistText = await file.text();
      const importedPlaylist = parseM3u(playlistText, file.name);
      await applyImportedPlaylist(importedPlaylist, {
        sourceId: null,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "The playlist could not be imported.";
      setMessage(errorMessage);
    } finally {
      setIsImportingFile(false);
    }
  }

  function handleToggleFavorite(channelId: string) {
    setFavoriteIds((currentIds) =>
      currentIds.includes(channelId)
        ? currentIds.filter((id) => id !== channelId)
        : [...currentIds, channelId],
    );
  }

  async function handleSelectChannel(channel: Channel) {
    setSelectedChannelId(channel.id);
    persistSelectedChannel(channel.id);
    setRecentIds((currentIds) => pushRecentId(currentIds, channel.id));

    if (!channel.isPlayable) {
      setPlaybackSession((currentSession) => ({
        ...currentSession,
        sourceId: activeSourceId,
        channelId: channel.id,
        shouldResume: false,
      }));
      await stopPlayback();
      return;
    }

    const didStartPlayback = await playChannel(channel);

    setPlaybackSession((currentSession) => ({
      ...currentSession,
      sourceId: activeSourceId,
      channelId: channel.id,
      shouldResume: didStartPlayback,
    }));
  }

  async function handleStopPlayback() {
    setPlaybackSession((currentSession) => ({
      ...currentSession,
      sourceId: activeSourceId,
      channelId: selectedChannelId,
      shouldResume: false,
    }));

    await stopPlayback();
  }

  async function handleToggleFullscreen() {
    try {
      if (isTauri()) {
        const appWindow = getCurrentWindow();
        const nextFullscreen = !(await appWindow.isFullscreen());

        await appWindow.setFullscreen(nextFullscreen);
        setIsFullscreen(nextFullscreen);
        schedulePlayerLayoutSync();
        return;
      }

      if (!playerShellRef.current) {
        return;
      }

      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setIsFullscreen(false);
        schedulePlayerLayoutSync();
        return;
      }

      await playerShellRef.current.requestFullscreen();
      setIsFullscreen(true);
      schedulePlayerLayoutSync();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Fullscreen mode could not be changed.";
      setMessage(errorMessage);
    }
  }

  async function handleLoadSavedSource(sourceId: string) {
    const source = savedSources[sourceId];

    if (!source) {
      return;
    }

    if (!isSourceProfileReady(source)) {
      setMessage("Complete the saved source details and enable it before loading.");
      return;
    }

    setLoadingSourceId(sourceId);

    try {
      await importFromSavedSource(source);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "The saved source could not be loaded.";
      setMessage(errorMessage);
    } finally {
      setLoadingSourceId(null);
    }
  }

  function handleAddM3uProfile() {
    const newSource = createM3uUrlSource();
    setSavedSources((currentSources) => ({
      ...currentSources,
      [newSource.id]: newSource,
    }));
  }

  function handleAddXtreamProfile() {
    const newSource = createXtreamSource();
    setSavedSources((currentSources) => ({
      ...currentSources,
      [newSource.id]: newSource,
    }));
  }

  function handleToggleSourceEnabled(sourceId: string) {
    setSavedSources((currentSources) => {
      const source = currentSources[sourceId];
      if (!source) return currentSources;
      return {
        ...currentSources,
        [sourceId]: updateSourceProfile(source, {
          enabled: !source.enabled,
        }),
      };
    });
  }

  function handleUpdateSource(sourceId: string, patch: Partial<SavedPlaylistSource>) {
    setSavedSources((currentSources) => {
      const source = currentSources[sourceId];
      if (!source) return currentSources;
      return {
        ...currentSources,
        [sourceId]: updateSourceProfile(source, patch),
      };
    });
  }

  function openSettings(tab: SettingsTab) {
    setSettingsTab(tab);
    setIsSettingsOpen(true);
  }

  function handleAddEpgSource() {
    setEpgSources((currentSources) => [...currentSources, createEpgSource()]);
  }

  function handleToggleEpgSourceEnabled(sourceId: string) {
    setEpgSources((currentSources) =>
      currentSources.map((source) =>
        source.id === sourceId
          ? updateEpgSource(source, {
              enabled: !source.enabled,
            })
          : source,
      ),
    );
  }

  function handleUpdateEpgSource(sourceId: string, patch: Partial<EpgSource>) {
    setEpgSources((currentSources) =>
      currentSources.map((source) =>
        source.id === sourceId ? updateEpgSource(source, patch) : source,
      ),
    );

    if (patch.url !== undefined && patch.url.trim().length === 0) {
      setEpgStatusMessage(null);
      setEpgSnapshotsByChannelKey({});
    }
  }

  function handleRemoveEpgSource(sourceId: string) {
    const sourceToRemove = epgSources.find((source) => source.id === sourceId);

    if (!sourceToRemove) {
      return;
    }

    const removedGuideUrlKey = normalizeEpgUrlKey(sourceToRemove.url);
    const hasOtherGuideForUrl =
      removedGuideUrlKey.length > 0 &&
      epgSources.some(
        (source) =>
          source.id !== sourceId && normalizeEpgUrlKey(source.url) === removedGuideUrlKey,
      );

    setEpgSources((currentSources) =>
      currentSources.filter((source) => source.id !== sourceId),
    );
    setUpdatingEpgSourceIds((currentIds) =>
      currentIds.filter((currentId) => currentId !== sourceId),
    );
    epgRefreshPromiseRef.current.delete(sourceId);

    if (!removedGuideUrlKey || hasOtherGuideForUrl) {
      setEpgStatusMessage(`Removed ${getEpgSourceLabel(sourceToRemove)}.`);
      return;
    }

    setEpgDirectoriesByUrlKey((currentDirectories) => {
      const nextDirectories = { ...currentDirectories };
      delete nextDirectories[removedGuideUrlKey];
      return nextDirectories;
    });
    setEpgSnapshotsByChannelKey((currentSnapshots) => {
      const nextSnapshots = { ...currentSnapshots };

      for (const snapshotKey of Object.keys(nextSnapshots)) {
        if (snapshotKey.startsWith(`${removedGuideUrlKey}\u0001`)) {
          delete nextSnapshots[snapshotKey];
        }
      }

      return nextSnapshots;
    });
    setSavedEpgMappings((currentMappings) =>
      removeMappingsForGuideUrl(currentMappings, sourceToRemove.url),
    );
    setEpgStatusMessage(`Removed ${getEpgSourceLabel(sourceToRemove)}.`);

    void deleteEpgCache(sourceToRemove.url).catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : "The guide cache could not be removed.";
      setEpgStatusMessage(errorMessage);
    });
  }

  async function refreshEpgGuideForSource(
    source: EpgSource,
    reason: "manual" | "startup" | "auto",
  ) {
    const rawGuideUrl = source.url.trim();
    const sourceLabel = getEpgSourceLabel(source);

    if (rawGuideUrl.length === 0) {
      const statusCopy = `Enter an EPG URL first for ${sourceLabel}.`;
      setEpgStatusMessage(statusCopy);

      if (reason === "manual") {
        setMessage(statusCopy);
      }

      return null;
    }

    const existingPromise = epgRefreshPromiseRef.current.get(source.id);

    if (existingPromise) {
      return existingPromise;
    }

    setUpdatingEpgSourceIds((currentIds) =>
      currentIds.includes(source.id) ? currentIds : [...currentIds, source.id],
    );

    const refreshPromise = refreshEpgCache(rawGuideUrl)
      .then((directory) => {
        const urlKey = normalizeEpgUrlKey(directory.sourceUrl);

        setEpgDirectoriesByUrlKey((currentDirectories) => ({
          ...currentDirectories,
          [urlKey]: directory,
        }));
        setEpgStatusMessage(
          `${getEpgSourceLabel(directory.sourceUrl)} updated ${new Date(directory.fetchedAt).toLocaleString()}.`,
        );
        return directory;
      })
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : "The guide could not be updated.";
        const statusCopy = `${sourceLabel}: ${errorMessage}`;

        setEpgStatusMessage(statusCopy);

        if (reason === "manual") {
          setMessage(statusCopy);
        }

        return null;
      })
      .finally(() => {
        epgRefreshPromiseRef.current.delete(source.id);
        setUpdatingEpgSourceIds((currentIds) =>
          currentIds.filter((currentId) => currentId !== source.id),
        );
      });

    epgRefreshPromiseRef.current.set(source.id, refreshPromise);
    return refreshPromise;
  }

  const normalizedEpgSources = useMemo(() => normalizeEpgSources(epgSources), [epgSources]);
  const uniqueReadyEpgSources = useMemo(
    () => getUniqueReadyEpgSources(normalizedEpgSources),
    [normalizedEpgSources],
  );
  const enabledReadyEpgSources = useMemo(
    () => getUniqueReadyEpgSources(normalizedEpgSources, true),
    [normalizedEpgSources],
  );

  async function handleRefreshEpgSource(sourceId: string) {
    const source = normalizedEpgSources.find((currentSource) => currentSource.id === sourceId);

    if (!source) {
      return;
    }

    await refreshEpgGuideForSource(source, "manual");
  }

  async function handleRefreshEnabledEpgSources() {
    if (enabledReadyEpgSources.length === 0) {
      const statusCopy = "Add and enable at least one EPG URL first.";
      setEpgStatusMessage(statusCopy);
      setMessage(statusCopy);
      return;
    }

    await Promise.all(
      enabledReadyEpgSources.map((source) => refreshEpgGuideForSource(source, "manual")),
    );
  }

  const epgSourceUrlsKey = useMemo(
    () =>
      uniqueReadyEpgSources
        .map((source) => normalizeEpgUrlKey(source.url))
        .join("\u0001"),
    [uniqueReadyEpgSources],
  );

  const channels = playlist?.channels ?? [];
  const channelsById = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const channel of channels) {
      map.set(channel.id, channel);
    }
    return map;
  }, [channels]);
  const allGroups = playlist?.groups ?? [];
  const activeSource = activeSourceId ? savedSources[activeSourceId] ?? null : null;
  const playlistEpgScope = getEpgPlaylistScope(activeSourceId, playlist);
  const savedMappingsForEnabledGuides = useMemo(
    () =>
      playlistEpgScope
        ? enabledReadyEpgSources.map((source) => ({
            sourceUrl: source.url,
            mappings:
              savedEpgMappings[createEpgMappingScope(playlistEpgScope, source.url)] ?? {},
          }))
        : [],
    [enabledReadyEpgSources, playlistEpgScope, savedEpgMappings],
  );
  const enabledEpgDirectories = useMemo(
    () =>
      enabledReadyEpgSources
        .map((source) => epgDirectoriesByUrlKey[normalizeEpgUrlKey(source.url)] ?? null)
        .filter((directory): directory is EpgDirectoryResponse => directory !== null),
    [enabledReadyEpgSources, epgDirectoriesByUrlKey],
  );
  const enabledEpgDirectoryKey = useMemo(
    () =>
      enabledEpgDirectories
        .map(
          (directory) =>
            `${normalizeEpgUrlKey(directory.sourceUrl)}\u0001${directory.fetchedAt}`,
        )
        .join("\u0001"),
    [enabledEpgDirectories],
  );
  const enabledEpgChannels = useMemo(
    () => enabledEpgDirectories.flatMap((directory) => directory.channels),
    [enabledEpgDirectories],
  );
  const epgChannelIndex = useMemo(
    () => createEpgChannelIndex(enabledEpgChannels),
    [enabledEpgChannels],
  );
  const playlistDisplayName =
    playlist !== null
      ? activeSource?.name.trim().length
        ? activeSource.name.trim()
        : playlist.name
      : null;
  const selectedChannel =
    (selectedChannelId !== null ? channelsById.get(selectedChannelId) : null) ?? channels[0] ?? null;
  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const playlistPreferenceKey = getPlaylistPreferenceKey(playlist);
  const hiddenGroups = playlistPreferenceKey ? hiddenGroupsByLibrary[playlistPreferenceKey] ?? [] : [];
  const hiddenGroupSet = useMemo(() => new Set(hiddenGroups), [hiddenGroups]);
  const favoriteIdSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const recentIdSet = useMemo(() => new Set(recentIds), [recentIds]);
  const enabledGroups = useMemo(
    () => allGroups.filter((group) => !hiddenGroupSet.has(group)),
    [allGroups, hiddenGroupSet],
  );
  const enabledGroupSet = useMemo(() => new Set(enabledGroups), [enabledGroups]);
  const favoriteChannels = useMemo(
    () => channels.filter((channel) => favoriteIdSet.has(channel.id)),
    [channels, favoriteIdSet],
  );
  const resolvedEpgMatchesByChannelId = useMemo(() => {
    const nextMatches: Record<string, { epgChannel: EpgDirectoryChannel; matchSource: "manual" | "auto" }> = {};

    for (const channel of channels) {
      const resolvedMatch = resolveEpgChannelMatch(
        channel,
        savedMappingsForEnabledGuides,
        epgChannelIndex,
      );

      if (resolvedMatch) {
        nextMatches[channel.id] = resolvedMatch;
      }
    }

    return nextMatches;
  }, [channels, epgChannelIndex, savedMappingsForEnabledGuides]);
  const recentChannels = useMemo(
    () =>
      recentIds
        .map((recentId) => channelsById.get(recentId) ?? null)
        .filter((channel): channel is Channel => channel !== null),
    [channelsById, recentIds],
  );
  const channelCountByGroup = useMemo(() => {
    const counts: Record<string, number> = {};

    for (const channel of channels) {
      counts[channel.group] = (counts[channel.group] ?? 0) + 1;
    }

    return counts;
  }, [channels]);
  const getGuideByChannelId = useCallback((channelId: string): EpgResolvedGuide | null => {
    const resolvedMatch = resolvedEpgMatchesByChannelId[channelId];

    if (!resolvedMatch) {
      return null;
    }

    const guideSnapshot = epgSnapshotsByChannelKey[resolvedMatch.epgChannel.uniqueId];

    return {
      ...resolvedMatch,
      current: guideSnapshot?.current ?? null,
      next: guideSnapshot?.next ?? null,
    };
  }, [epgSnapshotsByChannelKey, resolvedEpgMatchesByChannelId]);
  const matchedEpgChannelCount = useMemo(
    () => Object.keys(resolvedEpgMatchesByChannelId).length,
    [resolvedEpgMatchesByChannelId],
  );
  const savedSourcesList = useMemo(() => Object.values(savedSources), [savedSources]);

  function updateHiddenGroups(nextHiddenGroups: string[]) {
    if (!playlistPreferenceKey) {
      return;
    }

    setHiddenGroupsByLibrary((currentValue) => ({
      ...currentValue,
      [playlistPreferenceKey]: [...new Set(nextHiddenGroups)].sort((left, right) =>
        left.localeCompare(right),
      ),
    }));
  }

  function handleToggleGroup(group: string) {
    if (!playlistPreferenceKey) {
      return;
    }

    updateHiddenGroups(
      hiddenGroupSet.has(group)
        ? hiddenGroups.filter((hiddenGroup) => hiddenGroup !== group)
        : [...hiddenGroups, group],
    );
  }

  function handleEnableAllGroups() {
    updateHiddenGroups([]);
  }

  function handleDisableAllGroups() {
    updateHiddenGroups(allGroups);
    setActiveGroup(null);
  }

  function handleToggleGroupsCollapsed() {
    if (!playlistPreferenceKey) {
      return;
    }

    setCollapsedGroupsByLibrary((currentValue) => ({
      ...currentValue,
      [playlistPreferenceKey]: !(currentValue[playlistPreferenceKey] ?? false),
    }));
  }

  function handleToggleSourceCollapsed(sourceId: string) {
    setCollapsedSourceIds((currentIds) =>
      currentIds.includes(sourceId)
        ? currentIds.filter((currentId) => currentId !== sourceId)
        : [...currentIds, sourceId],
    );
  }

  function handleSelectFavoritesGroup() {
    setActiveGroup(FAVORITES_GROUP_ID);
    setActiveView("all");
  }

  const visibleChannels = useMemo(() => {
    let result =
      activeView === "recents"
        ? recentChannels
        : activeGroup === FAVORITES_GROUP_ID
        ? favoriteChannels
        : activeGroup && enabledGroupSet.has(activeGroup)
        ? channels.filter((channel) => channel.group === activeGroup)
        : [];

    if (activeView === "favorites" && activeGroup !== FAVORITES_GROUP_ID) {
      result = result.filter((channel) => favoriteIdSet.has(channel.id));
    }

    if (normalizedSearchQuery.length > 0) {
      result = result.filter((channel) =>
        channel.name.toLowerCase().includes(normalizedSearchQuery),
      );
    }

    return result;
  }, [
    activeView,
    activeGroup,
    recentChannels,
    favoriteChannels,
    enabledGroupSet,
    channels,
    favoriteIdSet,
    normalizedSearchQuery,
  ]);

  const selectedGuide = selectedChannel ? getGuideByChannelId(selectedChannel.id) ?? null : null;
  const visibleEpgChannelKeys = [
    ...new Set(
      [
        ...visibleChannels.map((channel) => getGuideByChannelId(channel.id)?.epgChannel.uniqueId ?? null),
        selectedGuide?.epgChannel.uniqueId ?? null,
      ].filter((channelKey): channelKey is string => channelKey !== null),
    ),
  ];
  const visibleEpgChannelKeysKey = visibleEpgChannelKeys.join("\u0001");
  const favoritesCount = favoriteChannels.length;
  const groupsCollapsed = playlistPreferenceKey
    ? collapsedGroupsByLibrary[playlistPreferenceKey] ?? false
    : false;
  const activeGroupLabel =
    activeView === "recents"
      ? "Recent Channels"
      : activeGroup === FAVORITES_GROUP_ID
      ? "Favorites"
      : activeGroup;
  const isFavoritesGroupActive = activeGroup === FAVORITES_GROUP_ID;

  function handleOpenEpgMatcher(channel: Channel) {
    if (enabledEpgChannels.length === 0) {
      setMessage(
        "Load and enable at least one EPG guide first, then you can match channels from the EPG button.",
      );
      openSettings("epg");
      return;
    }

    setMatcherChannel(channel);
  }

  function handleApplyManualEpgMatch(channel: Channel, epgChannel: EpgDirectoryChannel) {
    if (!playlistEpgScope) {
      setMessage("Load a source and configure an EPG guide before saving manual matches.");
      return;
    }

    const mappingKeys = getChannelManualMappingKeys(channel);
    const scopedGuideUrls = new Set(uniqueReadyEpgSources.map((source) => source.url));
    scopedGuideUrls.add(epgChannel.sourceUrl);

    setSavedEpgMappings((currentMappings) => {
      const nextMappings = { ...currentMappings };

      for (const guideUrl of scopedGuideUrls) {
        const mappingScope = createEpgMappingScope(playlistEpgScope, guideUrl);
        const existingMappings = nextMappings[mappingScope];

        if (!existingMappings) {
          continue;
        }

        let hasChanges = false;
        let scopedMappings: Record<string, string> | undefined;

        for (const mappingKey of mappingKeys) {
          if (Object.prototype.hasOwnProperty.call(existingMappings, mappingKey)) {
            if (!scopedMappings) {
              scopedMappings = { ...existingMappings };
            }
            delete scopedMappings[mappingKey];
            hasChanges = true;
          }
        }

        const finalMappings = hasChanges && scopedMappings ? scopedMappings : existingMappings;

        if (Object.keys(finalMappings).length === 0) {
          delete nextMappings[mappingScope];
        } else if (hasChanges) {
          nextMappings[mappingScope] = finalMappings;
        }
      }

      const targetMappingScope = createEpgMappingScope(playlistEpgScope, epgChannel.sourceUrl);
      const targetMappings = {
        ...(nextMappings[targetMappingScope] ?? {}),
      };

      for (const mappingKey of mappingKeys) {
        targetMappings[mappingKey] = epgChannel.id;
      }

      nextMappings[targetMappingScope] = targetMappings;
      return nextMappings;
    });

    setMatcherChannel(null);
    setEpgStatusMessage(
      `Matched ${channel.name} to ${epgChannel.displayNames[0] ?? epgChannel.id} from ${getEpgSourceLabel(epgChannel.sourceUrl)}.`,
    );
  }

  function handleClearManualEpgMatch(channel: Channel) {
    if (!playlistEpgScope) {
      return;
    }

    const mappingKeys = getChannelManualMappingKeys(channel);
    const scopedGuideUrls = new Set(uniqueReadyEpgSources.map((source) => source.url));

    setSavedEpgMappings((currentMappings) => {
      const nextMappings = { ...currentMappings };

      for (const guideUrl of scopedGuideUrls) {
        const mappingScope = createEpgMappingScope(playlistEpgScope, guideUrl);
        const existingMappings = nextMappings[mappingScope];

        if (!existingMappings) {
          continue;
        }

        let hasChanges = false;
        let scopedMappings: Record<string, string> | undefined;

        for (const mappingKey of mappingKeys) {
          if (Object.prototype.hasOwnProperty.call(existingMappings, mappingKey)) {
            if (!scopedMappings) {
              scopedMappings = { ...existingMappings };
            }
            delete scopedMappings[mappingKey];
            hasChanges = true;
          }
        }

        const finalMappings = hasChanges && scopedMappings ? scopedMappings : existingMappings;

        if (Object.keys(finalMappings).length === 0) {
          delete nextMappings[mappingScope];
        } else if (hasChanges) {
          nextMappings[mappingScope] = finalMappings;
        }
      }

      return nextMappings;
    });

    setEpgStatusMessage(`Cleared the manual guide match for ${channel.name}.`);
  }

  useEffect(() => {
    let cancelled = false;

    void loadEpgCacheDirectories()
      .then((cachedDirectories) => {
        if (cancelled) {
          return;
        }

        const nextDirectories: Record<string, EpgDirectoryResponse> = {};

        for (const directory of cachedDirectories) {
          const urlKey = normalizeEpgUrlKey(directory.sourceUrl);

          if (!urlKey) {
            continue;
          }

          nextDirectories[urlKey] = directory;
        }

        setEpgDirectoriesByUrlKey(nextDirectories);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        const errorMessage =
          error instanceof Error ? error.message : "The saved guide cache could not be loaded.";
        setEpgStatusMessage(errorMessage);
      });

    return () => {
      cancelled = true;
    };
  }, [epgSourceUrlsKey]);

  useEffect(() => {
    for (const source of enabledReadyEpgSources) {
      const startupKey = `${source.id}\u0001${normalizeEpgUrlKey(source.url)}\u0001${
        source.updateOnStartup ? "enabled" : "disabled"
      }`;

      if (startupEpgRefreshAttemptedRef.current.has(startupKey)) {
        continue;
      }

      startupEpgRefreshAttemptedRef.current.add(startupKey);

      if (!source.updateOnStartup) {
        continue;
      }

      void refreshEpgGuideForSource(source, "startup");
    }
  }, [enabledReadyEpgSources]);

  const autoUpdatingGuideKey = useMemo(
    () =>
      enabledReadyEpgSources
        .map((source) =>
          source.autoUpdateEnabled
            ? `${source.id}\u0001${normalizeEpgUrlKey(source.url)}\u0001${source.updateIntervalHours}`
            : `${source.id}\u0001${normalizeEpgUrlKey(source.url)}\u00010`,
        )
        .join("\u0001"),
    [enabledReadyEpgSources],
  );

  useEffect(() => {
    const timerIds = enabledReadyEpgSources
      .filter((source) => source.autoUpdateEnabled)
      .map((source) =>
        window.setInterval(() => {
          void refreshEpgGuideForSource(source, "auto");
        }, Math.max(1, source.updateIntervalHours) * 60 * 60 * 1000),
      );

    return () => {
      timerIds.forEach((timerId) => {
        window.clearInterval(timerId);
      });
    };
  }, [autoUpdatingGuideKey, enabledReadyEpgSources]);

  useEffect(() => {
    let cancelled = false;

    if (enabledEpgDirectories.length === 0 || visibleEpgChannelKeys.length === 0) {
      setEpgSnapshotsByChannelKey({});
      return () => {
        cancelled = true;
      };
    }

    void getEpgProgrammeSnapshots(visibleEpgChannelKeys)
      .then((snapshots) => {
        if (cancelled) {
          return;
        }

        const nextSnapshots: Record<string, EpgProgrammeSnapshot> = {};

        for (const snapshot of snapshots) {
          nextSnapshots[snapshot.epgChannelKey] = snapshot;
        }

        setEpgSnapshotsByChannelKey(nextSnapshots);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        const errorMessage =
          error instanceof Error ? error.message : "The current guide schedule could not be loaded.";
        setEpgStatusMessage(errorMessage);
      });

    return () => {
      cancelled = true;
    };
  }, [enabledEpgDirectoryKey, visibleEpgChannelKeysKey]);

  useEffect(() => {
    if (!playlist) {
      if (activeGroup !== null) {
        setActiveGroup(null);
      }

      return;
    }

    const hasValidActiveGroup =
      activeGroup === FAVORITES_GROUP_ID || (activeGroup !== null && enabledGroupSet.has(activeGroup));

    if (!hasValidActiveGroup) {
      setActiveGroup(enabledGroups[0] ?? FAVORITES_GROUP_ID);
    }
  }, [activeGroup, enabledGroupSet, enabledGroups, playlist]);

  useEffect(() => {
    if (
      !playlist ||
      playbackSession.channelId === null ||
      !playbackSession.shouldResume ||
      player.environment !== "tauri" ||
      !player.ready ||
      shouldDelayResumeForStartupRestore ||
      isRestoringStartupSource ||
      playbackSession.sourceId !== activeSourceId
    ) {
      return;
    }

    const channelToResume =
      (playbackSession.channelId !== null ? channelsById.get(playbackSession.channelId) : null) ?? null;

    if (!channelToResume || !channelToResume.isPlayable) {
      return;
    }

    const restoreKey = `${activeSourceId ?? "local"}\u0001${playlist.importedAt}\u0001${channelToResume.id}`;

    if (startupPlaybackRestoreKeyRef.current === restoreKey) {
      return;
    }

    startupPlaybackRestoreKeyRef.current = restoreKey;
    setSelectedChannelId(channelToResume.id);
    persistSelectedChannel(channelToResume.id);
    setRecentIds((currentIds) => pushRecentId(currentIds, channelToResume.id));

    void playChannel(channelToResume).then((didStartPlayback) => {
      setPlaybackSession((currentSession) =>
        currentSession.sourceId === activeSourceId && currentSession.channelId === channelToResume.id
          ? {
              ...currentSession,
              shouldResume: didStartPlayback,
            }
          : currentSession,
      );
    });
  }, [
    activeSourceId,
    channelsById,
    isRestoringStartupSource,
    playbackSession,
    player.environment,
    player.ready,
    playlist,
    setPlaybackSession,
    setRecentIds,
    shouldDelayResumeForStartupRestore,
  ]);

  return (
    <main className={`app-shell ${isFullscreen ? "app-shell--fullscreen" : ""}`}>
      {isFullscreen ? (
        <PlayerPanel
          player={player}
          selectedChannel={selectedChannel}
          guide={selectedGuide}
          isFullscreen={isFullscreen}
          playerShellRef={playerShellRef}
          playerSurfaceRef={playerSurfaceRef}
          onStop={() => {
            void handleStopPlayback();
          }}
          onReload={() => {
            void reloadPlayback();
          }}
          onToggleMute={() => {
            void toggleMute();
          }}
          onSetVolume={(volume) => {
            const nextVolume = Math.max(0, Math.min(100, Math.round(volume)));

            setSavedVolume(nextVolume);
            void setVolumeLevel(nextVolume);
          }}
          onToggleFullscreen={() => {
            void handleToggleFullscreen();
          }}
        />
      ) : (
        <div className="workspace">
          <ChannelSidebar
            playlistName={playlistDisplayName}
            enabledGroups={enabledGroups}
            isFavoritesActive={isFavoritesGroupActive}
            activeGroup={activeGroup}
            favoritesCount={favoritesCount}
            channelCountByGroup={channelCountByGroup}
            groupsCollapsed={groupsCollapsed}
            message={message}
            onSelectGroup={setActiveGroup}
            onSelectFavorites={handleSelectFavoritesGroup}
            onToggleGroupsCollapsed={handleToggleGroupsCollapsed}
            onOpenSettings={() => {
              openSettings(playlist ? "library" : "sources");
            }}
          />

          <section className="stage">
            <PlayerPanel
              player={player}
              selectedChannel={selectedChannel}
              guide={selectedGuide}
              isFullscreen={isFullscreen}
              playerShellRef={playerShellRef}
              playerSurfaceRef={playerSurfaceRef}
              onStop={() => {
                void handleStopPlayback();
              }}
              onReload={() => {
                void reloadPlayback();
              }}
              onToggleMute={() => {
                void toggleMute();
              }}
              onSetVolume={(volume) => {
                const nextVolume = Math.max(0, Math.min(100, Math.round(volume)));

                setSavedVolume(nextVolume);
                void setVolumeLevel(nextVolume);
              }}
              onToggleFullscreen={() => {
                void handleToggleFullscreen();
              }}
            />

            <ChannelShelf
              activeGroupLabel={activeGroupLabel}
              isFavoritesGroup={activeView !== "recents" && isFavoritesGroupActive}
              channels={visibleChannels}
              selectedChannelId={selectedChannel?.id ?? null}
              activeView={activeView}
              searchQuery={searchQuery}
              favoriteIdSet={favoriteIdSet}
              recentIdSet={recentIdSet}
              getGuideByChannelId={getGuideByChannelId}
              canMatchEpg={enabledEpgChannels.length > 0}
              onSearchChange={setSearchQuery}
              onSelectView={setActiveView}
              onSelectChannel={handleSelectChannel}
              onToggleFavorite={handleToggleFavorite}
              onOpenEpgMatcher={handleOpenEpgMatcher}
            />
          </section>
        </div>
      )}

      <SettingsDrawer
        isOpen={isSettingsOpen}
        activeTab={settingsTab}
        playlist={playlist}
        playlistDisplayName={playlistDisplayName}
        channelCountByGroup={channelCountByGroup}
        enabledGroups={enabledGroups}
        hiddenGroups={hiddenGroups}
        epgSources={normalizedEpgSources}
        epgDirectoriesByUrlKey={epgDirectoriesByUrlKey}
        matchedEpgChannelCount={matchedEpgChannelCount}
        updatingEpgSourceIds={updatingEpgSourceIds}
        epgStatusMessage={epgStatusMessage}
        savedSources={savedSourcesList}
        activeSourceId={activeSourceId}
        collapsedSourceIds={collapsedSourceIds}
        loadingSourceId={loadingSourceId}
        isImportingFile={isImportingFile}
        notice={message}
        onClose={() => setIsSettingsOpen(false)}
        onSelectTab={setSettingsTab}
        onEnableAllGroups={handleEnableAllGroups}
        onDisableAllGroups={handleDisableAllGroups}
        onToggleGroup={handleToggleGroup}
        onAddEpgSource={handleAddEpgSource}
        onToggleEpgSourceEnabled={handleToggleEpgSourceEnabled}
        onRemoveEpgSource={handleRemoveEpgSource}
        onUpdateEpgSource={handleUpdateEpgSource}
        onRefreshEpgSource={(sourceId) => {
          void handleRefreshEpgSource(sourceId);
        }}
        onRefreshEnabledEpgSources={() => {
          void handleRefreshEnabledEpgSources();
        }}
        onAddM3uProfile={handleAddM3uProfile}
        onAddXtreamProfile={handleAddXtreamProfile}
        onImportFile={(file) => {
          void handleImportFile(file);
        }}
        onToggleSourceCollapsed={handleToggleSourceCollapsed}
        onToggleSourceEnabled={handleToggleSourceEnabled}
        onLoadSource={(sourceId) => {
          void handleLoadSavedSource(sourceId);
        }}
        onUpdateSource={handleUpdateSource}
      />

      <ChannelEpgMatchDialog
        isOpen={matcherChannel !== null}
        channel={matcherChannel}
        epgChannels={enabledEpgChannels}
        currentGuide={matcherChannel ? getGuideByChannelId(matcherChannel.id) ?? null : null}
        onClose={() => setMatcherChannel(null)}
        onApplyMatch={handleApplyManualEpgMatch}
        onClearMatch={handleClearManualEpgMatch}
      />
    </main>
  );
}

export default App;
