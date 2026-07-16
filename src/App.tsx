import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChannelEpgMatchDialog } from "./components/ChannelEpgMatchDialog";
import { ChannelShelf } from "./components/ChannelShelf";
import { ChannelSidebar } from "./components/ChannelSidebar";
import type { AutoResumeMode } from "./components/GeneralSettingsPanel";
import { PlayerPanel } from "./components/PlayerPanel";
import { SettingsDrawer, type SettingsTab } from "./components/SettingsDrawer";
import { UserGuideDrawer } from "./components/UserGuideDrawer";
import { VodBrowser } from "./components/VodBrowser";
import { VodPlayerPanel } from "./components/VodPlayerPanel";
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
  LegacyPlaylistSnapshot,
  PlaylistCacheSnapshot,
  PlaylistSelectionState,
  SavedPlaylistSource,
  SavedXtreamSource,
  SourceLibraryIndex,
} from "./domain/sourceProfiles";
import type { VodKind, VodNavigationState, VodPlaybackItem } from "./domain/vod";
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
  reconstructEpgCacheDirectories,
  resolveEpgChannelMatch,
  serializeEpgMappings,
} from "./features/epg/matching";
import {
  beginEpgSourceOperation,
  createEpgOperationCoordinator,
  finishEpgSourceOperation,
  getEpgAutoUpdateIdentity,
  getEpgSourceCommitState,
  getEpgStartupIdentity,

  type EpgOperationToken,
  type EpgSourceBusyState,
} from "./features/epg/operations";
import {
  applyEpgUrlDraft,
  canRunEpgMappingMigration,
  deleteEpgUrlBeforeCommit,
  EPG_SOURCES_STORAGE_KEY,
  getEpgSecretHydrationFingerprint,
  hydrateEpgSecrets,
  loadEpgUrl,
  requireEpgMappingMigrationReady,
  saveEpgUrlsBeforePersist,
  serializeEpgSources,
} from "./features/epg/secrets";
import { DEFAULT_PLAYER_VOLUME, useMpvPlayer } from "./features/player/mpv";
import {
  commitIfCurrentPlaybackRevision,
  LatestPlaybackOperationCoordinator,
} from "./features/player/operations";
import { parseM3u } from "./features/playlist/m3u";
import { createLocalM3uSourceIdentity } from "./features/playlist/channelFactory";
import { cancelPlaylistOperation, downloadPlaylistFromUrl } from "./features/playlist/remote";
import { importXtreamPlaylist } from "./features/playlist/xtream";
import { materializeChannelForPlayback } from "./features/playlist/materialize";
import { redactCredentials } from "./features/playlist/redaction";
import {
  createPlaylistCacheSnapshot,
  createPlaylistPersistenceCoordinator,
  isChannelPlaybackReady,
  resolvePlaylistSelectionHydration,
  revivePlaylistCacheSnapshot,
  revivePlaylistSelectionState,
  sanitizePlaylistCacheSnapshot,
  serializePlaylistCacheSnapshot,
  serializePlaylistSelectionState,
  shouldRefreshPlaylistCache,
} from "./features/playlist/snapshot";
import {
  createSourceRevisionTracker,
  createStartupSourceRestoreState,
  getSourceOperationCommitState,
  migrateImportedChannelReferences,
  migrateStartupPlaybackSession,
  resolveStartupResumeReadiness,
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
import { createSourceMutationCoordinator } from "./features/sources/mutations";
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
  saveXtreamPasswordBeforeCommit,
} from "./features/sources/secrets";
import {
  getHiddenVodCategoryIds,
  normalizeVodCategoryVisibilityStore,
  removeVodCategoryVisibilitySource,
  updateHiddenVodCategoryIds,
  type VodCategoryVisibilityStore,
} from "./features/vod/preferences";
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
const PLAYLIST_SELECTION_STORAGE_KEY = "iptv-player:playlist-selection";
const COLLAPSED_SOURCE_CARDS_STORAGE_KEY = "iptv-player:collapsed-source-cards";

const EPG_MANUAL_MATCHES_STORAGE_KEY = "iptv-player:epg-manual-matches";
const PLAYER_RESUME_STORAGE_KEY = "iptv-player:playback-session";
const PLAYER_VOLUME_STORAGE_KEY = "iptv-player:player-volume";
const AUTO_RESUME_MODE_STORAGE_KEY = "iptv-player:auto-resume-mode";
const VOD_CATEGORY_VISIBILITY_STORAGE_KEY = "iptv-player:vod-hidden-categories";
const RECENT_CHANNEL_LIMIT = 12;
const ALL_CHANNELS_GROUP_ID = "__iptv_player_all__";
const FAVORITES_GROUP_ID = "__iptv_player_favorites__";
const CHANNEL_RENDER_INITIAL_LIMIT = 320;
const CHANNEL_RENDER_BATCH_SIZE = 320;
const GUIDE_SLOT_MINUTES = 30;
const GUIDE_VISIBLE_SLOT_COUNT = 4;
const GUIDE_CLOCK_REFRESH_MS = 30 * 1000;
interface PlaybackSession {
  sourceId: string | null;
  channelId: string | null;
  shouldResume: boolean;
  resumeSourceId: string | null;
  resumeChannelId: string | null;
  resumeInFullscreen: boolean;
}

function createEmptyVodNavigationState(): VodNavigationState {
  return {
    sourceId: null,
    streamOrigin: null,
    categories: [],
    activeCategoryId: null,
    searchQuery: "",
    loadingCategories: false,
    activeCatalogCount: 0,
  };
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
  const [autoResumeMode, setAutoResumeMode, autoResumeModeHydrated] = usePersistentState<AutoResumeMode>(
    AUTO_RESUME_MODE_STORAGE_KEY,
    "fullscreen",
    (value) => value === "mini-player" ? "mini-player" : "fullscreen",
  );
  const [hiddenVodCategoriesBySource, setHiddenVodCategoriesBySource] =
    usePersistentState<VodCategoryVisibilityStore>(
      VOD_CATEGORY_VISIBILITY_STORAGE_KEY,
      {},
      normalizeVodCategoryVisibilityStore,
    );
  const [
    playlistSnapshot,
    setPlaylistSnapshot,
    playlistSnapshotHydrated,
    playlistSnapshotMetadata,
    playlistSnapshotPersistenceFailed,
  ] =
    usePersistentState<PlaylistCacheSnapshot | LegacyPlaylistSnapshot | null>(
      PLAYLIST_SNAPSHOT_STORAGE_KEY,
      null,
      revivePlaylistCacheSnapshot,
      serializePlaylistCacheSnapshot,
    );
  const [
    playlistSelection,
    setPlaylistSelection,
    playlistSelectionHydrated,
    playlistSelectionMetadata,
    playlistSelectionPersistenceFailed,
  ] =
    usePersistentState<PlaylistSelectionState | null>(
      PLAYLIST_SELECTION_STORAGE_KEY,
      null,
      revivePlaylistSelectionState,
      serializePlaylistSelectionState,
    );
  const [playlist, setPlaylist] = useState<PlaylistImport | null>(null);
  const [activeSection, setActiveSection] = useState<"live" | "movies" | "series">("live");
  const [visitedVodSections, setVisitedVodSections] = useState({ movies: false, series: false });
  const [vodNavigationByKind, setVodNavigationByKind] = useState<Record<VodKind, VodNavigationState>>(() => ({
    movie: createEmptyVodNavigationState(),
    series: createEmptyVodNavigationState(),
  }));
  const [activeVodPlayback, setActiveVodPlayback] = useState<VodPlaybackItem | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState<SourceBusyState | null>(null);
  const [channelRenderLimit, setChannelRenderLimit] = useState(CHANNEL_RENDER_INITIAL_LIMIT);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isUserGuideOpen, setIsUserGuideOpen] = useState(false);
  const [startupRestoreToken, setStartupRestoreToken] = useState<SourceOperationToken | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
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
  const [activeSourceSecretHydrated, setActiveSourceSecretHydrated] = useState(false);
  const [epgSecretsHydrated, setEpgSecretsHydrated] = useState(false);
  const [epgStatusMessage, setEpgStatusMessage] = useState<string | null>(null);
  const [matcherChannel, setMatcherChannel] = useState<Channel | null>(null);
  const [guideNowMs, setGuideNowMs] = useState(() => Date.now());
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const playerShellRef = useRef<HTMLDivElement>(null);
  const playerSurfaceRef = useRef<HTMLDivElement>(null);
  const channelGuideBodyRef = useRef<HTMLDivElement | null>(null);
  const channelScrollPositionRef = useRef({ key: "", top: 0 });
  const channelScrollPositionKeyRef = useRef("");
  const startupRestoreStateRef = useRef(createStartupSourceRestoreState());
  const startupPlaybackRestoreKeyRef = useRef<string | null>(null);
  const startupPlaybackRestoreCompletedRef = useRef(false);
  const startupPlaybackSessionRef = useRef<PlaybackSession | null>(null);
  const startupPlaybackRestoreGenerationRef = useRef(0);
  const fullscreenStateRevisionRef = useRef(0);
  const fullscreenHostOperationsRef = useRef(new LatestPlaybackOperationCoordinator());

  const selectedChannelIdRef = useRef<string | null>(selectedChannelId);
  const hydratedPlaylistSnapshotAppliedRef = useRef(false);
  const selectionChangedBeforeHydrationRef = useRef(false);
  const hydratedVolumeAppliedRef = useRef(false);
  const savedSourcesRef = useRef(savedSources);
  const activeSourceIdRef = useRef(activeSourceId);
  const sourceOperationsRef = useRef(createSourceOperationCoordinator({
    cancelRemote: cancelPlaylistOperation,
  }));
  const sourceMutationsRef = useRef(createSourceMutationCoordinator<SavedPlaylistSource>());
  const sourceRevisionsRef = useRef(createSourceRevisionTracker());
  const persistenceNoticeShownRef = useRef(false);
  useEffect(() => () => {
    sourceOperationsRef.current.cancelCurrent();
  }, []);
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
    autoResumeModeHydrated &&
    playlistSnapshotHydrated &&
    playlistSelectionHydrated;
  const hasHydratedPlaybackState =
    savedSourcesHydrated &&
    activeSourceIdHydrated &&
    activeSourceSecretHydrated &&
    playbackSessionHydrated &&
    savedVolumeHydrated &&
    autoResumeModeHydrated &&
    playlistSnapshotHydrated &&
    playlistSelectionHydrated;
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
  const {
    player,
    playChannel,
    playMedia,
    setVolumeLevel,
    stopPlayback,
    toggleMute,
    togglePause,
    seekRelative,
    seekAbsolute,
    setSubtitleTrack,
  } = useMpvPlayer(playerSurfaceRef, isFullscreen ? "fullscreen" : "windowed", savedVolume);

  useEffect(() => {
    selectedChannelIdRef.current = selectedChannelId;
    if (!hydratedPlaylistSnapshotAppliedRef.current && selectedChannelId !== null) {
      selectionChangedBeforeHydrationRef.current = true;
    }
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
      playlistSelectionMetadata,
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
    playlistSelectionMetadata,
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

  useEffect(() => {
    if (playlistSnapshotPersistenceFailed || playlistSelectionPersistenceFailed) {
      setMessage("Playlist changes could not be saved. They may be lost when the app closes.");
    }
  }, [playlistSelectionPersistenceFailed, playlistSnapshotPersistenceFailed]);

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
    setActiveSourceSecretHydrated(false);
    const pendingReads = Object.values(savedSources).map((source) => ({
      sourceId: source.id,
      kind: source.kind,
      expectedFingerprint: getSourceSecretHydrationFingerprint(source),
      read: source.kind === "m3u_url" ? loadM3uUrl(source.id) : loadXtreamPassword(source.id),
    }));
    const activePending = pendingReads.find((pending) => pending.sourceId === activeSourceId) ?? null;
    const backgroundPending = pendingReads.filter((pending) => pending !== activePending);

    const applySettlements = (settlements: SourceSecretHydrationSettlement[]) => {
      if (settlements.length === 0) return;
      const hydration = hydrateSourceSecrets(savedSourcesRef.current, settlements);
      setSavedSources((currentSources) => hydrateSourceSecrets(currentSources, settlements).sources);
      if (hydration.message) setMessage((currentMessage) => currentMessage ?? hydration.message);
    };

    const settleReads = async (reads: typeof pendingReads) => {
      const results = await Promise.allSettled(reads.map((pending) => pending.read));
      return reads.map((pending, index): SourceSecretHydrationSettlement => ({
        sourceId: pending.sourceId,
        kind: pending.kind,
        expectedFingerprint: pending.expectedFingerprint,
        result: results[index],
      }));
    };
    const activeSettlementsPromise = settleReads(activePending ? [activePending] : []);
    const backgroundSettlementsPromise = settleReads(backgroundPending);

    void (async () => {
      try {
        if (activePending) {
          const activeSettlements = await activeSettlementsPromise;
          if (cancelled) return;
          applySettlements(activeSettlements);
        }
        if (cancelled) return;
        setActiveSourceSecretHydrated(true);

        const backgroundSettlements = await backgroundSettlementsPromise;
        if (cancelled) return;
        applySettlements(backgroundSettlements);
      } finally {
        if (!cancelled) {
          setActiveSourceSecretHydrated(true);
          setSavedSourceSecretsHydrated(true);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [activeSourceId, savedSourcesHydrated, setSavedSources, secretSourceIdsKey]);

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
    if (
      epgMappingMigrationReadyRef.current ||
      !canRunEpgMappingMigration({
        epgSourcesHydrated,
        epgSecretsHydrated,
        savedEpgMappingsHydrated,
      })
    ) {
      return;
    }
    setSavedEpgMappings((currentMappings) => {
      const migratedMappings = migrateSavedEpgMappings(currentMappings, epgSourcesRef.current);
      epgMappingMigrationReadyRef.current = true;
      return migratedMappings;
    });
  }, [epgSecretsHydrated, epgSourcesHydrated, savedEpgMappingsHydrated, setSavedEpgMappings]);


  useEffect(() => {
    if (
      !playlistSnapshotHydrated ||
      !playlistSelectionHydrated ||
      hydratedPlaylistSnapshotAppliedRef.current
    ) {
      return;
    }

    hydratedPlaylistSnapshotAppliedRef.current = true;

    if (!playlistSnapshot) {
      if (playlistSelection !== null) setPlaylistSelection(null);
      return;
    }

    const resolvedSelection = resolvePlaylistSelectionHydration(
      playlistSnapshot,
      playlistSelection,
      selectionChangedBeforeHydrationRef.current,
      selectedChannelIdRef.current,
    );
    const sanitizedCache = sanitizePlaylistCacheSnapshot(playlistSnapshot);

    if ("legacySelectedChannelId" in playlistSnapshot) {
      setPlaylistSnapshot(sanitizedCache);
    }
    if (
      playlistSelection?.cacheId !== resolvedSelection.selectionState.cacheId ||
      playlistSelection.sourceId !== resolvedSelection.selectionState.sourceId ||
      playlistSelection.selectedChannelId !== resolvedSelection.selectionState.selectedChannelId
    ) {
      setPlaylistSelection(resolvedSelection.selectionState);
    }

    startTransition(() => {
      setPlaylist(sanitizedCache.playlist);
      setSelectedChannelId(resolvedSelection.selectedChannelId);
    });
  }, [
    playlistSelection,
    playlistSelectionHydrated,
    playlistSnapshot,
    playlistSnapshotHydrated,
    setPlaylistSelection,
    setPlaylistSnapshot,
  ]);

  useEffect(() => {
    let cancelled = false;
    const fullscreenRevision = fullscreenStateRevisionRef.current;

    if (isTauri()) {
      void getCurrentWindow()
        .isFullscreen()
        .then((fullscreen) => {
          if (!cancelled && fullscreenStateRevisionRef.current === fullscreenRevision) {
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
      if (activeVodPlayback) {
        void handleStopVod();
      } else {
        void handleToggleFullscreen();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeVodPlayback, isFullscreen]);


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
  }, [isFullscreen]);

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
      createPlaylistPersistenceCoordinator(setPlaylistSnapshot, setPlaylistSelection).replace(
        createPlaylistCacheSnapshot(nextSourceId, importedPlaylist),
        nextSelectedChannelId,
      );
      setActiveSourceId(nextSourceId);
      setPlaylist(importedPlaylist);
      setSelectedChannelId(nextSelectedChannelId);
      setActiveGroup(ALL_CHANNELS_GROUP_ID);
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
    if (!playlistSnapshot || !playlist) {
      return;
    }

    createPlaylistPersistenceCoordinator(setPlaylistSnapshot, setPlaylistSelection)
      .select(playlistSnapshot, channelId);
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
      const { fileName, playlistText } = await downloadPlaylistFromUrl(
        source.url,
        token.operationId,
        token.signal,
      );
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
        token.operationId,
      );
    }

    if (!canCommitSourceOperation(token)) return false;
    const currentSnapshot = importedReferencesRef.current.playlistSnapshot;
    return applyImportedPlaylist(importedPlaylist, token, {
      sourceId: source.id,
      preferredChannelId:
        currentSnapshot?.sourceId === source.id
          ? selectedChannelIdRef.current
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
    cachedStartupSnapshot !== null && shouldRefreshPlaylistCache(cachedStartupSnapshot);
  const cachedStartupResumeChannel = playbackSession.resumeChannelId === null
    ? null
    : cachedStartupSnapshot?.playlist.channels.find(
        (channel) => channel.id === playbackSession.resumeChannelId,
      ) ?? null;
  const cachedStartupResumeChannelPlaybackReady =
    cachedStartupResumeChannel !== null && isChannelPlaybackReady(cachedStartupResumeChannel);
  const startupResumeReadiness = resolveStartupResumeReadiness(
    playbackSession.resumeSourceId,
    cachedStartupResumeChannelPlaybackReady,
    startupSourceRefreshResultRef.current,
  );
  const shouldDelayResumeForStartupRestore =
    playbackSession.shouldResume &&
    playbackSession.resumeSourceId === activeSourceId &&
    startupSourceToRestore !== null &&
    startupResumeReadiness === "wait-for-refresh";

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
    cancelStartupPlaybackRestore();
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
    const selectedGroupIsAlreadyVisible =
      activeGroup === ALL_CHANNELS_GROUP_ID ||
      (activeGroup === FAVORITES_GROUP_ID && Boolean(selectedChannel && favoriteIdSet.has(selectedChannel.id))) ||
      (Boolean(selectedChannel?.group) && activeGroup === selectedChannel?.group);
    if (!selectedGroupIsAlreadyVisible) {
      setActiveGroup(
        selectedChannel && favoriteIdSet.has(selectedChannel.id)
          ? FAVORITES_GROUP_ID
          : selectedChannel?.group && enabledGroupSet.has(selectedChannel.group)
          ? selectedChannel.group
          : ALL_CHANNELS_GROUP_ID,
      );
    }
    setSearchQuery("");
  }

  async function playCanonicalChannel(channel: Channel, isCurrent?: () => boolean) {
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
      return await playChannel(materializedChannel, isCurrent);
    } catch (error) {
      setMessage(redactCredentials(
        error instanceof Error ? error.message : "The channel could not be prepared for playback.",
      ));
      return false;
    }
  }

  function cancelStartupPlaybackRestore() {
    startupPlaybackRestoreGenerationRef.current += 1;
    startupPlaybackRestoreCompletedRef.current = true;
  }

  async function applyHostFullscreenForRevision(nextFullscreen: boolean, fullscreenRevision: number) {
    const isCurrent = () => fullscreenStateRevisionRef.current === fullscreenRevision;
    const operation = fullscreenHostOperationsRef.current.begin(isCurrent);
    const result = await fullscreenHostOperationsRef.current.run(operation, async () => {
      if (isTauri()) {
        const appWindow = getCurrentWindow();
        if ((await appWindow.isFullscreen()) !== nextFullscreen) {
          await appWindow.setFullscreen(nextFullscreen);
        }
      } else if (!nextFullscreen && document.fullscreenElement) {
        await document.exitFullscreen();
      }
      return true;
    });
    return result === true;
  }

  async function handleSelectChannel(channel: Channel) {
    cancelStartupPlaybackRestore();
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

    const didStartPlayback = await playCanonicalChannel(channel);

    setPlaybackSession((currentSession) => ({
      ...currentSession,
      sourceId: activeSourceId,
      channelId: channel.id,
      shouldResume: didStartPlayback,
      resumeSourceId: didStartPlayback ? activeSourceId : null,
      resumeChannelId: didStartPlayback ? channel.id : null,
      resumeInFullscreen: autoResumeMode === "fullscreen",
    }));
  }

  async function handleStopPlayback() {
    cancelStartupPlaybackRestore();
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

  async function handleSelectSection(section: "live" | "movies" | "series") {
    if (section === activeSection) return;
    cancelStartupPlaybackRestore();
    if (!player.idleActive) await stopPlayback();
    setActiveVodPlayback(null);
    setActiveSection(section);
    if (section !== "live") {
      setVisitedVodSections((current) => ({ ...current, [section]: true }));
    }
  }

  async function handlePlayVod(item: VodPlaybackItem) {
    cancelStartupPlaybackRestore();
    const fullscreenRevision = ++fullscreenStateRevisionRef.current;
    const isCurrentPlayback = () => fullscreenStateRevisionRef.current === fullscreenRevision;
    setActiveVodPlayback(item);
    setIsFullscreen(true);

    try {
      if (!(await applyHostFullscreenForRevision(true, fullscreenRevision))) return;

      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
      });
      if (!isCurrentPlayback()) return;
      schedulePlayerLayoutSync();

      const started = await playMedia({
        id: item.id,
        kind: "vod",
        name: item.title,
        stream: item.stream,
        isPlayable: true,
      }, isCurrentPlayback);
      if (!isCurrentPlayback()) return;
      if (!started) await handleStopVod();
    } catch {
      if (!isCurrentPlayback()) return;
      setMessage("Fullscreen VOD playback could not be started.");
      await handleStopVod();
    }
  }

  async function handleStopVod() {
    const fullscreenRevision = ++fullscreenStateRevisionRef.current;
    const fullscreenExit = applyHostFullscreenForRevision(false, fullscreenRevision);
    await stopPlayback();
    try {
      await fullscreenExit;
    } catch {
      // Playback still stops even if the host refuses the fullscreen transition.
    }
    commitIfCurrentPlaybackRevision(
      fullscreenRevision,
      () => fullscreenStateRevisionRef.current,
      () => {
        setIsFullscreen(false);
        setActiveVodPlayback(null);
        schedulePlayerLayoutSync();
      },
    );
  }

  async function handleReloadPlayback() {
    cancelStartupPlaybackRestore();
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
    cancelStartupPlaybackRestore();
    const fullscreenRevision = ++fullscreenStateRevisionRef.current;
    try {
      if (!isFullscreen && channelGuideBodyRef.current) {
        channelScrollPositionRef.current = {
          key: channelScrollPositionKeyRef.current,
          top: channelGuideBodyRef.current.scrollTop,
        };
      }
      if (isTauri()) {
        const appWindow = getCurrentWindow();
        const nextFullscreen = !(await appWindow.isFullscreen());

        await appWindow.setFullscreen(nextFullscreen);
        if (nextFullscreen && player.playbackMode !== "vod" && selectedChannel?.isPlayable) {
          setPlaybackSession((currentSession) => ({
            ...currentSession,
            sourceId: activeSourceId,
            channelId: selectedChannel.id,
            shouldResume: true,
            resumeSourceId: activeSourceId,
            resumeChannelId: selectedChannel.id,
            resumeInFullscreen: autoResumeMode === "fullscreen",
          }));
        }
        if (!nextFullscreen) {
          showSelectedChannelGroup();
        }
        if (fullscreenStateRevisionRef.current === fullscreenRevision) {
          setIsFullscreen(nextFullscreen);
        }
        schedulePlayerLayoutSync();
        return;
      }

      if (!playerShellRef.current) {
        return;
      }

      if (document.fullscreenElement) {
        await document.exitFullscreen();
        showSelectedChannelGroup();
        if (fullscreenStateRevisionRef.current === fullscreenRevision) {
          setIsFullscreen(false);
        }
        schedulePlayerLayoutSync();
        return;
      }

      await playerShellRef.current.requestFullscreen();
      if (player.playbackMode !== "vod" && selectedChannel?.isPlayable) {
        setPlaybackSession((currentSession) => ({
          ...currentSession,
          sourceId: activeSourceId,
          channelId: selectedChannel.id,
          shouldResume: true,
          resumeSourceId: activeSourceId,
          resumeChannelId: selectedChannel.id,
          resumeInFullscreen: autoResumeMode === "fullscreen",
        }));
      }
      if (fullscreenStateRevisionRef.current === fullscreenRevision) {
        setIsFullscreen(true);
      }
      schedulePlayerLayoutSync();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Fullscreen mode could not be changed.";
      setMessage(errorMessage);
    }
  }

  async function handleLoadSavedSource(sourceId: string) {
    cancelStartupPlaybackRestore();
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
    sourceMutationsRef.current.begin(newSource.id, newSource);
    setSavedSources((currentSources) => ({
      ...currentSources,
      [newSource.id]: newSource,
    }));
  }

  function handleAddXtreamProfile() {
    const newSource = createXtreamSource();
    sourceMutationsRef.current.begin(newSource.id, newSource);
    setSavedSources((currentSources) => ({
      ...currentSources,
      [newSource.id]: newSource,
    }));
  }

  function handleToggleSourceEnabled(sourceId: string) {
    const source = savedSourcesRef.current[sourceId];
    if (!source) return;
    const mutation = sourceMutationsRef.current.begin(sourceId, source);
    sourceOperationsRef.current.invalidateSource(sourceId);
    sourceRevisionsRef.current.bump(sourceId);
    startupSourceRefreshResultRef.current = source.enabled
      ? "failed"
      : "pending";
    setStartupRestoreToken((currentToken) =>
      currentToken?.sourceId === sourceId ? null : currentToken,
    );
    setSourceBusy((currentBusy) => currentBusy?.sourceId === sourceId ? null : currentBusy);
    setSavedSources((currentSources) => {
      const currentSource = currentSources[sourceId];
      if (!sourceMutationsRef.current.canCommit(mutation, currentSource)) return currentSources;
      return {
        ...currentSources,
        [sourceId]: updateSourceProfile(currentSource, {
          enabled: !currentSource.enabled,
        }),
      };
    });
  }

  async function handleUpdateSource(sourceId: string, patch: Partial<SavedPlaylistSource>) {
    const source = savedSourcesRef.current[sourceId];
    if (!source) return;
    const mutation = sourceMutationsRef.current.begin(sourceId, source);
    sourceOperationsRef.current.invalidateSource(sourceId);

    const commitUpdate = () => {
      if (!sourceMutationsRef.current.canCommit(mutation, savedSourcesRef.current[sourceId])) {
        return;
      }
      sourceRevisionsRef.current.bump(sourceId);
      startupSourceRefreshResultRef.current = "pending";
      setStartupRestoreToken((currentToken) =>
        currentToken?.sourceId === sourceId ? null : currentToken,
      );
      setSourceBusy((currentBusy) => currentBusy?.sourceId === sourceId ? null : currentBusy);
      setSavedSources((currentSources) => {
        const currentSource = currentSources[sourceId];
        if (!sourceMutationsRef.current.canCommit(mutation, currentSource)) return currentSources;
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
        if (sourceMutationsRef.current.canCommit(mutation, savedSourcesRef.current[sourceId])) {
          setMessage(
            error instanceof Error
              ? error.message
              : "The saved source credential could not be removed. Existing saved data was kept.",
          );
        }
      }
      return;
    }

    const replacesXtreamPassword =
      source.kind === "xtream" &&
      "password" in patch &&
      typeof patch.password === "string" &&
      patch.password.length > 0 &&
      patch.password !== source.password;

    if (replacesXtreamPassword) {
      try {
        await saveXtreamPasswordBeforeCommit(source.id, patch.password as string, commitUpdate);
      } catch (error) {
        if (sourceMutationsRef.current.canCommit(mutation, savedSourcesRef.current[sourceId])) {
          setMessage(
            error instanceof Error
              ? error.message
              : "Saved source changes could not be secured. Existing saved data was kept.",
          );
        }
      }
      return;
    }

    commitUpdate();
  }

  async function handleRemoveSource(sourceId: string) {
    const source = savedSourcesRef.current[sourceId];

    if (!source) {
      return;
    }

    const mutation = sourceMutationsRef.current.begin(sourceId, source);
    sourceOperationsRef.current.invalidateSource(sourceId);
    try {
      await deleteSourceSecretBeforeCommit(source, () => undefined);
    } catch (error) {
      if (sourceMutationsRef.current.canCommit(mutation, savedSourcesRef.current[sourceId])) {
        setMessage(
          error instanceof Error
            ? error.message
            : "The saved source credential could not be removed. Existing saved data was kept.",
        );
      }
      return;
    }

    if (!sourceMutationsRef.current.canCommit(mutation, savedSourcesRef.current[sourceId])) {
      return;
    }

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

    const removed = sourceMutationsRef.current.commit(
      mutation,
      savedSourcesRef.current[sourceId],
      () => {
        const nextSources = { ...savedSourcesRef.current };
        delete nextSources[sourceId];
        savedSourcesRef.current = nextSources;
        setSavedSources(nextSources);
      },
    );
    if (!removed) {
      return;
    }

    sourceRevisionsRef.current.bump(sourceId);
    startupSourceRefreshResultRef.current = "failed";
    setStartupRestoreToken((currentToken) =>
      currentToken?.sourceId === sourceId ? null : currentToken,
    );
    setSourceBusy((currentBusy) => currentBusy?.sourceId === sourceId ? null : currentBusy);

    setSourceLibraryIndex((currentIndex) => {
      const nextIndex = { ...currentIndex };
      delete nextIndex[sourceId];
      return nextIndex;
    });
    setHiddenVodCategoriesBySource((currentStore) =>
      removeVodCategoryVisibilitySource(currentStore, sourceId),
    );
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
      createPlaylistPersistenceCoordinator(setPlaylistSnapshot, setPlaylistSelection).clear();
      setGuideProgrammesByChannelKey({});
      setMatcherChannel(null);

      startTransition(() => {
        setPlaylist(null);
        setSelectedChannelId(null);
        setActiveGroup(null);
        setSearchQuery("");
      });
    }

    setMessage(`Removed ${sourceLabel} and cleared its saved data.`);
  }

  function openSettings(tab: SettingsTab) {
    setIsUserGuideOpen(false);
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
    if (!previousSource || patch.url !== undefined) return;

    invalidateEpgSourceOperation(sourceId);
    setEpgSources((currentSources) => currentSources.map((source) =>
      source.id === sourceId ? updateEpgSource(source, patch) : source,
    ));
  }

  async function handleApplyEpgSourceUrl(sourceId: string, draft: string) {
    if (!epgSourcesRef.current.some((source) => source.id === sourceId)) return false;
    try {
      return await applyEpgUrlDraft(sourceId, draft, (url) => {
        invalidateEpgSourceOperation(sourceId);
        setEpgSources((currentSources) => currentSources.map((source) =>
          source.id === sourceId ? updateEpgSource(source, { url }) : source,
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
      });
    } catch (error) {
      setMessage(error instanceof Error
        ? error.message
        : "EPG URL changes could not be secured. Existing saved data was kept.");
      return false;
    }
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
  const readyXtreamSources = useMemo(
    () => savedSourcesList.filter(
      (source): source is SavedXtreamSource => source.kind === "xtream" && isSourceProfileReady(source),
    ),
    [savedSourcesList],
  );
  const preferredVodSourceId = readyXtreamSources.some((source) => source.id === activeSourceId)
    ? activeSourceId
    : readyXtreamSources[0]?.id ?? null;
  const updateVodNavigation = useCallback((kind: VodKind, patch: Partial<VodNavigationState>) => {
    setVodNavigationByKind((current) => ({
      ...current,
      [kind]: { ...current[kind], ...patch },
    }));
  }, []);
  const getConfiguredHiddenVodCategoryIds = useCallback(
    (sourceId: string, kind: VodKind) =>
      getHiddenVodCategoryIds(hiddenVodCategoriesBySource, sourceId, kind),
    [hiddenVodCategoriesBySource],
  );
  const handleChangeHiddenVodCategoryIds = useCallback(
    (sourceId: string, kind: VodKind, ids: string[]) => {
      setHiddenVodCategoriesBySource((currentStore) =>
        updateHiddenVodCategoryIds(currentStore, sourceId, kind, ids),
      );
    },
    [setHiddenVodCategoriesBySource],
  );
  const movieHiddenCategoryIds = getHiddenVodCategoryIds(
    hiddenVodCategoriesBySource,
    vodNavigationByKind.movie.sourceId,
    "movie",
  );
  const seriesHiddenCategoryIds = getHiddenVodCategoryIds(
    hiddenVodCategoriesBySource,
    vodNavigationByKind.series.sourceId,
    "series",
  );
  const visibleMovieNavigation = useMemo(() => {
    const hidden = new Set(movieHiddenCategoryIds);
    return {
      ...vodNavigationByKind.movie,
      categories: vodNavigationByKind.movie.categories.filter((category) => !hidden.has(category.id)),
    };
  }, [movieHiddenCategoryIds, vodNavigationByKind.movie]);
  const visibleSeriesNavigation = useMemo(() => {
    const hidden = new Set(seriesHiddenCategoryIds);
    return {
      ...vodNavigationByKind.series,
      categories: vodNavigationByKind.series.categories.filter((category) => !hidden.has(category.id)),
    };
  }, [seriesHiddenCategoryIds, vodNavigationByKind.series]);
  const activeVodNavigation = activeSection === "movies"
    ? visibleMovieNavigation
    : activeSection === "series"
      ? visibleSeriesNavigation
      : null;
  const activeVodSourceName = activeVodNavigation?.sourceId
    ? readyXtreamSources.find((source) => source.id === activeVodNavigation.sourceId)?.name ?? null
    : null;

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
    setActiveGroup(ALL_CHANNELS_GROUP_ID);
  }

  function handleSelectGroup(group: string) {
    setActiveGroup(group);
  }

  function handleSelectFavoritesGroup() {
    setActiveGroup(FAVORITES_GROUP_ID);
  }

  const visibleChannels = useMemo(() => {
    const baseList = normalizedSearchQuery.length > 0
        ? enabledChannels
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
      normalizedSearchQuery.length === 0 &&
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
    activeGroup,
    favoriteChannels,
    enabledChannels,
    enabledGroupSet,
    channels,
    normalizedSearchQuery,
  ]);

  useEffect(() => {
    setChannelRenderLimit(CHANNEL_RENDER_INITIAL_LIMIT);
  }, [activeGroup, normalizedSearchQuery, playlist?.importedAt]);

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
  const channelScrollPositionKey = `${playlist?.importedAt ?? ""}\u0001${
    activeGroup ?? ""
  }\u0001${normalizedSearchQuery}`;
  channelScrollPositionKeyRef.current = channelScrollPositionKey;
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
  const activeGroupLabel = normalizedSearchQuery.length > 0
      ? "Search results"
      : activeGroup === FAVORITES_GROUP_ID
      ? "Favorites"
      : activeGroup === ALL_CHANNELS_GROUP_ID
      ? "All channels"
      : activeGroup;
  const isFavoritesGroupActive = activeGroup === FAVORITES_GROUP_ID;
  const isAllChannelsGroupActive = activeGroup === ALL_CHANNELS_GROUP_ID;

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
      const startupKey = getEpgStartupIdentity(source);

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
        .map(getEpgAutoUpdateIdentity)
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
    if (startupPlaybackRestoreCompletedRef.current) return;

    const startupPlaybackSession = startupPlaybackSessionRef.current;
    const waitingForRequiredRefresh =
      shouldDelayResumeForStartupRestore ||
      (isRestoringStartupSource && !cachedStartupResumeChannelPlaybackReady);

    if (!hasHydratedPlaybackState || waitingForRequiredRefresh) return;
    if (!playlist || player.environment !== "tauri" || !player.ready) return;

    const resumeSourceId = startupPlaybackSession?.resumeSourceId ?? null;
    const resumeChannelId = startupPlaybackSession?.resumeChannelId ?? null;

    if (resumeChannelId === null || !startupPlaybackSession?.shouldResume || resumeSourceId !== activeSourceId) {
      startupPlaybackRestoreCompletedRef.current = true;
      return;
    }

    const resumeReadiness = resolveStartupResumeReadiness(
      resumeSourceId,
      cachedStartupResumeChannelPlaybackReady,
      startupSourceRefreshResultRef.current,
    );
    if (resumeReadiness !== "ready") {
      setPlaybackSession((currentSession) => ({
        ...currentSession,
        shouldResume: false,
        resumeSourceId: null,
        resumeChannelId: null,
        resumeInFullscreen: false,
      }));
      if (cachedStartupPlaylistNeedsRefresh || !cachedStartupResumeChannelPlaybackReady) {
        setMessage((currentMessage) => currentMessage ??
          "Cached source metadata is available for browsing, but refresh is required before playback.");
      }
      startupPlaybackRestoreCompletedRef.current = true;
      return;
    }

    const channelToResume = channelsById.get(resumeChannelId) ?? null;
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

    const restoreKey = `${activeSourceId ?? "local"}\u0001${playlist.importedAt}\u0001${resumeChannelId}`;
    if (startupPlaybackRestoreKeyRef.current === restoreKey) {
      startupPlaybackRestoreCompletedRef.current = true;
      return;
    }

    const restoreGeneration = ++startupPlaybackRestoreGenerationRef.current;
    startupPlaybackRestoreKeyRef.current = restoreKey;
    startupPlaybackRestoreCompletedRef.current = true;
    setSelectedChannelId(channelToResume.id);
    persistSelectedChannel(channelToResume.id);
    setRecentIds((currentIds) => pushRecentId(currentIds, channelToResume.id));

    const resumePlayback = async () => {
      const isCurrentRestore = () =>
        startupPlaybackRestoreGenerationRef.current === restoreGeneration;
      const shouldUseFullscreen = autoResumeMode === "fullscreen";
      const fullscreenRevision = ++fullscreenStateRevisionRef.current;
      try {
        const appWindow = getCurrentWindow();
        const currentFullscreen = await appWindow.isFullscreen();
        if (!isCurrentRestore()) return;
        if (currentFullscreen !== shouldUseFullscreen) {
          await appWindow.setFullscreen(shouldUseFullscreen);
          if (!isCurrentRestore()) return;
        }
        if (fullscreenStateRevisionRef.current === fullscreenRevision) {
          setIsFullscreen(shouldUseFullscreen);
        }
        schedulePlayerLayoutSync();
      } catch {
        if (isCurrentRestore()) {
          setMessage((currentMessage) => currentMessage ??
            "Playback resumed, but the saved startup player mode could not be applied.");
        }
      }

      if (!isCurrentRestore()) return;
      const didStartPlayback = await playCanonicalChannel(channelToResume, isCurrentRestore);
      if (!isCurrentRestore()) return;
      setPlaybackSession((currentSession) =>
        (currentSession.resumeSourceId ?? null) === activeSourceId &&
        (currentSession.resumeChannelId ?? null) === channelToResume.id
          ? {
              ...currentSession,
              shouldResume: didStartPlayback,
              resumeInFullscreen: autoResumeMode === "fullscreen",
            }
          : currentSession,
      );
    };

    void resumePlayback();
  }, [
    activeSourceId,
    autoResumeMode,
    cachedStartupPlaylistNeedsRefresh,
    cachedStartupResumeChannelPlaybackReady,
    channelsById,
    hasHydratedPlaybackState,
    isRestoringStartupSource,
    player.environment,
    player.ready,
    playlist,
    setPlaybackSession,
    setRecentIds,
    shouldDelayResumeForStartupRestore,
  ]);

  const vodPlayerPanel = activeVodPlayback ? (
    <VodPlayerPanel
      player={player}
      media={activeVodPlayback}
      isFullscreen={isFullscreen}
      playerShellRef={playerShellRef}
      playerSurfaceRef={playerSurfaceRef}
      onTogglePause={() => { void togglePause(); }}
      onSeekRelative={(seconds) => { void seekRelative(seconds); }}
      onSeekAbsolute={(seconds) => { void seekAbsolute(seconds); }}
      onSelectSubtitle={(trackId) => { void setSubtitleTrack(trackId); }}
      onToggleMute={() => { void toggleMute(); }}
      onSetVolume={(volume) => {
        const nextVolume = Math.max(0, Math.min(100, Math.round(volume)));
        setSavedVolume(nextVolume);
        void setVolumeLevel(nextVolume);
      }}
      onQuit={() => { void handleStopVod(); }}
    />
  ) : null;

  if (!hasHydratedPlaybackState) {
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
        activeVodPlayback ? vodPlayerPanel : (
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
        )
      ) : null}
      {(!isFullscreen || activeVodPlayback) ? (
        <div
          className={`workspace workspace--persistent-sidebar ${isFullscreen ? "workspace--fullscreen-background" : ""}`}
          aria-hidden={isFullscreen}
        >
          <div className="workspace__sidebar workspace__sidebar--visible workspace__sidebar--persistent">
            <ChannelSidebar
              activeSection={activeSection}
              playlistName={playlistDisplayName}
              enabledGroups={enabledGroups}
              isAllChannelsActive={isAllChannelsGroupActive}
              isFavoritesActive={isFavoritesGroupActive}
              activeGroup={activeGroup}
              favoritesCount={favoritesCount}
              allChannelCount={enabledChannels.length}
              channelCountByGroup={channelCountByGroup}
              searchQuery={searchQuery}
              message={message}
              vodNavigation={activeVodNavigation}
              vodSourceName={activeVodSourceName}
              onSearchChange={setSearchQuery}
              onSelectAllChannels={handleSelectAllChannels}
              onSelectFavorites={handleSelectFavoritesGroup}
              onSelectGroup={handleSelectGroup}
              onSelectSection={(section) => { void handleSelectSection(section); }}
              onVodSearchChange={(value) => {
                if (activeSection === "movies") updateVodNavigation("movie", { searchQuery: value });
                if (activeSection === "series") updateVodNavigation("series", { searchQuery: value });
              }}
              onSelectVodCategory={(categoryId) => {
                if (activeSection === "movies") updateVodNavigation("movie", { activeCategoryId: categoryId });
                if (activeSection === "series") updateVodNavigation("series", { activeCategoryId: categoryId });
              }}
              onOpenUserGuide={() => {
                setIsSettingsOpen(false);
                setIsUserGuideOpen(true);
              }}
              onOpenSettings={() => {
                openSettings("general");
              }}
            />
          </div>

          <div className="workspace__content">
            {activeSection === "live" ? (
              <ChannelShelf
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
              scrollPositionKey={channelScrollPositionKey}
              scrollPositionRef={channelScrollPositionRef}
              guideBodyRef={channelGuideBodyRef}
              onSelectChannel={(channel) => {
                void handleSelectChannel(channel);
              }}
              onToggleFavorite={handleToggleFavorite}
              onOpenEpgMatcher={handleOpenEpgMatcher}
              onLoadMoreChannels={handleLoadMoreVisibleChannels}
            />
            ) : null}
            {visitedVodSections.movies ? (
              <VodBrowser
                kind="movie"
                sources={readyXtreamSources}
                preferredSourceId={preferredVodSourceId}
                isActive={activeSection === "movies"}
                navigation={vodNavigationByKind.movie}
                hiddenCategoryIds={movieHiddenCategoryIds}
                onNavigationChange={(patch) => updateVodNavigation("movie", patch)}
                onPlay={(item) => { void handlePlayVod(item); }}
              />
            ) : null}
            {visitedVodSections.series ? (
              <VodBrowser
                kind="series"
                sources={readyXtreamSources}
                preferredSourceId={preferredVodSourceId}
                isActive={activeSection === "series"}
                navigation={vodNavigationByKind.series}
                hiddenCategoryIds={seriesHiddenCategoryIds}
                onNavigationChange={(patch) => updateVodNavigation("series", patch)}
                onPlay={(item) => { void handlePlayVod(item); }}
              />
            ) : null}
          </div>
        </div>
      ) : null}

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
        autoResumeMode={autoResumeMode}
        vodSources={readyXtreamSources}
        preferredVodSourceId={preferredVodSourceId}
        onClose={() => setIsSettingsOpen(false)}
        onSelectTab={setSettingsTab}
        onAutoResumeModeChange={setAutoResumeMode}
        onEnableAllGroups={handleEnableAllGroups}
        onDisableAllGroups={handleDisableAllGroups}
        onToggleGroup={handleToggleGroup}
        getHiddenVodCategoryIds={getConfiguredHiddenVodCategoryIds}
        onChangeHiddenVodCategoryIds={handleChangeHiddenVodCategoryIds}
        onAddEpgSource={handleAddEpgSource}
        onToggleEpgSourceEnabled={handleToggleEpgSourceEnabled}
        onRemoveEpgSource={handleRemoveEpgSource}
        onUpdateEpgSource={handleUpdateEpgSource}
        onApplyEpgSourceUrl={handleApplyEpgSourceUrl}
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

      <UserGuideDrawer
        isOpen={isUserGuideOpen}
        onClose={() => setIsUserGuideOpen(false)}
        onOpenSources={() => openSettings("sources")}
        onOpenEpg={() => openSettings("epg")}
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
