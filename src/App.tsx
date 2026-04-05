import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChannelEpgMatchDialog } from "./components/ChannelEpgMatchDialog";
import { ChannelShelf } from "./components/ChannelShelf";
import { ChannelSidebar } from "./components/ChannelSidebar";
import { PlayerPanel } from "./components/PlayerPanel";
import { SettingsDrawer, type SettingsTab } from "./components/SettingsDrawer";
import {
  DEFAULT_EPG_SETTINGS,
  type EpgDirectoryChannel,
  type EpgDirectoryResponse,
  type EpgProgrammeSnapshot,
  type EpgResolvedGuide,
  type EpgSettings,
  type SavedEpgMappingStore,
} from "./domain/epg";
import type { Channel, LibraryView, PlaylistImport } from "./domain/iptv";
import type { PlaylistSnapshot, SavedPlaylistSource } from "./domain/sourceProfiles";
import {
  getEpgProgrammeSnapshots,
  loadEpgCacheDirectory,
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
import "./App.css";

const FAVORITES_STORAGE_KEY = "iptv-player:favorites";
const RECENTS_STORAGE_KEY = "iptv-player:recents";
const GROUP_VISIBILITY_STORAGE_KEY = "iptv-player:hidden-groups";
const COLLAPSED_GROUPS_STORAGE_KEY = "iptv-player:collapsed-groups";
const SAVED_SOURCES_STORAGE_KEY = "iptv-player:saved-sources";
const ACTIVE_SOURCE_STORAGE_KEY = "iptv-player:active-source";
const PLAYLIST_SNAPSHOT_STORAGE_KEY = "iptv-player:playlist-snapshot";
const COLLAPSED_SOURCE_CARDS_STORAGE_KEY = "iptv-player:collapsed-source-cards";
const EPG_SETTINGS_STORAGE_KEY = "iptv-player:epg-settings";
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

function pushRecentId(recentIds: string[], channelId: string) {
  return [channelId, ...recentIds.filter((id) => id !== channelId)].slice(0, RECENT_CHANNEL_LIMIT);
}

function hashString(source: string) {
  let hash = 0;

  for (const character of source) {
    hash = (hash << 5) - hash + character.charCodeAt(0);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
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
  const [savedSources, setSavedSources] = usePersistentState<SavedPlaylistSource[]>(
    SAVED_SOURCES_STORAGE_KEY,
    [],
  );
  const [activeSourceId, setActiveSourceId] = usePersistentState<string | null>(
    ACTIVE_SOURCE_STORAGE_KEY,
    null,
  );
  const [epgSettings, setEpgSettings] = usePersistentState<EpgSettings>(
    EPG_SETTINGS_STORAGE_KEY,
    DEFAULT_EPG_SETTINGS,
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
  const [epgDirectory, setEpgDirectory] = useState<EpgDirectoryResponse | null>(null);
  const [epgSnapshotsByChannelId, setEpgSnapshotsByChannelId] = useState<
    Record<string, EpgProgrammeSnapshot>
  >({});
  const [isEpgUpdating, setIsEpgUpdating] = useState(false);
  const [epgStatusMessage, setEpgStatusMessage] = useState<string | null>(null);
  const [matcherChannel, setMatcherChannel] = useState<Channel | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const playerShellRef = useRef<HTMLDivElement>(null);
  const playerSurfaceRef = useRef<HTMLDivElement>(null);
  const startupRestoreAttemptedRef = useRef(false);
  const startupPlaybackRestoreKeyRef = useRef<string | null>(null);
  const startupEpgRefreshAttemptedRef = useRef(false);
  const epgRefreshPromiseRef = useRef<Promise<EpgDirectoryResponse | null> | null>(null);
  const { player, playChannel, reloadPlayback, setVolumeLevel, stopPlayback, toggleMute } =
    useMpvPlayer(playerSurfaceRef, isFullscreen ? "fullscreen" : "windowed", savedVolume);

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
    setSavedSources((currentSources) =>
      currentSources.map((currentSource) =>
        currentSource.id === source.id ? markSourceLoaded(currentSource) : currentSource,
      ),
    );
  }

  const startupSourceToRestore =
    savedSources.find((source) => source.id === activeSourceId && isSourceProfileReady(source)) ?? null;
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
    const source = savedSources.find((currentSource) => currentSource.id === sourceId);

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
    setSavedSources((currentSources) => [...currentSources, createM3uUrlSource()]);
  }

  function handleAddXtreamProfile() {
    setSavedSources((currentSources) => [...currentSources, createXtreamSource()]);
  }

  function handleToggleSourceEnabled(sourceId: string) {
    setSavedSources((currentSources) =>
      currentSources.map((source) =>
        source.id === sourceId
          ? updateSourceProfile(source, {
              enabled: !source.enabled,
            })
          : source,
      ),
    );
  }

  function handleUpdateSource(sourceId: string, patch: Partial<SavedPlaylistSource>) {
    setSavedSources((currentSources) =>
      currentSources.map((source) =>
        source.id === sourceId ? updateSourceProfile(source, patch) : source,
      ),
    );
  }

  function openSettings(tab: SettingsTab) {
    setSettingsTab(tab);
    setIsSettingsOpen(true);
  }

  function handleUpdateEpgSettings(patch: Partial<EpgSettings>) {
    setEpgSettings((currentSettings) => ({
      ...currentSettings,
      ...patch,
    }));

    if (patch.url !== undefined && patch.url.trim().length === 0) {
      setEpgStatusMessage(null);
      setEpgDirectory(null);
      setEpgSnapshotsByChannelId({});
    }
  }

  async function refreshEpgGuide(reason: "manual" | "startup" | "auto") {
    const rawGuideUrl = epgSettings.url.trim();

    if (rawGuideUrl.length === 0) {
      const statusCopy = "Enter an EPG URL first.";
      setEpgStatusMessage(statusCopy);

      if (reason === "manual") {
        setMessage(statusCopy);
      }

      return null;
    }

    if (epgRefreshPromiseRef.current) {
      return epgRefreshPromiseRef.current;
    }

    setIsEpgUpdating(true);

    const refreshPromise = refreshEpgCache(rawGuideUrl)
      .then((directory) => {
        setEpgDirectory(directory);
        setEpgStatusMessage(`Guide updated ${new Date(directory.fetchedAt).toLocaleString()}.`);
        return directory;
      })
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : "The guide could not be updated.";
        setEpgStatusMessage(errorMessage);

        if (reason === "manual") {
          setMessage(errorMessage);
        }

        return null;
      })
      .finally(() => {
        epgRefreshPromiseRef.current = null;
        setIsEpgUpdating(false);
      });

    epgRefreshPromiseRef.current = refreshPromise;
    return refreshPromise;
  }

  const channels = playlist?.channels ?? [];
  const allGroups = playlist?.groups ?? [];
  const activeSource = savedSources.find((source) => source.id === activeSourceId) ?? null;
  const epgUrlKey = normalizeEpgUrlKey(epgSettings.url);
  const playlistEpgScope = getEpgPlaylistScope(activeSourceId, playlist);
  const activeEpgMappingScope =
    playlistEpgScope && epgUrlKey ? createEpgMappingScope(playlistEpgScope, epgSettings.url) : null;
  const savedMappingsForActiveGuide =
    activeEpgMappingScope !== null ? savedEpgMappings[activeEpgMappingScope] ?? {} : undefined;
  const epgChannelIndex = useMemo(
    () => createEpgChannelIndex(epgDirectory?.channels ?? []),
    [epgDirectory?.channels],
  );
  const playlistDisplayName =
    playlist !== null
      ? activeSource?.name.trim().length
        ? activeSource.name.trim()
        : playlist.name
      : null;
  const selectedChannel =
    channels.find((channel) => channel.id === selectedChannelId) ?? channels[0] ?? null;
  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const playlistPreferenceKey = getPlaylistPreferenceKey(playlist);
  const hiddenGroups = playlistPreferenceKey ? hiddenGroupsByLibrary[playlistPreferenceKey] ?? [] : [];
  const hiddenGroupSet = useMemo(() => new Set(hiddenGroups), [hiddenGroups]);
  const favoriteIdSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
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
      const resolvedMatch = resolveEpgChannelMatch(channel, savedMappingsForActiveGuide, epgChannelIndex);

      if (resolvedMatch) {
        nextMatches[channel.id] = resolvedMatch;
      }
    }

    return nextMatches;
  }, [channels, epgChannelIndex, savedMappingsForActiveGuide]);
  const recentChannels = useMemo(
    () =>
      recentIds
        .map((recentId) => channels.find((channel) => channel.id === recentId) ?? null)
        .filter((channel): channel is Channel => channel !== null),
    [channels, recentIds],
  );
  const channelCountByGroup = useMemo(() => {
    const counts: Record<string, number> = {};

    for (const channel of channels) {
      counts[channel.group] = (counts[channel.group] ?? 0) + 1;
    }

    return counts;
  }, [channels]);
  const guidesByChannelId = useMemo(() => {
    const nextGuides: Record<string, EpgResolvedGuide> = {};

    for (const channel of channels) {
      const resolvedMatch = resolvedEpgMatchesByChannelId[channel.id];

      if (!resolvedMatch) {
        continue;
      }

      const guideSnapshot = epgSnapshotsByChannelId[resolvedMatch.epgChannel.id];

      nextGuides[channel.id] = {
        ...resolvedMatch,
        current: guideSnapshot?.current ?? null,
        next: guideSnapshot?.next ?? null,
      };
    }

    return nextGuides;
  }, [channels, epgSnapshotsByChannelId, resolvedEpgMatchesByChannelId]);
  const matchedEpgChannelCount = useMemo(
    () => Object.keys(resolvedEpgMatchesByChannelId).length,
    [resolvedEpgMatchesByChannelId],
  );

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

  let visibleChannels =
    activeView === "recents"
      ? recentChannels
      : activeGroup === FAVORITES_GROUP_ID
      ? favoriteChannels
      : activeGroup && enabledGroupSet.has(activeGroup)
      ? channels.filter((channel) => channel.group === activeGroup)
      : [];

  if (activeView === "favorites" && activeGroup !== FAVORITES_GROUP_ID) {
    visibleChannels = visibleChannels.filter((channel) => favoriteIdSet.has(channel.id));
  }

  if (normalizedSearchQuery.length > 0) {
    visibleChannels = visibleChannels.filter((channel) =>
      channel.name.toLowerCase().includes(normalizedSearchQuery),
    );
  }

  const selectedGuide = selectedChannel ? guidesByChannelId[selectedChannel.id] ?? null : null;
  const visibleEpgChannelIds = [
    ...new Set(
      [
        ...visibleChannels.map((channel) => guidesByChannelId[channel.id]?.epgChannel.id ?? null),
        selectedChannel ? guidesByChannelId[selectedChannel.id]?.epgChannel.id ?? null : null,
      ].filter((channelId): channelId is string => channelId !== null),
    ),
  ];
  const visibleEpgChannelIdsKey = visibleEpgChannelIds.join("\u0001");
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
    if (!epgDirectory) {
      setMessage("Load an EPG guide first, then you can match channels from the right-click menu.");
      openSettings("epg");
      return;
    }

    setMatcherChannel(channel);
  }

  function handleApplyManualEpgMatch(channel: Channel, epgChannel: EpgDirectoryChannel) {
    if (!activeEpgMappingScope) {
      setMessage("Load a source and configure an EPG guide before saving manual matches.");
      return;
    }

    setSavedEpgMappings((currentMappings) => {
      const scopedMappings = {
        ...(currentMappings[activeEpgMappingScope] ?? {}),
      };

      for (const mappingKey of getChannelManualMappingKeys(channel)) {
        scopedMappings[mappingKey] = epgChannel.id;
      }

      return {
        ...currentMappings,
        [activeEpgMappingScope]: scopedMappings,
      };
    });

    setMatcherChannel(null);
    setEpgStatusMessage(`Matched ${channel.name} to ${epgChannel.displayNames[0] ?? epgChannel.id}.`);
  }

  function handleClearManualEpgMatch(channel: Channel) {
    if (!activeEpgMappingScope) {
      return;
    }

    setSavedEpgMappings((currentMappings) => {
      const scopedMappings = {
        ...(currentMappings[activeEpgMappingScope] ?? {}),
      };

      for (const mappingKey of getChannelManualMappingKeys(channel)) {
        delete scopedMappings[mappingKey];
      }

      if (Object.keys(scopedMappings).length === 0) {
        const nextMappings = { ...currentMappings };
        delete nextMappings[activeEpgMappingScope];
        return nextMappings;
      }

      return {
        ...currentMappings,
        [activeEpgMappingScope]: scopedMappings,
      };
    });

    setEpgStatusMessage(`Cleared the manual guide match for ${channel.name}.`);
  }

  useEffect(() => {
    let cancelled = false;

    if (!epgUrlKey) {
      setEpgDirectory(null);
      setEpgSnapshotsByChannelId({});
      return () => {
        cancelled = true;
      };
    }

    void loadEpgCacheDirectory()
      .then((cachedDirectory) => {
        if (cancelled) {
          return;
        }

        if (cachedDirectory && normalizeEpgUrlKey(cachedDirectory.sourceUrl) === epgUrlKey) {
          setEpgDirectory(cachedDirectory);
          setEpgStatusMessage(
            `Cached guide loaded from ${new Date(cachedDirectory.fetchedAt).toLocaleString()}.`,
          );
          return;
        }

        setEpgDirectory(null);
        setEpgSnapshotsByChannelId({});
        setEpgStatusMessage(null);
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
  }, [epgUrlKey]);

  useEffect(() => {
    if (startupEpgRefreshAttemptedRef.current) {
      return;
    }

    startupEpgRefreshAttemptedRef.current = true;

    if (!epgUrlKey || !epgSettings.updateOnStartup) {
      return;
    }

    void refreshEpgGuide("startup");
  }, [epgSettings.updateOnStartup, epgUrlKey]);

  useEffect(() => {
    if (!epgUrlKey || !epgSettings.autoUpdateEnabled) {
      return undefined;
    }

    const intervalMs = Math.max(1, epgSettings.updateIntervalHours) * 60 * 60 * 1000;
    const timerId = window.setInterval(() => {
      void refreshEpgGuide("auto");
    }, intervalMs);

    return () => {
      window.clearInterval(timerId);
    };
  }, [epgSettings.autoUpdateEnabled, epgSettings.updateIntervalHours, epgUrlKey]);

  useEffect(() => {
    let cancelled = false;

    if (!epgDirectory || visibleEpgChannelIds.length === 0) {
      setEpgSnapshotsByChannelId({});
      return () => {
        cancelled = true;
      };
    }

    void getEpgProgrammeSnapshots(visibleEpgChannelIds)
      .then((snapshots) => {
        if (cancelled) {
          return;
        }

        const nextSnapshots: Record<string, EpgProgrammeSnapshot> = {};

        for (const snapshot of snapshots) {
          nextSnapshots[snapshot.epgChannelId] = snapshot;
        }

        setEpgSnapshotsByChannelId(nextSnapshots);
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
  }, [epgDirectory, visibleEpgChannelIdsKey]);

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
      playlist.channels.find((channel) => channel.id === playbackSession.channelId) ?? null;

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
              favoriteIds={favoriteIds}
              recentIds={recentIds}
              guidesByChannelId={guidesByChannelId}
              canMatchEpg={epgDirectory !== null}
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
        epgSettings={epgSettings}
        epgDirectory={epgDirectory}
        matchedEpgChannelCount={matchedEpgChannelCount}
        isEpgUpdating={isEpgUpdating}
        epgStatusMessage={epgStatusMessage}
        savedSources={savedSources}
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
        onUpdateEpgSettings={handleUpdateEpgSettings}
        onRefreshEpg={() => {
          void refreshEpgGuide("manual");
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
        epgChannels={epgDirectory?.channels ?? []}
        currentGuide={matcherChannel ? guidesByChannelId[matcherChannel.id] ?? null : null}
        onClose={() => setMatcherChannel(null)}
        onApplyMatch={handleApplyManualEpgMatch}
        onClearMatch={handleClearManualEpgMatch}
      />
    </main>
  );
}

export default App;
