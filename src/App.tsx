import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChannelEpgMatchDialog } from "./components/ChannelEpgMatchDialog";
import { ChannelShelf } from "./components/ChannelShelf";
import { ChannelSidebar, type NavigationSection } from "./components/ChannelSidebar";
import { PlayerPanel } from "./components/PlayerPanel";
import { SettingsDrawer, type SettingsTab } from "./components/SettingsDrawer";
import {
  createEpgSource,
  getEpgSourceLabel,
  getProgrammeSnapshot,
  isEpgSourceReady,
  normalizeEpgSources,
  updateEpgSource,
  type EpgDirectoryChannel,
  type EpgDirectoryResponse,
  type EpgProgrammeSummary,
  type EpgResolvedGuide,
  type EpgSource,
  type SavedEpgMappingStore,
} from "./domain/epg";
import type { Channel, PlaylistImport } from "./domain/iptv";
import type {
  PlaylistSnapshot,
  SavedPlaylistSource,
  SourceLibraryIndex,
} from "./domain/sourceProfiles";
import {
  deleteEpgCache,
  getEpgCacheDiagnostics,
  getEpgProgrammeWindows,
  loadEpgCacheDirectories,
  refreshEpgCache,
} from "./features/epg/api";
import {
  formatEpgDirectoryDiagnostics,
  formatEpgFailureStatus,
  formatEpgStoreDiagnostics,
  sanitizeEpgSourceLabel,
} from "./features/epg/diagnostics";
import {
  createEpgChannelIndex,
  createEpgMappingScope,
  getChannelManualMappingKeys,
  migrateSavedEpgMappings,
  normalizeEpgUrlKey,
  reconstructEpgCacheDirectories,
  resolveEpgChannelMatch,
  serializeEpgMappings,
} from "./features/epg/matching";
import {
  beginEpgSourceOperation,
  createEpgOperationCoordinator,
  finishEpgSourceOperation,
  getEpgSourceCommitState,

  type EpgOperationToken,
  type EpgSourceBusyState,
} from "./features/epg/operations";
import {
  deleteEpgUrlBeforeCommit,
  EPG_SOURCES_STORAGE_KEY,
  getEpgSecretHydrationFingerprint,
  hydrateEpgSecrets,
  loadEpgUrl,
  requireEpgMappingMigrationReady,
  saveEpgUrlBeforeCommit,
  saveEpgUrlsBeforePersist,
  serializeEpgSources,
} from "./features/epg/secrets";
import { DEFAULT_PLAYER_VOLUME, useMpvPlayer } from "./features/player/mpv";
import { parseM3u } from "./features/playlist/m3u";
import { createLocalM3uSourceIdentity } from "./features/playlist/channelFactory";
import { downloadPlaylistFromUrl } from "./features/playlist/remote";
import { importXtreamPlaylist } from "./features/playlist/xtream";
import { materializeChannelForPlayback } from "./features/playlist/materialize";
import { redactCredentials } from "./features/playlist/redaction";
import {
  isPlaylistSnapshotPlaybackReady,
  sanitizePlaylistSnapshot,
  shouldRefreshPlaylistSnapshot,
} from "./features/playlist/snapshot";
import {
  createSourceRevisionTracker,
  createStartupSourceRestoreState,
  getSourceOperationCommitState,
  migrateImportedChannelReferences,
  migrateStartupPlaybackSession,
} from "./features/sources/appIntegration";
import {
  getSourceSecretHydrationFingerprint,
  hydrateSourceSecrets,
  type SourceSecretHydrationSettlement,
} from "./features/sources/hydration";
import {
  beginSourceBusy,
  createSourceOperationCoordinator,
  finishSourceBusy,
  type SourceBusyState,
  type SourceOperationToken,
} from "./features/sources/operations";
import {
  createM3uUrlSource,
  createXtreamSource,
  isSourceProfileReady,
  mergeSourceLibraryIndexEntry,
  markSourceLoaded,
  scrubSourceProfileSecrets,
  updateSourceProfile,
} from "./features/sources/profiles";
import {
  deleteSourceSecretBeforeCommit,
  loadM3uUrl,
  loadXtreamPassword,
  SAVED_SOURCES_PERSISTENCE_KEY,
  saveSourceSecretsBeforePersist,
} from "./features/sources/secrets";
import { usePersistentState } from "./hooks/usePersistentState";
import { hashString } from "./utils/hash";
import "./App.css";

const FAVORITES_STORAGE_KEY = "iptv-player:favorites";
const RECENTS_STORAGE_KEY = "iptv-player:recents";
const GROUP_VISIBILITY_STORAGE_KEY = "iptv-player:hidden-groups";
const COLLAPSED_GROUPS_STORAGE_KEY = "iptv-player:collapsed-groups";
const SAVED_SOURCES_STORAGE_KEY = SAVED_SOURCES_PERSISTENCE_KEY;
const SOURCE_LIBRARY_INDEX_STORAGE_KEY = "iptv-player:source-library-index";
const ACTIVE_SOURCE_STORAGE_KEY = "iptv-player:active-source";
const PLAYLIST_SNAPSHOT_STORAGE_KEY = "iptv-player:playlist-snapshot";
const COLLAPSED_SOURCE_CARDS_STORAGE_KEY = "iptv-player:collapsed-source-cards";

const EPG_MANUAL_MATCHES_STORAGE_KEY = "iptv-player:epg-manual-matches";
const PLAYER_RESUME_STORAGE_KEY = "iptv-player:playback-session";
const PLAYER_VOLUME_STORAGE_KEY = "iptv-player:player-volume";
const RECENT_CHANNEL_LIMIT = 12;
const ALL_CHANNELS_GROUP_ID = "__iptv_player_all__";
const FAVORITES_GROUP_ID = "__iptv_player_favorites__";
const CHANNEL_RENDER_INITIAL_LIMIT = 320;
const CHANNEL_RENDER_BATCH_SIZE = 320;
const GUIDE_SLOT_MINUTES = 30;
const GUIDE_VISIBLE_SLOT_COUNT = 4;
const GUIDE_CLOCK_REFRESH_MS = 30 * 1000;
type SidebarMode = "hidden" | "groups" | "menu";

interface PlaybackSession {
  sourceId: string | null;
  channelId: string | null;
  shouldResume: boolean;
  resumeSourceId: string | null;
  resumeChannelId: string | null;
  resumeInFullscreen: boolean;
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
  const uniqueSources: EpgSource[] = [];

  for (const source of sources) {
    if (enabledOnly && !source.enabled) {
      continue;
    }

    if (!isEpgSourceReady(source)) {
      continue;
    }

    uniqueSources.push(source);
  }

  return uniqueSources;
}

function removeMappingsForGuideSource(
  currentMappings: SavedEpgMappingStore,
  sourceId: string,
) {
  const scopePrefix = `${sourceId}\u0001`;
  const nextMappings = { ...currentMappings };

  for (const mappingScope of Object.keys(nextMappings)) {
    if (mappingScope.startsWith(scopePrefix)) {
      delete nextMappings[mappingScope];
    }
  }

  return nextMappings;
}

function removeMappingsForSourceScope(
  currentMappings: SavedEpgMappingStore,
  sourceScopeId: string,
) {
  const nextMappings = { ...currentMappings };

  for (const mappingScope of Object.keys(nextMappings)) {
    if (mappingScope.endsWith(`\u0001${sourceScopeId}`)) {
      delete nextMappings[mappingScope];
    }
  }

  return nextMappings;
}

function App() {
  const epgSourcesPersistenceRef = useRef<EpgSource[]>([]);
  const epgMappingMigrationReadyRef = useRef(false);
  const [favoriteIds, setFavoriteIds, favoriteIdsHydrated, favoriteIdsMetadata] = usePersistentState<string[]>(
    FAVORITES_STORAGE_KEY,
    [],
  );
  const [recentIds, setRecentIds, recentIdsHydrated, recentIdsMetadata] = usePersistentState<string[]>(
    RECENTS_STORAGE_KEY,
    [],
  );
  const [hiddenGroupsByLibrary, setHiddenGroupsByLibrary, hiddenGroupsHydrated] =
    usePersistentState<Record<string, string[]>>(GROUP_VISIBILITY_STORAGE_KEY, {});
  const [collapsedGroupsByLibrary, setCollapsedGroupsByLibrary, collapsedGroupsHydrated] = usePersistentState<
    Record<string, boolean>
  >(COLLAPSED_GROUPS_STORAGE_KEY, {});
  const [collapsedSourceIds, setCollapsedSourceIds, collapsedSourceIdsHydrated] =
    usePersistentState<string[]>(COLLAPSED_SOURCE_CARDS_STORAGE_KEY, []);
  const [savedSources, setSavedSources, savedSourcesHydrated, savedSourcesMetadata, savedSourcesPersistenceFailed] =
    usePersistentState<Record<string, SavedPlaylistSource>>(
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
    },
    scrubSourceProfileSecrets,
    saveSourceSecretsBeforePersist,
  );
  const [sourceLibraryIndex, setSourceLibraryIndex, sourceLibraryIndexHydrated, sourceLibraryIndexMetadata] =
    usePersistentState<SourceLibraryIndex>(SOURCE_LIBRARY_INDEX_STORAGE_KEY, {});
  const [activeSourceId, setActiveSourceId, activeSourceIdHydrated] = usePersistentState<string | null>(
    ACTIVE_SOURCE_STORAGE_KEY,
    null,
  );
  const [epgSources, setEpgSources, epgSourcesHydrated, , epgSourcesPersistenceFailed] = usePersistentState<EpgSource[]>(
    EPG_SOURCES_STORAGE_KEY,
    [],
    normalizeEpgSources,
    serializeEpgSources,
    saveEpgUrlsBeforePersist,
  );
  epgSourcesPersistenceRef.current = normalizeEpgSources(epgSources);
  const [savedEpgMappings, setSavedEpgMappings, savedEpgMappingsHydrated, savedEpgMappingsMetadata] =
    usePersistentState<SavedEpgMappingStore>(
      EPG_MANUAL_MATCHES_STORAGE_KEY,
      {},
      undefined,
      (mappings) => serializeEpgMappings(
        mappings,
        new Set(epgSourcesPersistenceRef.current.map((source) => source.id)),
      ),
      () => requireEpgMappingMigrationReady(epgMappingMigrationReadyRef.current),
    );
  const [playbackSession, setPlaybackSession, playbackSessionHydrated, playbackSessionMetadata] =
    usePersistentState<PlaybackSession>(PLAYER_RESUME_STORAGE_KEY, {
      sourceId: null,
      channelId: null,
      shouldResume: false,
      resumeSourceId: null,
      resumeChannelId: null,
      resumeInFullscreen: false,
    });
  const [savedVolume, setSavedVolume, savedVolumeHydrated] = usePersistentState<number>(
    PLAYER_VOLUME_STORAGE_KEY,
    DEFAULT_PLAYER_VOLUME,
  );
  const [playlistSnapshot, setPlaylistSnapshot, playlistSnapshotHydrated, playlistSnapshotMetadata] =
    usePersistentState<PlaylistSnapshot | null>(
      PLAYLIST_SNAPSHOT_STORAGE_KEY,
      null,
      undefined,
      (snapshot) => snapshot ? sanitizePlaylistSnapshot(snapshot) : null,
    );
  const [playlist, setPlaylist] = useState<PlaylistImport | null>(() => playlistSnapshot?.playlist ?? null);
  const [navigationSection, setNavigationSection] = useState<NavigationSection>("tv");
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() =>
    playlistSnapshot?.playlist.channels.length ? "groups" : "menu",
  );
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    () => playlistSnapshot?.selectedChannelId ?? playlistSnapshot?.playlist.channels[0]?.id ?? null,
  );
  const [sourceBusy, setSourceBusy] = useState<SourceBusyState | null>(null);
  const [channelRenderLimit, setChannelRenderLimit] = useState(CHANNEL_RENDER_INITIAL_LIMIT);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [startupRestoreToken, setStartupRestoreToken] = useState<SourceOperationToken | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("library");
  const [message, setMessage] = useState<string | null>(null);
  const [epgDirectoriesBySourceId, setEpgDirectoriesBySourceId] = useState<
    Record<string, EpgDirectoryResponse>
  >({});
  const [guideProgrammesByChannelKey, setGuideProgrammesByChannelKey] = useState<
    Record<string, EpgProgrammeSummary[]>
  >({});
  const [epgBusyBySourceId, setEpgBusyBySourceId] = useState<Record<string, EpgSourceBusyState>>({});
  const [hasLoadedEpgCacheDirectories, setHasLoadedEpgCacheDirectories] = useState(false);
  const [savedSourceSecretsHydrated, setSavedSourceSecretsHydrated] = useState(false);
  const [epgSecretsHydrated, setEpgSecretsHydrated] = useState(false);
  const [epgStatusMessage, setEpgStatusMessage] = useState<string | null>(null);
  const [matcherChannel, setMatcherChannel] = useState<Channel | null>(null);
  const [guideNowMs, setGuideNowMs] = useState(() => Date.now());
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const playerShellRef = useRef<HTMLDivElement>(null);
  const playerSurfaceRef = useRef<HTMLDivElement>(null);
  const startupRestoreStateRef = useRef(createStartupSourceRestoreState());
  const startupPlaybackRestoreKeyRef = useRef<string | null>(null);
  const startupPlaybackRestoreCompletedRef = useRef(false);
  const startupPlaybackSessionRef = useRef<PlaybackSession | null>(null);
  const fullscreenEscapeHandledRef = useRef(false);
  const selectedChannelIdRef = useRef<string | null>(selectedChannelId);
  const hydratedPlaylistSnapshotAppliedRef = useRef(false);
  const hydratedVolumeAppliedRef = useRef(false);
  const savedSourcesRef = useRef(savedSources);
  const activeSourceIdRef = useRef(activeSourceId);
  const sourceOperationsRef = useRef(createSourceOperationCoordinator());
  const sourceRevisionsRef = useRef(createSourceRevisionTracker());
  const persistenceNoticeShownRef = useRef(false);
  const startupSourceRefreshResultRef = useRef<"pending" | "succeeded" | "failed">("pending");
  const importedReferencesRef = useRef({
    favoriteIds,
    recentIds,
    selectedChannelId,
    playbackSession,
    sourceLibraryIndex,
    playlistSnapshot,
    savedEpgMappings,
  });
  const startupEpgRefreshAttemptedRef = useRef<Set<string>>(new Set());
  const epgSecretHydrationStartedRef = useRef(false);
  const epgSourcesRef = useRef(epgSources);
  const epgOperationsRef = useRef(createEpgOperationCoordinator());
  const epgDirectoryLoadRevisionRef = useRef(0);
  const hasHydratedPersistentState =
    favoriteIdsHydrated &&
    recentIdsHydrated &&
    hiddenGroupsHydrated &&
    collapsedGroupsHydrated &&
    collapsedSourceIdsHydrated &&
    savedSourcesHydrated &&
    sourceLibraryIndexHydrated &&
    activeSourceIdHydrated &&
    savedSourceSecretsHydrated &&
    epgSourcesHydrated &&
    epgSecretsHydrated &&
    savedEpgMappingsHydrated &&
    playbackSessionHydrated &&
    savedVolumeHydrated &&
    playlistSnapshotHydrated;
  savedSourcesRef.current = savedSources;
  activeSourceIdRef.current = activeSourceId;
  epgSourcesRef.current = normalizeEpgSources(epgSources);
  importedReferencesRef.current = {
    favoriteIds,
    recentIds,
    selectedChannelId,
    playbackSession,
    sourceLibraryIndex,
    playlistSnapshot,
    savedEpgMappings,
  };
  const loadingSourceId = sourceBusy?.origin === "local" ? null : sourceBusy?.sourceId ?? null;
  const isImportingFile = sourceBusy?.origin === "local";
  const isRestoringStartupSource = startupRestoreToken !== null;
  const { player, playChannel, setVolumeLevel, stopPlayback, toggleMute } =
    useMpvPlayer(playerSurfaceRef, isFullscreen ? "fullscreen" : "windowed", savedVolume);

  useEffect(() => {
    selectedChannelIdRef.current = selectedChannelId;
  }, [selectedChannelId]);

  useEffect(() => {
    if (!playbackSessionHydrated || startupPlaybackSessionRef.current !== null) {
      return;
    }

    startupPlaybackSessionRef.current = playbackSession;
  }, [playbackSession, playbackSessionHydrated]);

  useEffect(() => {
    if (!hasHydratedPersistentState || persistenceNoticeShownRef.current || message !== null) {
      return;
    }

    const degradedMetadata = [
      favoriteIdsMetadata,
      recentIdsMetadata,
      savedSourcesMetadata,
      sourceLibraryIndexMetadata,
      savedEpgMappingsMetadata,
      playbackSessionMetadata,
      playlistSnapshotMetadata,
    ].filter((metadata) => metadata.degraded);
    if (degradedMetadata.length === 0) {
      persistenceNoticeShownRef.current = true;
      return;
    }

    persistenceNoticeShownRef.current = true;
    setMessage(
      degradedMetadata.some((metadata) => metadata.recovered)
        ? "Saved app data was recovered with reduced fidelity. Review sources before playback."
        : "Some saved app data was isolated or upgraded for safety. Review settings if anything is missing.",
    );
  }, [
    favoriteIdsMetadata,
    hasHydratedPersistentState,
    message,
    playbackSessionMetadata,
    playlistSnapshotMetadata,
    recentIdsMetadata,
    savedEpgMappingsMetadata,
    savedSourcesMetadata,
    sourceLibraryIndexMetadata,
  ]);

  useEffect(() => {
    if (savedSourcesPersistenceFailed) {
      setMessage((currentMessage) =>
        currentMessage ?? "Saved source changes could not be secured. Existing saved data was kept.",
      );
    }
  }, [savedSourcesPersistenceFailed]);

  useEffect(() => {
    if (epgSourcesPersistenceFailed) {
      setMessage((currentMessage) =>
        currentMessage ?? "EPG URL changes could not be secured. Existing saved data was kept.",
      );
    }
  }, [epgSourcesPersistenceFailed]);

  const secretSourceIdsKey = useMemo(
    () => Object.values(savedSources)
      .map((source) => `${source.kind}:${source.id}`)
      .sort((left, right) => left.localeCompare(right))
      .join("\u0001"),
    [savedSources],
  );

  useEffect(() => {
    if (!savedSourcesHydrated) return;

    let cancelled = false;
    setSavedSourceSecretsHydrated(false);
    const pendingReads = Object.values(savedSources).map((source) => ({
      sourceId: source.id,
      kind: source.kind,
      expectedFingerprint: getSourceSecretHydrationFingerprint(source),
      read: source.kind === "m3u_url" ? loadM3uUrl(source.id) : loadXtreamPassword(source.id),
    }));

    void Promise.allSettled(pendingReads.map((pending) => pending.read))
      .then((results) => {
        if (cancelled) return;
        const settlements: SourceSecretHydrationSettlement[] = pendingReads.map(
          (pending, index) => ({
            sourceId: pending.sourceId,
            kind: pending.kind,
            expectedFingerprint: pending.expectedFingerprint,
            result: results[index],
          }),
        );
        const hydration = hydrateSourceSecrets(savedSourcesRef.current, settlements);
        setSavedSources((currentSources) => hydrateSourceSecrets(currentSources, settlements).sources);
        if (hydration.message) setMessage((currentMessage) => currentMessage ?? hydration.message);
      })
      .finally(() => {
        if (!cancelled) setSavedSourceSecretsHydrated(true);
      });

    return () => { cancelled = true; };
  }, [savedSourcesHydrated, setSavedSources, secretSourceIdsKey]);

  useEffect(() => {
    if (!epgSourcesHydrated || epgSecretHydrationStartedRef.current) return;
    epgSecretHydrationStartedRef.current = true;
    let cancelled = false;
    setEpgSecretsHydrated(false);
    const pendingReads = normalizeEpgSources(epgSources).map((source) => ({
      sourceId: source.id,
      expectedFingerprint: getEpgSecretHydrationFingerprint(source),
      read: loadEpgUrl(source.id),
    }));
    void Promise.allSettled(pendingReads.map((pending) => pending.read))
      .then((results) => {
        if (cancelled) return;
        const settlements = pendingReads.map((pending, index) => ({
          sourceId: pending.sourceId,
          expectedFingerprint: pending.expectedFingerprint,
          result: results[index],
        }));
        setEpgSources((currentSources) => {
          const hydrated = hydrateEpgSecrets(normalizeEpgSources(currentSources), settlements);
          epgMappingMigrationReadyRef.current = true;
          setSavedEpgMappings((currentMappings) =>
            migrateSavedEpgMappings(currentMappings, hydrated.sources),
          );
          if (hydrated.message) setMessage((currentMessage) => currentMessage ?? hydrated.message);
          return hydrated.sources;
        });
      })
      .finally(() => {
        if (!cancelled) setEpgSecretsHydrated(true);
      });
    return () => { cancelled = true; };
  }, [epgSources, epgSourcesHydrated, setEpgSources, setSavedEpgMappings]);


  useEffect(() => {
    if (!playlistSnapshotHydrated || hydratedPlaylistSnapshotAppliedRef.current) {
      return;
    }

    hydratedPlaylistSnapshotAppliedRef.current = true;

    if (!playlistSnapshot) {
      return;
    }

    const nextSelectedChannelId =
      playlistSnapshot.selectedChannelId &&
      playlistSnapshot.playlist.channels.some(
        (channel) => channel.id === playlistSnapshot.selectedChannelId,
      )
        ? playlistSnapshot.selectedChannelId
        : playlistSnapshot.playlist.channels[0]?.id ?? null;

    startTransition(() => {
      setPlaylist(playlistSnapshot.playlist);
      setSelectedChannelId(nextSelectedChannelId);
    });
  }, [playlistSnapshot, playlistSnapshotHydrated]);

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

      event.preventDefault();
      event.stopPropagation();
      fullscreenEscapeHandledRef.current = true;
      void handleToggleFullscreen();
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  useEffect(() => {
    if (isFullscreen || isSettingsOpen || matcherChannel !== null) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (fullscreenEscapeHandledRef.current) {
        fullscreenEscapeHandledRef.current = false;
        return;
      }

      if (!playlist) {
        setNavigationSection("search");
        setSidebarMode("menu");
        return;
      }

      event.preventDefault();
      if (sidebarMode === "hidden") {
        setNavigationSection("tv");
        setSidebarMode("groups");
        return;
      }

      if (sidebarMode === "groups") {
        setNavigationSection("search");
        setSidebarMode("menu");
        return;
      }

      setNavigationSection("search");
      setSidebarMode("menu");
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen, isSettingsOpen, matcherChannel, playlist, sidebarMode]);

  useEffect(() => {
    const nextVolume = Math.max(0, Math.min(100, Math.round(player.volume)));

    setSavedVolume((currentValue) => (currentValue === nextVolume ? currentValue : nextVolume));
  }, [player.volume, setSavedVolume]);

  useEffect(() => {
    setGuideNowMs(Date.now());

    const timerId = window.setInterval(() => {
      setGuideNowMs(Date.now());
    }, GUIDE_CLOCK_REFRESH_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  useEffect(() => {
    if (
      hydratedVolumeAppliedRef.current ||
      !savedVolumeHydrated ||
      player.environment !== "tauri" ||
      !player.ready
    ) {
      return;
    }

    hydratedVolumeAppliedRef.current = true;
    void setVolumeLevel(savedVolume);
  }, [player.environment, player.ready, savedVolume, savedVolumeHydrated, setVolumeLevel]);

  useEffect(() => {
    if (!playlist) {
      setNavigationSection("search");
      setSidebarMode("menu");
    }
  }, [playlist]);

  function schedulePlayerLayoutSync() {
    const syncDelays = [0, 40, 140, 280, 520];

    syncDelays.forEach((delay) => {
      window.setTimeout(() => {
        window.dispatchEvent(new Event("resize"));
      }, delay);
    });
  }

  useEffect(() => {
    if (isFullscreen) {
      return;
    }

    schedulePlayerLayoutSync();
  }, [isFullscreen, sidebarMode]);

  function canCommitSourceOperation(token: SourceOperationToken) {
    if (token.sourceId === null) {
      return sourceOperationsRef.current.isCurrent(token);
    }
    return sourceOperationsRef.current.canCommit(
      token,
      getSourceOperationCommitState(
        savedSourcesRef.current,
        token.sourceId,
        sourceRevisionsRef.current.current(token.sourceId),
      ),
    );
  }

  async function applyImportedPlaylist(
    importedPlaylist: PlaylistImport,
    token: SourceOperationToken,
    options?: {
      sourceId?: string | null;
      preferredChannelId?: string | null;
      preservePlaybackSession?: boolean;
      keepPlaybackRunning?: boolean;
    },
  ) {
    if (!canCommitSourceOperation(token)) return false;
    if (!options?.keepPlaybackRunning) {
      await stopPlayback();
    }
    if (!canCommitSourceOperation(token)) return false;

    const nextSourceId = options?.sourceId ?? null;
    const currentReferences = importedReferencesRef.current;
    const migrated = migrateImportedChannelReferences(importedPlaylist.channels, {
      ...currentReferences,
      preferredChannelId: options?.preferredChannelId ?? currentReferences.selectedChannelId,
    });
    const nextSelectedChannelId =
      migrated.preferredChannelId &&
      importedPlaylist.channels.some((channel) => channel.id === migrated.preferredChannelId)
        ? migrated.preferredChannelId
        : importedPlaylist.channels[0]?.id ?? null;
    const nextPlaylistPreferenceKey = getPlaylistPreferenceKey(importedPlaylist);
    const nextLibraryIndex = nextSourceId
      ? {
          ...migrated.sourceLibraryIndex,
          [nextSourceId]: mergeSourceLibraryIndexEntry(
            migrated.sourceLibraryIndex[nextSourceId],
            importedPlaylist.channels.map((channel) => channel.id),
            nextPlaylistPreferenceKey,
          ),
        }
      : migrated.sourceLibraryIndex;
    const nextPlaybackSession = options?.preservePlaybackSession
      ? migrated.playbackSession
      : {
          ...migrated.playbackSession,
          sourceId: nextSourceId,
          channelId: nextSelectedChannelId,
          shouldResume: false,
          resumeSourceId: null,
          resumeChannelId: null,
          resumeInFullscreen: false,
        };

    if (!canCommitSourceOperation(token)) return false;
    if (startupPlaybackSessionRef.current !== null) {
      startupPlaybackSessionRef.current = migrateStartupPlaybackSession(
        importedPlaylist.channels,
        startupPlaybackSessionRef.current,
      );
    }
    startTransition(() => {
      setFavoriteIds(migrated.favoriteIds);
      setRecentIds(migrated.recentIds);
      setPlaybackSession(nextPlaybackSession);
      setSourceLibraryIndex(nextLibraryIndex);
      setSavedEpgMappings(migrated.savedEpgMappings);
      setPlaylistSnapshot({
        sourceId: nextSourceId,
        playlist: importedPlaylist,
        selectedChannelId: nextSelectedChannelId,
        savedAt: new Date().toISOString(),
      });
      setActiveSourceId(nextSourceId);
      setPlaylist(importedPlaylist);
      setSelectedChannelId(nextSelectedChannelId);
      setNavigationSection("tv");
      setActiveGroup(ALL_CHANNELS_GROUP_ID);
      setSidebarMode("groups");
      setSearchQuery("");
      setMessage(null);
      setIsSettingsOpen(false);

      if (nextSourceId) {
        setSavedSources((currentSources) => {
          const currentSource = currentSources[nextSourceId];
          return currentSource
            ? { ...currentSources, [nextSourceId]: markSourceLoaded(currentSource) }
            : currentSources;
        });
      }
    });
    return true;
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
    token: SourceOperationToken,
    options?: {
      preservePlaybackSession?: boolean;
      keepPlaybackRunning?: boolean;
    },
  ) {
    let importedPlaylist: PlaylistImport;

    if (source.kind === "m3u_url") {
      const { fileName, playlistText } = await downloadPlaylistFromUrl(source.url);
      importedPlaylist = parseM3u(playlistText, fileName, {
        sourceId: source.id,
        trust: "remote",
      });
    } else {
      importedPlaylist = await importXtreamPlaylist(
        source.domain,
        source.username,
        source.password,
        source.id,
      );
    }

    if (!canCommitSourceOperation(token)) return false;
    const currentSnapshot = importedReferencesRef.current.playlistSnapshot;
    return applyImportedPlaylist(importedPlaylist, token, {
      sourceId: source.id,
      preferredChannelId:
        currentSnapshot?.sourceId === source.id
          ? selectedChannelIdRef.current ?? currentSnapshot.selectedChannelId
          : null,
      preservePlaybackSession: options?.preservePlaybackSession,
      keepPlaybackRunning: options?.keepPlaybackRunning,
    });
  }

  const startupSourceToRestore =
    activeSourceId && savedSources[activeSourceId] && isSourceProfileReady(savedSources[activeSourceId])
      ? savedSources[activeSourceId]
      : null;
  const startupSourceRevision = startupSourceToRestore
    ? sourceRevisionsRef.current.current(startupSourceToRestore.id)
    : null;
  const cachedStartupSnapshot =
    startupSourceToRestore !== null && playlistSnapshot?.sourceId === startupSourceToRestore.id
      ? playlistSnapshot
      : null;
  const hasCachedStartupPlaylist = (cachedStartupSnapshot?.playlist.channels.length ?? 0) > 0;
  const cachedStartupPlaylistNeedsRefresh =
    cachedStartupSnapshot !== null && shouldRefreshPlaylistSnapshot(cachedStartupSnapshot);
  const cachedStartupPlaylistPlaybackReady =
    cachedStartupSnapshot !== null && isPlaylistSnapshotPlaybackReady(cachedStartupSnapshot);
  const shouldDelayResumeForStartupRestore =
    playbackSession.shouldResume &&
    playbackSession.resumeSourceId === activeSourceId &&
    startupSourceToRestore !== null &&
    startupSourceRefreshResultRef.current === "pending";

  useEffect(() => {
    if (!hasHydratedPersistentState) {
      return;
    }

    if (!startupSourceToRestore || !startupSourceRevision) {
      startupSourceRefreshResultRef.current = "failed";
      return;
    }

    const restoreState = startupRestoreStateRef.current;
    if (!restoreState.plan(startupSourceRevision)) {
      return;
    }

    startupSourceRefreshResultRef.current = "pending";
    let timerId: number | null = null;
    let token: SourceOperationToken | null = null;

    const restoreStartupSource = async () => {
      if (!restoreState.begin(startupSourceRevision)) return;

      token = sourceOperationsRef.current.start({
        origin: "startup",
        sourceId: startupSourceToRestore.id,
        expectedFingerprint: startupSourceRevision,
      });
      const operationToken = token;
      setStartupRestoreToken(operationToken);
      setSourceBusy(beginSourceBusy(operationToken));

      try {
        if (!canCommitSourceOperation(operationToken)) return;
        const applied = await importFromSavedSource(startupSourceToRestore, operationToken, {
          preservePlaybackSession: true,
          keepPlaybackRunning: hasCachedStartupPlaylist,
        });
        if (operationToken.isCurrent()) {
          startupSourceRefreshResultRef.current = applied ? "succeeded" : "failed";
        }
      } catch (error) {
        if (operationToken.isCurrent()) {
          startupSourceRefreshResultRef.current = "failed";
          const safeError = redactCredentials(
            error instanceof Error ? error.message : "The saved source could not be refreshed.",
          );
          setMessage(
            hasCachedStartupPlaylist
              ? `Using cached library metadata. ${safeError}`
              : safeError,
          );
        }
      } finally {
        setSourceBusy((currentBusy) => finishSourceBusy(currentBusy, operationToken));
        setStartupRestoreToken((currentToken) =>
          currentToken === operationToken ? null : currentToken,
        );
      }
    };

    if (hasCachedStartupPlaylist) {
      timerId = window.setTimeout(() => {
        timerId = null;
        void restoreStartupSource();
      }, 1500);
    } else {
      void restoreStartupSource();
    }

    return () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
        restoreState.cancelPending(startupSourceRevision);
        startupSourceRefreshResultRef.current = "failed";
      }
    };
  }, [hasHydratedPersistentState, startupSourceRevision, startupSourceToRestore?.id]);

  async function handleImportFile(file: File) {
    const token = sourceOperationsRef.current.start({
      origin: "local",
      sourceId: null,
      expectedFingerprint: null,
    });
    setSourceBusy(beginSourceBusy(token));

    try {
      const playlistText = await file.text();
      if (!canCommitSourceOperation(token)) return;
      const importedPlaylist = parseM3u(playlistText, file.name, {
        sourceId: createLocalM3uSourceIdentity(file.name, playlistText),
        trust: "trusted-local",
      });
      await applyImportedPlaylist(importedPlaylist, token, { sourceId: null });
    } catch (error) {
      if (canCommitSourceOperation(token)) {
        setMessage(redactCredentials(
          error instanceof Error ? error.message : "The playlist could not be imported.",
        ));
      }
    } finally {
      setSourceBusy((currentBusy) => finishSourceBusy(currentBusy, token));
    }
  }

  function handleToggleFavorite(channelId: string) {
    setFavoriteIds((currentIds) =>
      currentIds.includes(channelId)
        ? currentIds.filter((id) => id !== channelId)
        : [...currentIds, channelId],
    );
  }

  function showSelectedChannelGroup() {
    setNavigationSection("tv");
    setActiveGroup(
      selectedChannel && favoriteIdSet.has(selectedChannel.id)
        ? FAVORITES_GROUP_ID
        : selectedChannel?.group && enabledGroupSet.has(selectedChannel.group)
        ? selectedChannel.group
        : ALL_CHANNELS_GROUP_ID,
    );
    setSidebarMode("groups");
    setSearchQuery("");
  }

  async function playCanonicalChannel(channel: Channel) {
    try {
      const currentSourceId = activeSourceIdRef.current;
      const currentSource = currentSourceId ? savedSourcesRef.current[currentSourceId] : null;
      if (currentSourceId && !currentSource) {
        throw new Error("The active saved source is unavailable. Load it again before playback.");
      }
      const materializedChannel = materializeChannelForPlayback(
        channel,
        currentSource ?? { id: "local", kind: "m3u_url" },
      );
      return await playChannel(materializedChannel);
    } catch (error) {
      setMessage(redactCredentials(
        error instanceof Error ? error.message : "The channel could not be prepared for playback.",
      ));
      return false;
    }
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

    await playCanonicalChannel(channel);

    setPlaybackSession((currentSession) => ({
      ...currentSession,
      sourceId: activeSourceId,
      channelId: channel.id,
    }));
  }

  async function handleStopPlayback() {
    setPlaybackSession((currentSession) => ({
      ...currentSession,
      sourceId: activeSourceId,
      channelId: selectedChannelId,
      shouldResume: false,
      resumeSourceId: null,
      resumeChannelId: null,
      resumeInFullscreen: false,
    }));

    await stopPlayback();
  }

  async function handleReloadPlayback() {
    const channel = selectedChannelIdRef.current
      ? importedReferencesRef.current.playlistSnapshot?.playlist.channels.find(
          (candidate) => candidate.id === selectedChannelIdRef.current,
        ) ?? null
      : null;
    if (channel) {
      await playCanonicalChannel(channel);
    }
  }

  async function handleToggleFullscreen() {
    try {
      if (isTauri()) {
        const appWindow = getCurrentWindow();
        const nextFullscreen = !(await appWindow.isFullscreen());

        await appWindow.setFullscreen(nextFullscreen);
        if (nextFullscreen && selectedChannel?.isPlayable) {
          setPlaybackSession((currentSession) => ({
            ...currentSession,
            sourceId: activeSourceId,
            channelId: selectedChannel.id,
            shouldResume: true,
            resumeSourceId: activeSourceId,
            resumeChannelId: selectedChannel.id,
            resumeInFullscreen: true,
          }));
        }
        if (!nextFullscreen) {
          showSelectedChannelGroup();
        }
        setIsFullscreen(nextFullscreen);
        schedulePlayerLayoutSync();
        return;
      }

      if (!playerShellRef.current) {
        return;
      }

      if (document.fullscreenElement) {
        await document.exitFullscreen();
        showSelectedChannelGroup();
        setIsFullscreen(false);
        schedulePlayerLayoutSync();
        return;
      }

      await playerShellRef.current.requestFullscreen();
      if (selectedChannel?.isPlayable) {
        setPlaybackSession((currentSession) => ({
          ...currentSession,
          sourceId: activeSourceId,
          channelId: selectedChannel.id,
          shouldResume: true,
          resumeSourceId: activeSourceId,
          resumeChannelId: selectedChannel.id,
          resumeInFullscreen: true,
        }));
      }
      setIsFullscreen(true);
      schedulePlayerLayoutSync();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Fullscreen mode could not be changed.";
      setMessage(errorMessage);
    }
  }

  async function handleLoadSavedSource(sourceId: string) {
    const source = savedSourcesRef.current[sourceId];

    if (!source) return;
    if (!isSourceProfileReady(source)) {
      setMessage("Complete the saved source details and enable it before loading.");
      return;
    }

    const token = sourceOperationsRef.current.start({
      origin: "saved",
      sourceId,
      expectedFingerprint: sourceRevisionsRef.current.current(sourceId),
    });
    setSourceBusy(beginSourceBusy(token));

    try {
      await importFromSavedSource(source, token);
    } catch (error) {
      if (canCommitSourceOperation(token)) {
        setMessage(redactCredentials(
          error instanceof Error ? error.message : "The saved source could not be loaded.",
        ));
      }
    } finally {
      setSourceBusy((currentBusy) => finishSourceBusy(currentBusy, token));
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
    sourceOperationsRef.current.invalidateSource(sourceId);
    sourceRevisionsRef.current.bump(sourceId);
    startupSourceRefreshResultRef.current = savedSourcesRef.current[sourceId]?.enabled
      ? "failed"
      : "pending";
    setStartupRestoreToken((currentToken) =>
      currentToken?.sourceId === sourceId ? null : currentToken,
    );
    setSourceBusy((currentBusy) => currentBusy?.sourceId === sourceId ? null : currentBusy);
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

  async function handleUpdateSource(sourceId: string, patch: Partial<SavedPlaylistSource>) {
    const source = savedSourcesRef.current[sourceId];
    if (!source) return;

    const commitUpdate = () => {
      sourceOperationsRef.current.invalidateSource(sourceId);
      sourceRevisionsRef.current.bump(sourceId);
      startupSourceRefreshResultRef.current = "pending";
      setStartupRestoreToken((currentToken) =>
        currentToken?.sourceId === sourceId ? null : currentToken,
      );
      setSourceBusy((currentBusy) => currentBusy?.sourceId === sourceId ? null : currentBusy);
      setSavedSources((currentSources) => {
        const currentSource = currentSources[sourceId];
        if (!currentSource) return currentSources;
        return {
          ...currentSources,
          [sourceId]: updateSourceProfile(currentSource, patch),
        };
      });
    };
    const clearsM3uUrl =
      source.kind === "m3u_url" &&
      "url" in patch &&
      typeof patch.url === "string" &&
      source.url.trim().length > 0 &&
      patch.url.trim().length === 0;
    const clearsXtreamPassword =
      source.kind === "xtream" &&
      "password" in patch &&
      typeof patch.password === "string" &&
      source.password.length > 0 &&
      patch.password.length === 0;

    if (clearsM3uUrl || clearsXtreamPassword) {
      try {
        await deleteSourceSecretBeforeCommit(source, commitUpdate);
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "The saved source credential could not be removed. Existing saved data was kept.",
        );
      }
      return;
    }

    commitUpdate();
  }

  async function handleRemoveSource(sourceId: string) {
    const source = savedSources[sourceId];

    if (!source) {
      return;
    }

    try {
      await deleteSourceSecretBeforeCommit(source, () => undefined);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The saved source credential could not be removed. Existing saved data was kept.",
      );
      return;
    }

    sourceOperationsRef.current.invalidateSource(sourceId);
    sourceRevisionsRef.current.bump(sourceId);
    startupSourceRefreshResultRef.current = "failed";
    setStartupRestoreToken((currentToken) =>
      currentToken?.sourceId === sourceId ? null : currentToken,
    );
    setSourceBusy((currentBusy) => currentBusy?.sourceId === sourceId ? null : currentBusy);

    const cleanupEntry = sourceLibraryIndex[sourceId];
    const trackedChannelIds = new Set(cleanupEntry?.channelIds ?? []);
    const trackedPlaylistPreferenceKeys = cleanupEntry?.playlistPreferenceKeys ?? [];
    const hasTrackedCollapsedGroups = trackedPlaylistPreferenceKeys.some((preferenceKey) =>
      Object.prototype.hasOwnProperty.call(collapsedGroupsByLibrary, preferenceKey),
    );
    const shouldClearLoadedPlaylist =
      activeSourceId === sourceId || playlistSnapshot?.sourceId === sourceId;
    const sourceLabel = source.name.trim().length > 0 ? source.name.trim() : "Saved source";

    if (shouldClearLoadedPlaylist) {
      await stopPlayback();
    }

    setSavedSources((currentSources) => {
      const nextSources = { ...currentSources };
      delete nextSources[sourceId];
      return nextSources;
    });
    setSourceLibraryIndex((currentIndex) => {
      const nextIndex = { ...currentIndex };
      delete nextIndex[sourceId];
      return nextIndex;
    });
    setCollapsedSourceIds((currentIds) =>
      currentIds.filter((currentId) => currentId !== sourceId),
    );
    setFavoriteIds((currentIds) =>
      currentIds.filter((channelId) => !trackedChannelIds.has(channelId)),
    );
    setRecentIds((currentIds) =>
      currentIds.filter((channelId) => !trackedChannelIds.has(channelId)),
    );
    setHiddenGroupsByLibrary((currentValue) => {
      if (trackedPlaylistPreferenceKeys.length === 0) {
        return currentValue;
      }

      const nextValue = { ...currentValue };

      for (const preferenceKey of trackedPlaylistPreferenceKeys) {
        delete nextValue[preferenceKey];
      }

      return nextValue;
    });
    setCollapsedGroupsByLibrary((currentValue) => {
      if (trackedPlaylistPreferenceKeys.length === 0 || !hasTrackedCollapsedGroups) {
        return currentValue;
      }

      const nextValue = { ...currentValue };

      for (const preferenceKey of trackedPlaylistPreferenceKeys) {
        delete nextValue[preferenceKey];
      }

      return nextValue;
    });
    setSavedEpgMappings((currentMappings) =>
      removeMappingsForSourceScope(currentMappings, sourceId),
    );
    setPlaybackSession((currentSession) =>
      currentSession.sourceId === sourceId || currentSession.resumeSourceId === sourceId
        ? {
            sourceId: null,
            channelId: null,
            shouldResume: false,
            resumeSourceId: null,
            resumeChannelId: null,
            resumeInFullscreen: false,
          }
        : currentSession,
    );

    if (shouldClearLoadedPlaylist) {
      setActiveSourceId(null);
      setPlaylistSnapshot(null);
      setGuideProgrammesByChannelKey({});
      setMatcherChannel(null);

      startTransition(() => {
        setPlaylist(null);
        setSelectedChannelId(null);
        setActiveGroup(null);
        setSidebarMode("menu");
        setSearchQuery("");
        setNavigationSection("search");
      });
    }

    setMessage(`Removed ${sourceLabel} and cleared its saved data.`);
  }

  function openSettings(tab: SettingsTab) {
    setSidebarMode("menu");
    setSettingsTab(tab);
    setIsSettingsOpen(true);
  }

  function handleAddEpgSource() {
    setEpgSources((currentSources) => [...currentSources, createEpgSource()]);
  }

  function canCommitEpgOperation(token: EpgOperationToken) {
    return epgOperationsRef.current.canCommit(
      token,
      getEpgSourceCommitState(epgSourcesRef.current, token.sourceId, token.configRevision),
    );
  }

  function invalidateEpgSourceOperation(sourceId: string) {
    epgOperationsRef.current.invalidate(sourceId);
    epgDirectoryLoadRevisionRef.current += 1;
    setEpgBusyBySourceId((currentBusy) => {
      if (!currentBusy[sourceId]) return currentBusy;
      const nextBusy = { ...currentBusy };
      delete nextBusy[sourceId];
      return nextBusy;
    });
  }

  function handleToggleEpgSourceEnabled(sourceId: string) {
    invalidateEpgSourceOperation(sourceId);
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
    const previousSource = epgSourcesRef.current.find((source) => source.id === sourceId);
    if (!previousSource) return;

    if (patch.url !== undefined) {
      void saveEpgUrlBeforeCommit(sourceId, patch.url, () => {
        invalidateEpgSourceOperation(sourceId);
        setEpgSources((currentSources) => currentSources.map((source) =>
          source.id === sourceId ? updateEpgSource(source, patch) : source,
        ));
        setEpgStatusMessage(null);
        setGuideProgrammesByChannelKey({});
        setEpgDirectoriesBySourceId((currentDirectories) => {
          const nextDirectories = { ...currentDirectories };
          delete nextDirectories[sourceId];
          return nextDirectories;
        });
        setSavedEpgMappings((mappings) => removeMappingsForGuideSource(mappings, sourceId));
        void deleteEpgCache(sourceId).catch(() => {
          // A URL rotation invalidates this source's previous cache on a best-effort basis.
        });
      }).catch((error: unknown) => {
        setMessage(error instanceof Error
          ? error.message
          : "EPG URL changes could not be secured. Existing saved data was kept.");
      });
      return;
    }

    invalidateEpgSourceOperation(sourceId);
    setEpgSources((currentSources) => currentSources.map((source) =>
      source.id === sourceId ? updateEpgSource(source, patch) : source,
    ));
  }

  function handleRemoveEpgSource(sourceId: string) {
    const sourceToRemove = epgSourcesRef.current.find((source) => source.id === sourceId);
    if (!sourceToRemove) return;
    const sourceLabel = sanitizeEpgSourceLabel(getEpgSourceLabel(sourceToRemove));

    void deleteEpgUrlBeforeCommit(sourceId, () => {
      invalidateEpgSourceOperation(sourceId);
      setEpgSources((sources) => sources.filter((source) => source.id !== sourceId));
      setEpgDirectoriesBySourceId((currentDirectories) => {
        const nextDirectories = { ...currentDirectories };
        delete nextDirectories[sourceId];
        return nextDirectories;
      });
      setGuideProgrammesByChannelKey((currentProgrammes) => {
        const nextProgrammes = { ...currentProgrammes };
        for (const programmeKey of Object.keys(nextProgrammes)) {
          if (programmeKey.startsWith(`${sourceId}\u0001`)) delete nextProgrammes[programmeKey];
        }
        return nextProgrammes;
      });
      setSavedEpgMappings((mappings) => removeMappingsForGuideSource(mappings, sourceId));
      setEpgStatusMessage(`Removed ${sourceLabel}.`);
      void deleteEpgCache(sourceId).catch(() => {
        // A removed profile cannot commit subsequent cache mutations.
      });
    }).catch((error: unknown) => {
      setMessage(error instanceof Error
        ? error.message
        : "The saved EPG URL could not be removed. Existing saved data was kept.");
    });
  }

  async function refreshEpgGuideForSource(
    source: EpgSource,
    reason: "manual" | "startup" | "auto",
  ) {
    const rawGuideUrl = source.url.trim();
    const sourceLabel = sanitizeEpgSourceLabel(getEpgSourceLabel(source));

    if (rawGuideUrl.length === 0) {
      const statusCopy = `Enter an EPG URL first for ${sourceLabel}.`;
      setEpgStatusMessage(statusCopy);

      if (reason === "manual") {
        setMessage(statusCopy);
      }

      return null;
    }

    epgDirectoryLoadRevisionRef.current += 1;
    const token = epgOperationsRef.current.start(source.id, source.updatedAt);
    setEpgBusyBySourceId((currentBusy) => ({
      ...currentBusy,
      [source.id]: beginEpgSourceOperation(token),
    }));

    const refreshPromise = refreshEpgCache(source.id, rawGuideUrl)
      .then((directory) => {
        if (!canCommitEpgOperation(token)) return null;
        const diagnosticStatus = formatEpgDirectoryDiagnostics(directory);

        const reconstructed = reconstructEpgCacheDirectories([directory], epgSourcesRef.current);
        setEpgDirectoriesBySourceId((currentDirectories) => ({
          ...currentDirectories,
          ...(reconstructed[source.id] ? { [source.id]: reconstructed[source.id] } : {}),
        }));
        setEpgStatusMessage(
          `${sourceLabel} updated ${new Date(directory.fetchedAt).toLocaleString()}.${
            diagnosticStatus ? ` ${diagnosticStatus}` : ""
          }`,
        );
        return directory;
      })
      .catch(() => {
        if (!canCommitEpgOperation(token)) return null;
        const statusCopy = formatEpgFailureStatus(sourceLabel);

        setEpgStatusMessage(statusCopy);

        if (reason === "manual") {
          setMessage(statusCopy);
        }

        return null;
      })
      .finally(() => {
        setEpgBusyBySourceId((currentBusy) => {
          const nextSourceBusy = finishEpgSourceOperation(currentBusy[source.id] ?? null, token);
          if (nextSourceBusy === currentBusy[source.id]) return currentBusy;
          const nextBusy = { ...currentBusy };
          if (nextSourceBusy) nextBusy[source.id] = nextSourceBusy;
          else delete nextBusy[source.id];
          return nextBusy;
        });
      });

    return refreshPromise;
  }

  const normalizedEpgSources = useMemo(() => normalizeEpgSources(epgSources), [epgSources]);
  const updatingEpgSourceIds = useMemo(() => Object.keys(epgBusyBySourceId), [epgBusyBySourceId]);
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
    () => playlistEpgScope
      ? enabledReadyEpgSources.map((source) => ({
          sourceId: source.id,
          mappings: savedEpgMappings[createEpgMappingScope(playlistEpgScope, source.id)] ?? {},
        }))
      : [],
    [enabledReadyEpgSources, playlistEpgScope, savedEpgMappings],
  );
  const enabledEpgDirectories = useMemo(
    () => enabledReadyEpgSources
      .map((source) => epgDirectoriesBySourceId[source.id] ?? null)
      .filter((directory): directory is EpgDirectoryResponse => directory !== null),
    [enabledReadyEpgSources, epgDirectoriesBySourceId],
  );
  const enabledEpgDirectoryKey = useMemo(
    () => enabledEpgDirectories
      .map((directory) => `${directory.sourceId}\u0001${directory.fetchedAt}`)
      .join("\u0001"),
    [enabledEpgDirectories],
  );
  const epgSourceLabelsById = useMemo(
    () => Object.fromEntries(normalizedEpgSources.map((source) => [
      source.id,
      sanitizeEpgSourceLabel(getEpgSourceLabel(source)),
    ])),
    [normalizedEpgSources],
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
  const guideWindowStartMs = useMemo(() => {
    const slotDurationMs = GUIDE_SLOT_MINUTES * 60 * 1000;
    return Math.floor(guideNowMs / slotDurationMs) * slotDurationMs;
  }, [guideNowMs]);
  const guideWindowEndMs = guideWindowStartMs + GUIDE_VISIBLE_SLOT_COUNT * GUIDE_SLOT_MINUTES * 60 * 1000;
  const guideQueryEndMs = guideWindowEndMs + GUIDE_SLOT_MINUTES * 60 * 1000;
  const playlistPreferenceKey = getPlaylistPreferenceKey(playlist);
  const hiddenGroups = playlistPreferenceKey ? hiddenGroupsByLibrary[playlistPreferenceKey] ?? [] : [];
  const hiddenGroupSet = useMemo(() => new Set(hiddenGroups), [hiddenGroups]);
  const favoriteIdSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const enabledGroups = useMemo(
    () => allGroups.filter((group) => !hiddenGroupSet.has(group)),
    [allGroups, hiddenGroupSet],
  );
  const enabledGroupSet = useMemo(() => new Set(enabledGroups), [enabledGroups]);
  const enabledChannels = useMemo(
    () => channels.filter((channel) => enabledGroupSet.has(channel.group)),
    [channels, enabledGroupSet],
  );
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

    const programmes = guideProgrammesByChannelKey[resolvedMatch.epgChannel.uniqueId] ?? [];
    const guideSnapshot = getProgrammeSnapshot(programmes, guideNowMs);

    return {
      ...resolvedMatch,
      current: guideSnapshot.current,
      next: guideSnapshot.next,
    };
  }, [guideNowMs, guideProgrammesByChannelKey, resolvedEpgMatchesByChannelId]);
  const getProgrammesByChannelId = useCallback(
    (channelId: string) => {
      const resolvedMatch = resolvedEpgMatchesByChannelId[channelId];

      if (!resolvedMatch) {
        return [];
      }

      return guideProgrammesByChannelKey[resolvedMatch.epgChannel.uniqueId] ?? [];
    },
    [guideProgrammesByChannelKey, resolvedEpgMatchesByChannelId],
  );
  const matchedEpgChannelCount = useMemo(
    () => Object.keys(resolvedEpgMatchesByChannelId).length,
    [resolvedEpgMatchesByChannelId],
  );
  const savedSourcesList = useMemo(() => Object.values(savedSources), [savedSources]);
  const searchResults = useMemo(
    () =>
      normalizedSearchQuery.length === 0
        ? []
        : enabledChannels
            .filter((channel) => channel.name.toLowerCase().includes(normalizedSearchQuery))
            .slice(0, 120),
    [enabledChannels, normalizedSearchQuery],
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

  function handleToggleSourceCollapsed(sourceId: string) {
    setCollapsedSourceIds((currentIds) =>
      currentIds.includes(sourceId)
        ? currentIds.filter((currentId) => currentId !== sourceId)
        : [...currentIds, sourceId],
    );
  }

  function handleSelectAllChannels() {
    setNavigationSection("tv");
    setActiveGroup(ALL_CHANNELS_GROUP_ID);
    setSidebarMode("hidden");
  }

  function handleSelectGroup(group: string) {
    setNavigationSection("tv");
    setActiveGroup(group);
    setSidebarMode("hidden");
  }

  function handleSelectFavoritesGroup() {
    setNavigationSection("tv");
    setActiveGroup(FAVORITES_GROUP_ID);
    setSidebarMode("hidden");
  }

  const visibleChannels = useMemo(() => {
    const baseList =
      navigationSection === "search"
        ? normalizedSearchQuery.length > 0
          ? enabledChannels
          : []
        : activeGroup === FAVORITES_GROUP_ID
        ? favoriteChannels
        : activeGroup === ALL_CHANNELS_GROUP_ID
        ? enabledChannels
        : activeGroup && enabledGroupSet.has(activeGroup)
        ? channels
        : [];

    if (baseList.length === 0) {
      return [];
    }

    const needsGroupFilter =
      navigationSection !== "search" &&
      activeGroup !== FAVORITES_GROUP_ID &&
      activeGroup !== ALL_CHANNELS_GROUP_ID;
    const needsSearchFilter = normalizedSearchQuery.length > 0;

    if (!needsGroupFilter && !needsSearchFilter) {
      return baseList;
    }

    const result: Channel[] = [];

    for (const channel of baseList) {
      if (needsGroupFilter && channel.group !== activeGroup) {
        continue;
      }

      if (needsSearchFilter && !channel.name.toLowerCase().includes(normalizedSearchQuery)) {
        continue;
      }

      result.push(channel);
    }

    return result;
  }, [
    navigationSection,
    activeGroup,
    favoriteChannels,
    enabledChannels,
    enabledGroupSet,
    channels,
    normalizedSearchQuery,
  ]);

  useEffect(() => {
    setChannelRenderLimit(CHANNEL_RENDER_INITIAL_LIMIT);
  }, [activeGroup, navigationSection, normalizedSearchQuery, playlist?.importedAt]);

  useEffect(() => {
    if (!selectedChannelId) {
      return;
    }

    const selectedIndex = visibleChannels.findIndex((channel) => channel.id === selectedChannelId);

    if (selectedIndex < channelRenderLimit) {
      return;
    }

    setChannelRenderLimit(
      Math.min(visibleChannels.length, selectedIndex + 1 + CHANNEL_RENDER_BATCH_SIZE),
    );
  }, [channelRenderLimit, selectedChannelId, visibleChannels]);

  const renderedChannels = useMemo(
    () => visibleChannels.slice(0, channelRenderLimit),
    [channelRenderLimit, visibleChannels],
  );
  const handleLoadMoreVisibleChannels = useCallback(() => {
    setChannelRenderLimit((currentLimit) =>
      Math.min(visibleChannels.length, currentLimit + CHANNEL_RENDER_BATCH_SIZE),
    );
  }, [visibleChannels.length]);

  const selectedGuide = selectedChannel ? getGuideByChannelId(selectedChannel.id) ?? null : null;
  const visibleEpgChannelKeys = useMemo(() => {
    const keys = new Set<string>();

    for (const channel of renderedChannels) {
      const uniqueId = resolvedEpgMatchesByChannelId[channel.id]?.epgChannel.uniqueId;
      if (uniqueId) {
        keys.add(uniqueId);
      }
    }

    if (selectedGuide?.epgChannel.uniqueId) {
      keys.add(selectedGuide.epgChannel.uniqueId);
    }

    return [...keys];
  }, [renderedChannels, resolvedEpgMatchesByChannelId, selectedGuide]);
  const visibleEpgChannelKeysKey = visibleEpgChannelKeys.join("\u0001");
  const favoritesCount = favoriteChannels.length;
  const activeGroupLabel =
    navigationSection === "search"
      ? normalizedSearchQuery.length > 0
        ? "Search results"
        : "Search"
      : activeGroup === FAVORITES_GROUP_ID
      ? "Favorites"
      : activeGroup === ALL_CHANNELS_GROUP_ID
      ? "All channels"
      : activeGroup;
  const isFavoritesGroupActive = activeGroup === FAVORITES_GROUP_ID;
  const isAllChannelsGroupActive = activeGroup === ALL_CHANNELS_GROUP_ID;
  const isSidebarVisible = sidebarMode !== "hidden";
  const showSidebarRail = sidebarMode === "menu";
  const sidebarVisibilityClass = isSidebarVisible ? "workspace__sidebar--visible" : "";
  const sidebarModeClass =
    sidebarMode === "menu"
      ? "workspace__sidebar--menu"
      : sidebarMode === "groups"
      ? "workspace__sidebar--groups"
      : "";
  const workspaceModeClass =
    sidebarMode === "menu"
      ? "workspace--sidebar-menu"
      : sidebarMode === "groups"
      ? "workspace--sidebar-groups"
      : "";

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
    const scopedSourceIds = new Set(uniqueReadyEpgSources.map((source) => source.id));
    scopedSourceIds.add(epgChannel.sourceId);

    setSavedEpgMappings((currentMappings) => {
      const nextMappings = { ...currentMappings };

      for (const guideSourceId of scopedSourceIds) {
        const mappingScope = createEpgMappingScope(playlistEpgScope, guideSourceId);
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

      const targetMappingScope = createEpgMappingScope(playlistEpgScope, epgChannel.sourceId);
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
      `Matched ${channel.name} to ${epgChannel.displayNames[0] ?? epgChannel.id} from ${epgSourceLabelsById[epgChannel.sourceId] ?? "EPG guide"}.`,
    );
  }

  function handleClearManualEpgMatch(channel: Channel) {
    if (!playlistEpgScope) {
      return;
    }

    const mappingKeys = getChannelManualMappingKeys(channel);
    const scopedSourceIds = new Set(uniqueReadyEpgSources.map((source) => source.id));

    setSavedEpgMappings((currentMappings) => {
      const nextMappings = { ...currentMappings };

      for (const guideSourceId of scopedSourceIds) {
        const mappingScope = createEpgMappingScope(playlistEpgScope, guideSourceId);
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
    if (!epgSecretsHydrated) return undefined;
    const loadRevision = epgDirectoryLoadRevisionRef.current;
    setHasLoadedEpgCacheDirectories(false);

    void Promise.allSettled([loadEpgCacheDirectories(), getEpgCacheDiagnostics()])
      .then(([directoryResult, diagnosticsResult]) => {
        if (cancelled) return;

        if (
          directoryResult.status === "fulfilled" &&
          epgDirectoryLoadRevisionRef.current === loadRevision
        ) {
          setEpgDirectoriesBySourceId(
            reconstructEpgCacheDirectories(directoryResult.value, epgSourcesRef.current),
          );
        }

        if (diagnosticsResult.status === "fulfilled") {
          const diagnosticStatus = formatEpgStoreDiagnostics(diagnosticsResult.value);
          if (diagnosticStatus) setEpgStatusMessage(diagnosticStatus);
        } else if (directoryResult.status === "rejected") {
          setEpgStatusMessage("The saved guide cache could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHasLoadedEpgCacheDirectories(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [epgSecretsHydrated]);

  useEffect(() => {
    if (!hasHydratedPersistentState || !hasLoadedEpgCacheDirectories) {
      return undefined;
    }

    const timerIds: number[] = [];

    for (const [index, source] of enabledReadyEpgSources.entries()) {
      const startupKey = `${source.id}\u0001${normalizeEpgUrlKey(source.url)}\u0001${
        source.updateOnStartup ? "enabled" : "disabled"
      }`;

      if (startupEpgRefreshAttemptedRef.current.has(startupKey)) {
        continue;
      }

      if (!source.updateOnStartup) {
        startupEpgRefreshAttemptedRef.current.add(startupKey);
        continue;
      }

      const timerId = window.setTimeout(() => {
        if (startupEpgRefreshAttemptedRef.current.has(startupKey)) {
          return;
        }

        startupEpgRefreshAttemptedRef.current.add(startupKey);
        void refreshEpgGuideForSource(source, "startup");
      }, index * 1500);

      timerIds.push(timerId);
    }

    return () => {
      timerIds.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
    };
  }, [enabledReadyEpgSources, hasHydratedPersistentState, hasLoadedEpgCacheDirectories]);

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
      setGuideProgrammesByChannelKey({});
      return () => {
        cancelled = true;
      };
    }

    void getEpgProgrammeWindows(visibleEpgChannelKeys, guideWindowStartMs, guideQueryEndMs)
      .then((programmeWindows) => {
        if (cancelled) {
          return;
        }

        const nextProgrammes: Record<string, EpgProgrammeSummary[]> = {};

        for (const programmeWindow of programmeWindows) {
          nextProgrammes[programmeWindow.epgChannelKey] = programmeWindow.programmes;
        }

        setGuideProgrammesByChannelKey(nextProgrammes);
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
  }, [enabledEpgDirectoryKey, guideQueryEndMs, guideWindowStartMs, visibleEpgChannelKeysKey]);

  useEffect(() => {
    if (!playlist) {
      if (activeGroup !== null) {
        setActiveGroup(null);
      }

      return;
    }

    const hasValidActiveGroup =
      activeGroup === FAVORITES_GROUP_ID ||
      activeGroup === ALL_CHANNELS_GROUP_ID ||
      (activeGroup !== null && enabledGroupSet.has(activeGroup));

    if (!hasValidActiveGroup) {
      setActiveGroup(ALL_CHANNELS_GROUP_ID);
    }
  }, [activeGroup, enabledGroupSet, enabledGroups, playlist]);

  useEffect(() => {
    if (startupPlaybackRestoreCompletedRef.current) {
      return;
    }

    const startupPlaybackSession = startupPlaybackSessionRef.current;

    if (
      !hasHydratedPersistentState ||
      shouldDelayResumeForStartupRestore ||
      isRestoringStartupSource
    ) {
      return;
    }

    if (!playlist || player.environment !== "tauri" || !player.ready) {
      return;
    }

    const resumeSourceId = startupPlaybackSession?.resumeSourceId ?? null;
    const resumeChannelId = startupPlaybackSession?.resumeChannelId ?? null;
    const resumeInFullscreen = startupPlaybackSession?.resumeInFullscreen ?? false;

    if (resumeChannelId === null || !startupPlaybackSession?.shouldResume || resumeSourceId !== activeSourceId) {
      startupPlaybackRestoreCompletedRef.current = true;
      return;
    }

    if (resumeSourceId !== null && startupSourceRefreshResultRef.current !== "succeeded") {
      setPlaybackSession((currentSession) => ({
        ...currentSession,
        shouldResume: false,
        resumeSourceId: null,
        resumeChannelId: null,
        resumeInFullscreen: false,
      }));
      if (cachedStartupPlaylistNeedsRefresh || !cachedStartupPlaylistPlaybackReady) {
        setMessage((currentMessage) => currentMessage ??
          "Cached source metadata is available for browsing, but refresh is required before playback.");
      }
      startupPlaybackRestoreCompletedRef.current = true;
      return;
    }

    const restoreKey = `${activeSourceId ?? "local"}\u0001${playlist.importedAt}\u0001${resumeChannelId}`;

    if (startupPlaybackRestoreKeyRef.current === restoreKey) {
      startupPlaybackRestoreCompletedRef.current = true;
      return;
    }

    if (resumeInFullscreen && !isFullscreen) {
      let cancelled = false;

      const enterStartupFullscreen = async () => {
        try {
          if (isTauri()) {
            const appWindow = getCurrentWindow();
            if (!(await appWindow.isFullscreen())) {
              await appWindow.setFullscreen(true);
            }
            if (!cancelled) {
              setIsFullscreen(true);
              schedulePlayerLayoutSync();
            }
            return;
          }

          if (playerShellRef.current && !document.fullscreenElement) {
            await playerShellRef.current.requestFullscreen();
          }

          if (!cancelled) {
            setIsFullscreen(true);
            schedulePlayerLayoutSync();
          }
        } catch {
          if (!cancelled) {
            setPlaybackSession((currentSession) =>
              (currentSession.resumeSourceId ?? null) === activeSourceId &&
              (currentSession.resumeChannelId ?? null) === resumeChannelId
                ? {
                    ...currentSession,
                    shouldResume: false,
                    resumeSourceId: null,
                    resumeChannelId: null,
                    resumeInFullscreen: false,
                  }
                : currentSession,
            );
            startupPlaybackRestoreCompletedRef.current = true;
          }
        }
      };

      void enterStartupFullscreen();

      return () => {
        cancelled = true;
      };
    }

    const channelToResume = (resumeChannelId !== null ? channelsById.get(resumeChannelId) : null) ?? null;

    if (!channelToResume || !channelToResume.isPlayable) {
      setPlaybackSession((currentSession) =>
        (currentSession.resumeSourceId ?? null) === activeSourceId
          ? {
              ...currentSession,
              shouldResume: false,
              resumeSourceId: null,
              resumeChannelId: null,
              resumeInFullscreen: false,
            }
          : currentSession,
      );
      startupPlaybackRestoreCompletedRef.current = true;
      return;
    }

    startupPlaybackRestoreKeyRef.current = restoreKey;
    startupPlaybackRestoreCompletedRef.current = true;
    setSelectedChannelId(channelToResume.id);
    persistSelectedChannel(channelToResume.id);
    setRecentIds((currentIds) => pushRecentId(currentIds, channelToResume.id));

    void playCanonicalChannel(channelToResume).then((didStartPlayback) => {
      setPlaybackSession((currentSession) =>
        (currentSession.resumeSourceId ?? null) === activeSourceId &&
        (currentSession.resumeChannelId ?? null) === channelToResume.id
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
    hasHydratedPersistentState,
    isFullscreen,
    isRestoringStartupSource,
    player.environment,
    player.ready,
    playlist,
    setPlaybackSession,
    setRecentIds,
    shouldDelayResumeForStartupRestore,
  ]);

  if (!hasHydratedPersistentState) {
    return (
      <main className={`app-shell ${isFullscreen ? "app-shell--fullscreen" : ""}`}>
        <div className="panel empty-state">
          <strong>Loading library</strong>
          <span>Opening saved app data...</span>
        </div>
      </main>
    );
  }

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
            void handleReloadPlayback();
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
        <div className={`workspace ${workspaceModeClass}`}>
          <div className={`workspace__sidebar ${sidebarVisibilityClass} ${sidebarModeClass}`.trim()}>
            <ChannelSidebar
              showRail={showSidebarRail}
              navigationSection={navigationSection}
              playlistName={playlistDisplayName}
              enabledGroups={enabledGroups}
              isAllChannelsActive={navigationSection === "tv" && isAllChannelsGroupActive}
              isFavoritesActive={navigationSection === "tv" && isFavoritesGroupActive}
              activeGroup={activeGroup}
              favoritesCount={favoritesCount}
              allChannelCount={enabledChannels.length}
              channelCountByGroup={channelCountByGroup}
              searchQuery={searchQuery}
              searchResults={searchResults}
              selectedChannelId={selectedChannel?.id ?? null}
              favoriteIdSet={favoriteIdSet}
              message={message}
              onSelectNavigationSection={(section) => {
                setNavigationSection(section);
                setSidebarMode("menu");
              }}
              onSearchChange={setSearchQuery}
              onSelectChannel={(channel) => {
                setSidebarMode("hidden");
                void handleSelectChannel(channel);
              }}
              onSelectAllChannels={handleSelectAllChannels}
              onSelectFavorites={handleSelectFavoritesGroup}
              onSelectGroup={handleSelectGroup}
              onOpenSettings={() => {
                openSettings(playlist ? "library" : "sources");
              }}
            />
          </div>

          <div className="workspace__content">
            <ChannelShelf
              navigationSection={navigationSection}
              isSidebarVisible={isSidebarVisible}
              preview={
                <PlayerPanel
                  player={player}
                  selectedChannel={selectedChannel}
                  guide={selectedGuide}
                  isFullscreen={isFullscreen}
                  layout="preview"
                  playerShellRef={playerShellRef}
                  playerSurfaceRef={playerSurfaceRef}
                  onStop={() => {
                    void handleStopPlayback();
                  }}
                  onReload={() => {
                    void handleReloadPlayback();
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
              }
              activeGroupLabel={activeGroupLabel}
              playlistName={playlistDisplayName}
              channels={renderedChannels}
              totalChannelCount={visibleChannels.length}
              selectedChannel={selectedChannel}
              selectedGuide={selectedGuide}
              selectedChannelId={selectedChannel?.id ?? null}
              favoriteIdSet={favoriteIdSet}
              getGuideByChannelId={getGuideByChannelId}
              getProgrammesByChannelId={getProgrammesByChannelId}
              canMatchEpg={enabledEpgChannels.length > 0}
              guideNowMs={guideNowMs}
              guideWindowStartMs={guideWindowStartMs}
              guideWindowEndMs={guideWindowEndMs}
              searchQuery={searchQuery}
              onSelectChannel={(channel) => {
                void handleSelectChannel(channel);
              }}
              onToggleFavorite={handleToggleFavorite}
              onOpenEpgMatcher={handleOpenEpgMatcher}
              onLoadMoreChannels={handleLoadMoreVisibleChannels}
            />
          </div>
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
        epgDirectoriesBySourceId={epgDirectoriesBySourceId}
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
        onRemoveSource={(sourceId) => {
          void handleRemoveSource(sourceId);
        }}
        onUpdateSource={handleUpdateSource}
      />

      <ChannelEpgMatchDialog
        isOpen={matcherChannel !== null}
        channel={matcherChannel}
        epgChannels={enabledEpgChannels}
        currentGuide={matcherChannel ? getGuideByChannelId(matcherChannel.id) ?? null : null}
        sourceLabelsById={epgSourceLabelsById}
        onClose={() => setMatcherChannel(null)}
        onApplyMatch={handleApplyManualEpgMatch}
        onClearMatch={handleClearManualEpgMatch}
      />
    </main>
  );
}

export default App;
