import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SavedXtreamSource } from "../domain/sourceProfiles";
import type {
  VodCatalogItem,
  VodDetails,
  VodKind,
  VodNavigationState,
  VodPlaybackItem,
} from "../domain/vod";
import { redactCredentials } from "../features/playlist/redaction";
import {
  cancelVodOperation,
  createVodOperationId,
  fetchVodCatalog,
  fetchVodCategories,
  fetchVodDetails,
} from "../features/vod/api";
import { buildXtreamVodStreamUrl, filterVodCatalog } from "../features/vod/model";

interface VodBrowserProps {
  kind: VodKind;
  sources: SavedXtreamSource[];
  preferredSourceId: string | null;
  isActive: boolean;
  navigation: VodNavigationState;
  hiddenCategoryIds: string[];
  onNavigationChange: (patch: Partial<VodNavigationState>) => void;
  onPlay: (item: VodPlaybackItem) => void;
}

const PAGE_SIZE = 72;

function getErrorMessage(error: unknown) {
  return redactCredentials(error instanceof Error ? error.message : String(error));
}

function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function VodBrowser({
  kind,
  sources,
  preferredSourceId,
  isActive,
  navigation,
  hiddenCategoryIds,
  onNavigationChange,
  onPlay,
}: VodBrowserProps) {
  const [sourceId, setSourceId] = useState<string | null>(navigation.sourceId ?? preferredSourceId);
  const [catalog, setCatalog] = useState<VodCatalogItem[]>([]);
  const [renderLimit, setRenderLimit] = useState(PAGE_SIZE);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLimitNotice, setCatalogLimitNotice] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<VodCatalogItem | null>(null);
  const [details, setDetails] = useState<VodDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const deferredQuery = useDeferredValue(navigation.searchQuery);
  const source = sources.find((candidate) => candidate.id === sourceId) ?? sources[0] ?? null;
  const hiddenCategorySet = useMemo(() => new Set(hiddenCategoryIds), [hiddenCategoryIds]);
  const visibleCategories = useMemo(
    () => navigation.categories.filter((category) => !hiddenCategorySet.has(category.id)),
    [hiddenCategorySet, navigation.categories],
  );
  const categoryId = navigation.activeCategoryId;

  useEffect(() => {
    if (source && source.id !== sourceId) setSourceId(source.id);
  }, [source, sourceId]);

  useEffect(() => {
    if (!source) return undefined;
    const categoriesOperationId = createVodOperationId(`${kind}_categories`);
    let cancelled = false;
    onNavigationChange({
      sourceId: source.id,
      streamOrigin: null,
      categories: [],
      activeCategoryId: null,
      searchQuery: "",
      loadingCategories: true,
      activeCatalogCount: 0,
    });
    setCatalogError(null);
    setCatalogLimitNotice(null);
    setCatalog([]);
    setSelectedItem(null);
    setDetails(null);
    setRenderLimit(PAGE_SIZE);

    void fetchVodCategories(source, kind, categoriesOperationId)
      .then((response) => {
        if (cancelled) return;
        const nextCategories = response.categories;
        const nextVisible = nextCategories.filter((category) => !hiddenCategorySet.has(category.id));
        onNavigationChange({
          streamOrigin: response.streamOrigin,
          categories: nextCategories,
          activeCategoryId: nextVisible[0]?.id ?? null,
        });
      })
      .catch((error) => {
        if (!cancelled) setCatalogError(getErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) onNavigationChange({ loadingCategories: false });
      });

    return () => {
      cancelled = true;
      void cancelVodOperation(categoriesOperationId).catch(() => undefined);
    };
  }, [kind, source?.id, source?.updatedAt]);

  useEffect(() => {
    if (categoryId === null || visibleCategories.some((category) => category.id === categoryId)) return;
    onNavigationChange({ activeCategoryId: visibleCategories[0]?.id ?? null, activeCatalogCount: 0 });
  }, [categoryId, visibleCategories]);

  useEffect(() => {
    if (!source || categoryId === null) {
      setCatalog([]);
      setCatalogLimitNotice(null);
      setSelectedItem(null);
      setDetails(null);
      onNavigationChange({ activeCatalogCount: 0 });
      return undefined;
    }
    const operationId = createVodOperationId(`${kind}_catalog`);
    let cancelled = false;
    setLoadingCatalog(true);
    setCatalogError(null);
    setCatalogLimitNotice(null);
    setCatalog([]);
    setSelectedItem(null);
    setDetails(null);
    onNavigationChange({ searchQuery: "", activeCatalogCount: 0 });
    setRenderLimit(PAGE_SIZE);

    void fetchVodCatalog(source, kind, categoryId, operationId)
      .then((response) => {
        if (!cancelled) {
          setCatalog(response.items);
          setCatalogLimitNotice(response.truncated
            ? `This provider category exceeds Onyx's safety limit. Showing the first ${response.itemLimit.toLocaleString()} valid titles.`
            : null);
          onNavigationChange({ activeCatalogCount: response.items.length });
        }
      })
      .catch((error) => {
        if (!cancelled) setCatalogError(getErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalog(false);
      });

    return () => {
      cancelled = true;
      void cancelVodOperation(operationId).catch(() => undefined);
    };
  }, [categoryId, kind, source?.id, source?.updatedAt]);

  useEffect(() => {
    if (!selectedItem || !source) {
      setDetails(null);
      return undefined;
    }
    const operationId = createVodOperationId(`${kind}_details`);
    let cancelled = false;
    setDetailsLoading(true);
    setDetailsError(null);

    void fetchVodDetails(source, kind, selectedItem.id, operationId)
      .then((nextDetails) => {
        if (cancelled) return;
        setDetails(nextDetails);
        setSeasonNumber(nextDetails.seasons[0]?.number ?? null);
      })
      .catch((error) => {
        if (!cancelled) setDetailsError(getErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setDetailsLoading(false);
      });

    return () => {
      cancelled = true;
      void cancelVodOperation(operationId).catch(() => undefined);
    };
  }, [kind, selectedItem?.id, source?.id, source?.updatedAt]);

  const filteredCatalog = useMemo(
    () => filterVodCatalog(catalog, deferredQuery),
    [catalog, deferredQuery],
  );

  useEffect(() => {
    setRenderLimit(PAGE_SIZE);
  }, [categoryId, deferredQuery, kind, source?.id]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || renderLimit >= filteredCatalog.length) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRenderLimit((current) => Math.min(filteredCatalog.length, current + PAGE_SIZE));
      }
    }, { rootMargin: "500px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [filteredCatalog.length, renderLimit, selectedItem]);


  if (!isActive) return null;

  if (!source) {
    return (
      <section className="panel vod-empty-state">
        <span className="sidebar__eyebrow">{kind === "movie" ? "Movies" : "TV Shows"}</span>
        <h1>Add an Xtream source first</h1>
        <p>VOD libraries are available from enabled Xtream providers. Open Settings → Sources to add one.</p>
      </section>
    );
  }

  function playMovie() {
    if (!details || !source || !navigation.streamOrigin) return;
    const extension = details.containerExtension ?? selectedItem?.containerExtension ?? "mp4";
    onPlay({
      kind: "movie",
      id: details.id,
      catalogId: details.id,
      title: details.title,
      stream: buildXtreamVodStreamUrl(source, navigation.streamOrigin, "movie", details.id, extension),
      cover: details.cover,
      plot: details.plot,
      season: null,
      episode: null,
    });
  }

  function playEpisode(episode: VodDetails["seasons"][number]["episodes"][number]) {
    if (!details || !source || !navigation.streamOrigin) return;
    onPlay({
      kind: "episode",
      id: episode.id,
      catalogId: details.id,
      title: `${details.title} — ${episode.title}`,
      stream: buildXtreamVodStreamUrl(
        source,
        navigation.streamOrigin,
        "episode",
        episode.id,
        episode.containerExtension,
      ),
      cover: episode.cover ?? details.cover,
      plot: episode.plot ?? details.plot,
      season: episode.season,
      episode: episode.episode,
    });
  }

  if (selectedItem) {
    const activeSeason = details?.seasons.find((season) => season.number === seasonNumber) ?? null;
    return (
      <section className="vod-details">
        <button type="button" className="control-button vod-back-button" onClick={() => setSelectedItem(null)}>
          ← Back to {kind === "movie" ? "Movies" : "TV Shows"}
        </button>
        <div
          className="panel vod-details__hero"
          style={details?.backdrop ? { backgroundImage: `linear-gradient(90deg, rgba(7, 13, 21, .97), rgba(7, 13, 21, .72)), url("${details.backdrop}")` } : undefined}
        >
          {(details?.cover ?? selectedItem.cover) ? (
            <img className="vod-details__poster" src={details?.cover ?? selectedItem.cover ?? ""} alt="" />
          ) : <div className="vod-details__poster vod-poster-placeholder">{selectedItem.title.slice(0, 1)}</div>}
          <div className="vod-details__copy">
            <span className="sidebar__eyebrow">{kind === "movie" ? "Movie" : "TV Show"}</span>
            <h1>{details?.title ?? selectedItem.title}</h1>
            <div className="vod-meta-row">
              {(details?.year ?? selectedItem.year) ? <span>{details?.year ?? selectedItem.year}</span> : null}
              {(details?.rating ?? selectedItem.rating) ? <span>★ {(details?.rating ?? selectedItem.rating)?.toFixed(1)}</span> : null}
              {formatDuration(details?.durationSecs ?? null) ? <span>{formatDuration(details?.durationSecs ?? null)}</span> : null}
              {details?.genre ? <span>{details.genre}</span> : null}
            </div>
            <p>{details?.plot ?? selectedItem.plot ?? "No description was provided."}</p>
            {details?.director ? <small>Director: {details.director}</small> : null}
            {details?.cast ? <small>Cast: {details.cast}</small> : null}
            {detailsLoading ? <span className="vod-loading-copy">Loading full details…</span> : null}
            {detailsError ? <span className="sidebar__notice">{detailsError}</span> : null}
            {kind === "movie" && details ? (
              <button type="button" className="control-button control-button--primary vod-play-button" onClick={playMovie}>
                ▶ Play Movie
              </button>
            ) : null}
          </div>
        </div>


        {kind === "series" && details ? (
          <div className="panel vod-episodes">
            <div className="vod-season-tabs" role="tablist" aria-label="Seasons">
              {details.seasons.map((season) => (
                <button
                  key={season.number}
                  type="button"
                  role="tab"
                  aria-selected={season.number === seasonNumber}
                  className={`control-button ${season.number === seasonNumber ? "control-button--primary" : ""}`}
                  onClick={() => setSeasonNumber(season.number)}
                >
                  {season.name}
                </button>
              ))}
            </div>
            {activeSeason ? (
              <div className="vod-episode-list">
                {activeSeason.episodes.map((episode) => (
                  <article key={episode.id} className="vod-episode-card">
                    {episode.cover ? (
                      <img src={episode.cover} alt="" loading="lazy" />
                    ) : (
                      <div className="vod-episode-card__placeholder">E{episode.episode}</div>
                    )}
                    <div>
                      <span className="sidebar__eyebrow">Episode {episode.episode}</span>
                      <h3>{episode.title}</h3>
                      <p>{episode.plot ?? "No episode description was provided."}</p>
                      {formatDuration(episode.durationSecs) ? <small>{formatDuration(episode.durationSecs)}</small> : null}
                    </div>
                    <button type="button" className="control-button control-button--primary" onClick={() => playEpisode(episode)}>
                      ▶ Play
                    </button>
                  </article>
                ))}
              </div>
            ) : <div className="empty-state">No episodes were provided for this series.</div>}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="vod-browser">
      <header className="vod-browser__header">
        <div>
          <span className="sidebar__eyebrow">On Demand</span>
          <h1>{kind === "movie" ? "Movies" : "TV Shows"}</h1>
          <p>Loaded only when you open this section, keeping Live TV startup fast.</p>
        </div>
        <label className="vod-source-select">
          <span>Provider</span>
          <select value={source.id} onChange={(event) => setSourceId(event.currentTarget.value)}>
            {sources.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
      </header>

      {navigation.loadingCategories ? <div className="panel vod-empty-state"><strong>Loading groups…</strong><span>Onyx loads one provider category at a time instead of downloading the entire VOD catalog.</span></div> : null}
      {loadingCatalog ? <div className="panel vod-empty-state"><strong>Loading this category…</strong><span>Large categories can take a moment on first open.</span></div> : null}
      {catalogError ? <div className="sidebar__notice">{catalogError}</div> : null}
      {catalogLimitNotice ? <div className="sidebar__notice">{catalogLimitNotice}</div> : null}
      {!navigation.loadingCategories && !loadingCatalog && categoryId !== null && !catalogError && filteredCatalog.length === 0 ? (
        <div className="panel vod-empty-state"><strong>No titles found</strong><span>Try another category or search.</span></div>
      ) : null}

      <div className="vod-grid">
        {filteredCatalog.slice(0, renderLimit).map((item) => (
          <button key={item.id} type="button" className="vod-card" onClick={() => setSelectedItem(item)}>
            <div className="vod-card__poster">
              {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : <span>{item.title.slice(0, 1)}</span>}
              {item.rating !== null ? <span className="vod-card__rating">★ {item.rating.toFixed(1)}</span> : null}
            </div>
            <strong>{item.title}</strong>
            <span>{[item.year, kind === "series" ? "Series" : null].filter(Boolean).join(" • ")}</span>
          </button>
        ))}
      </div>
      <div ref={loadMoreRef} className="vod-load-sentinel">
        {renderLimit < filteredCatalog.length ? `Loading more — ${renderLimit} of ${filteredCatalog.length}` : `${filteredCatalog.length} titles`}
      </div>
    </section>
  );
}
