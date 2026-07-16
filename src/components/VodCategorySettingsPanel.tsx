import { useEffect, useMemo, useState } from "react";
import type { SavedXtreamSource } from "../domain/sourceProfiles";
import type { VodCategory, VodKind } from "../domain/vod";
import { redactCredentials } from "../features/playlist/redaction";
import {
  cancelVodOperation,
  createVodOperationId,
  fetchVodCategories,
} from "../features/vod/api";

interface VodCategorySettingsPanelProps {
  kind: VodKind;
  sources: SavedXtreamSource[];
  preferredSourceId: string | null;
  getHiddenCategoryIds: (sourceId: string, kind: VodKind) => string[];
  onChangeHiddenCategoryIds: (sourceId: string, kind: VodKind, ids: string[]) => void;
}

export function VodCategorySettingsPanel({
  kind,
  sources,
  preferredSourceId,
  getHiddenCategoryIds,
  onChangeHiddenCategoryIds,
}: VodCategorySettingsPanelProps) {
  const [sourceId, setSourceId] = useState<string | null>(preferredSourceId);
  const [categories, setCategories] = useState<VodCategory[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = sources.find((candidate) => candidate.id === sourceId) ?? sources[0] ?? null;
  const hiddenIds = source ? getHiddenCategoryIds(source.id, kind) : [];
  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCategories = categories.filter((category) =>
    category.name.toLowerCase().includes(normalizedQuery),
  );

  useEffect(() => {
    if (source && source.id !== sourceId) setSourceId(source.id);
  }, [source, sourceId]);

  useEffect(() => {
    if (!source) {
      setCategories([]);
      return undefined;
    }
    const operationId = createVodOperationId(`${kind}_settings_categories`);
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCategories([]);

    void fetchVodCategories(source, kind, operationId)
      .then((response) => {
        if (!cancelled) setCategories(response.categories);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(redactCredentials(reason instanceof Error ? reason.message : String(reason)));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      void cancelVodOperation(operationId).catch(() => undefined);
    };
  }, [kind, source?.id, source?.updatedAt]);

  if (!source) {
    return (
      <div className="settings-empty">
        <strong>No enabled Xtream source</strong>
        <span>Add and enable an Xtream source before managing on-demand groups.</span>
      </div>
    );
  }

  function setHidden(nextIds: string[]) {
    if (!source) return;
    onChangeHiddenCategoryIds(source.id, kind, nextIds);
  }

  return (
    <>
      <div className="settings-toolbar">
        <div className="settings-toolbar__stats">
          <div className="settings-stat">
            <strong>{categories.length}</strong>
            <span>Total groups</span>
          </div>
          <div className="settings-stat">
            <strong>{categories.filter((category) => !hiddenSet.has(category.id)).length}</strong>
            <span>Visible groups</span>
          </div>
          <div className="settings-stat">
            <strong>{categories.filter((category) => hiddenSet.has(category.id)).length}</strong>
            <span>Hidden groups</span>
          </div>
        </div>
        <label className="vod-source-select settings-vod-source-select">
          <span>Provider</span>
          <select value={source.id} onChange={(event) => setSourceId(event.currentTarget.value)}>
            {sources.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="settings-toolbar settings-toolbar--controls">
        <label className="settings-group-search">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={`Search ${kind === "movie" ? "movie" : "TV show"} groups`}
          />
        </label>
        <div className="settings-toolbar__actions">
          <button type="button" className="control-button" onClick={() => setHidden([])} disabled={loading}>
            Enable all
          </button>
          <button
            type="button"
            className="control-button"
            onClick={() => setHidden(categories.map((category) => category.id))}
            disabled={loading || error !== null || categories.length === 0}
          >
            Disable all
          </button>
        </div>
      </div>

      {loading ? <div className="settings-empty"><strong>Loading groups…</strong></div> : null}
      {error ? <div className="settings-notice">{error}</div> : null}

      <div className="settings-list">
        {!loading && !error && filteredCategories.length === 0 ? (
          <div className="settings-empty">
            <strong>No groups match this search</strong>
            <span>Try a different group name or clear the search box.</span>
          </div>
        ) : null}
        {filteredCategories.map((category) => {
          const enabled = !hiddenSet.has(category.id);
          return (
            <article key={category.id} className="settings-list__item">
              <div className="settings-list__copy">
                <strong>{category.name}</strong>
                <span>{kind === "movie" ? "Movie group" : "TV show group"}</span>
              </div>
              <button
                type="button"
                className={`visibility-toggle ${enabled ? "visibility-toggle--enabled" : ""}`}
                onClick={() => setHidden(
                  enabled
                    ? [...hiddenIds, category.id]
                    : hiddenIds.filter((id) => id !== category.id),
                )}
                aria-label={enabled ? `Hide group ${category.name}` : `Enable group ${category.name}`}
              >
                {enabled ? "Enabled" : "Hidden"}
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
