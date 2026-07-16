export type VodKind = "movie" | "series";

export interface VodNavigationState {
  sourceId: string | null;
  streamOrigin: string | null;
  categories: VodCategory[];
  activeCategoryId: string | null;
  searchQuery: string;
  loadingCategories: boolean;
  activeCatalogCount: number;
}

export interface VodCategory {
  id: string;
  name: string;
}

export interface VodCategoriesResponse {
  streamOrigin: string;
  categories: VodCategory[];
}

export interface VodCatalogItem {
  id: string;
  title: string;
  categoryId: string;
  cover: string | null;
  plot: string | null;
  rating: number | null;
  year: string | null;
  containerExtension: string | null;
  added: string | null;
}

export interface VodCatalogResponse {
  items: VodCatalogItem[];
  truncated: boolean;
  itemLimit: number;
}

export interface VodEpisode {
  id: string;
  title: string;
  season: number;
  episode: number;
  containerExtension: string;
  plot: string | null;
  durationSecs: number | null;
  cover: string | null;
}

export interface VodSeason {
  number: number;
  name: string;
  cover: string | null;
  episodes: VodEpisode[];
}

export interface VodDetails {
  kind: VodKind;
  id: string;
  title: string;
  plot: string | null;
  cover: string | null;
  backdrop: string | null;
  rating: number | null;
  year: string | null;
  genre: string | null;
  cast: string | null;
  director: string | null;
  durationSecs: number | null;
  containerExtension: string | null;
  seasons: VodSeason[];
}

export interface VodPlaybackItem {
  kind: "movie" | "episode";
  id: string;
  catalogId: string;
  title: string;
  stream: string;
  cover: string | null;
  plot: string | null;
  season: number | null;
  episode: number | null;
}
