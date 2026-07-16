use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VodKind {
    Movie,
    Series,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VodCategoryPayload {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VodCategoriesResponse {
    pub stream_origin: String,
    pub categories: Vec<VodCategoryPayload>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VodCatalogItemPayload {
    pub id: String,
    pub title: String,
    pub category_id: String,
    pub cover: Option<String>,
    pub plot: Option<String>,
    pub rating: Option<f64>,
    pub year: Option<String>,
    pub container_extension: Option<String>,
    pub added: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VodCatalogResponse {
    pub items: Vec<VodCatalogItemPayload>,
    pub truncated: bool,
    pub item_limit: usize,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VodEpisodePayload {
    pub id: String,
    pub title: String,
    pub season: u32,
    pub episode: u32,
    pub container_extension: String,
    pub plot: Option<String>,
    pub duration_secs: Option<u64>,
    pub cover: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VodSeasonPayload {
    pub number: u32,
    pub name: String,
    pub cover: Option<String>,
    pub episodes: Vec<VodEpisodePayload>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VodDetailsPayload {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub plot: Option<String>,
    pub cover: Option<String>,
    pub backdrop: Option<String>,
    pub rating: Option<f64>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub cast: Option<String>,
    pub director: Option<String>,
    pub duration_secs: Option<u64>,
    pub container_extension: Option<String>,
    pub seasons: Vec<VodSeasonPayload>,
}

impl VodKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "movie" => Ok(Self::Movie),
            "series" => Ok(Self::Series),
            _ => Err("The VOD section is not valid.".to_string()),
        }
    }

    pub fn categories_action(self) -> &'static str {
        match self {
            Self::Movie => "get_vod_categories",
            Self::Series => "get_series_categories",
        }
    }

    pub fn catalog_action(self) -> &'static str {
        match self {
            Self::Movie => "get_vod_streams",
            Self::Series => "get_series",
        }
    }

    pub fn details_action(self) -> &'static str {
        match self {
            Self::Movie => "get_vod_info",
            Self::Series => "get_series_info",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }
}

fn text(value: Option<&Value>, max_len: usize) -> Option<String> {
    let raw = match value {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => return None,
    };
    if raw.is_empty() {
        return None;
    }
    Some(raw.chars().take(max_len).collect())
}

fn identifier(value: Option<&Value>) -> Option<String> {
    let value = text(value, 100)?;
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        .then_some(value)
}

fn container_extension(value: Option<&Value>) -> Option<String> {
    let value = text(value, 12)?.to_ascii_lowercase();
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric())
        .then_some(value)
}

fn decode_public_path_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return None;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    let decoded = percent_decode_str(segment).decode_utf8().ok()?.into_owned();
    (!decoded.contains(['%', '/', '\\'])).then_some(decoded)
}

fn public_url(value: Option<&Value>) -> Option<String> {
    let candidate = text(value, 2048)?;
    let mut url = reqwest::Url::parse(&candidate).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        url.set_username("").ok()?;
        url.set_password(None).ok()?;
    }
    let path_segments = url
        .path_segments()
        .map(|segments| {
            segments
                .map(decode_public_path_segment)
                .collect::<Option<Vec<_>>>()
        })
        .unwrap_or_else(|| Some(Vec::new()))?;
    if path_segments.windows(4).any(|segments| {
        matches!(
            segments[0].to_ascii_lowercase().as_str(),
            "live" | "movie" | "series"
        )
    }) {
        return None;
    }
    let safe_pairs = url
        .query_pairs()
        .filter(|(key, _)| {
            let normalized_key = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>();
            !matches!(
                normalized_key.as_str(),
                "username"
                    | "user"
                    | "password"
                    | "pass"
                    | "token"
                    | "accesstoken"
                    | "auth"
                    | "key"
                    | "apikey"
                    | "authorization"
                    | "credential"
                    | "credentials"
                    | "secret"
                    | "signature"
                    | "sig"
            )
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    if !safe_pairs.is_empty() {
        url.query_pairs_mut().extend_pairs(safe_pairs);
    }
    Some(url.to_string())
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(value)) => value.as_f64(),
        Some(Value::String(value)) => value.trim().parse().ok(),
        _ => None,
    }
}

fn unsigned(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(value)) => value.as_u64(),
        Some(Value::String(value)) => value.trim().parse().ok(),
        _ => None,
    }
}

fn year(value: &Value) -> Option<String> {
    text(
        value
            .get("year")
            .or_else(|| value.get("releaseDate"))
            .or_else(|| value.get("releasedate")),
        40,
    )
    .and_then(|value| {
        let digits = value
            .chars()
            .filter(char::is_ascii_digit)
            .take(4)
            .collect::<String>();
        (digits.len() == 4).then_some(digits)
    })
}

fn duration_secs(value: &Value) -> Option<u64> {
    if let Some(seconds) = unsigned(value.get("duration_secs")) {
        return Some(seconds);
    }
    let duration = text(value.get("duration"), 32)?;
    let parts = duration
        .split(':')
        .map(|part| part.trim().parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    match parts.as_slice() {
        [hours, minutes, seconds] => Some(hours * 3600 + minutes * 60 + seconds),
        [minutes, seconds] => Some(minutes * 60 + seconds),
        [seconds] => Some(*seconds),
        _ => None,
    }
}

pub fn parse_vod_categories(value: &Value) -> Result<Vec<VodCategoryPayload>, String> {
    let rows = value
        .as_array()
        .ok_or_else(|| "The VOD categories response was not an array.".to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(VodCategoryPayload {
                id: identifier(row.get("category_id"))?,
                name: text(row.get("category_name"), 160)
                    .unwrap_or_else(|| "Uncategorized".to_string()),
            })
        })
        .take(5_000)
        .collect())
}

const MAX_VOD_CATALOG_ITEMS: usize = 20_000;

pub fn parse_vod_catalog(kind: VodKind, value: &Value) -> Result<VodCatalogResponse, String> {
    let rows = value
        .as_array()
        .ok_or_else(|| "The VOD catalog response was not an array.".to_string())?;
    let mut items = rows
        .iter()
        .filter_map(|row| {
            let id = identifier(match kind {
                VodKind::Movie => row.get("stream_id"),
                VodKind::Series => row.get("series_id"),
            })?;
            Some(VodCatalogItemPayload {
                id,
                title: text(row.get("name").or_else(|| row.get("title")), 300)
                    .unwrap_or_else(|| "Untitled".to_string()),
                category_id: text(row.get("category_id"), 80).unwrap_or_default(),
                cover: public_url(row.get("stream_icon").or_else(|| row.get("cover"))),
                plot: text(row.get("plot"), 8_000),
                rating: number(row.get("rating").or_else(|| row.get("rating_5based"))),
                year: year(row),
                container_extension: container_extension(row.get("container_extension")),
                added: text(row.get("added").or_else(|| row.get("last_modified")), 40),
            })
        })
        .take(MAX_VOD_CATALOG_ITEMS + 1)
        .collect::<Vec<_>>();
    let truncated = items.len() > MAX_VOD_CATALOG_ITEMS;
    items.truncate(MAX_VOD_CATALOG_ITEMS);
    Ok(VodCatalogResponse {
        items,
        truncated,
        item_limit: MAX_VOD_CATALOG_ITEMS,
    })
}

pub fn parse_vod_details(
    kind: VodKind,
    requested_id: &str,
    value: &Value,
) -> Result<VodDetailsPayload, String> {
    let info = value.get("info").unwrap_or(value);
    let movie_data = value.get("movie_data").unwrap_or(value);
    let title = text(
        info.get("name")
            .or_else(|| info.get("title"))
            .or_else(|| movie_data.get("name")),
        300,
    )
    .unwrap_or_else(|| "Untitled".to_string());
    let backdrop = info
        .get("backdrop_path")
        .and_then(|value| value.as_array())
        .and_then(|values| values.first())
        .and_then(|value| public_url(Some(value)))
        .or_else(|| public_url(info.get("backdrop_path")));
    let mut seasons = Vec::new();

    if kind == VodKind::Series {
        let season_metadata = value
            .get("seasons")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(episodes_by_season) = value.get("episodes").and_then(Value::as_object) {
            for (season_key, episode_rows) in episodes_by_season {
                let season_number = season_key.parse::<u32>().unwrap_or_default();
                let metadata = season_metadata.iter().find(|season| {
                    unsigned(season.get("season_number")) == Some(season_number as u64)
                });
                let episodes = episode_rows
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|episode| {
                        let episode_info = episode.get("info").unwrap_or(episode);
                        Some(VodEpisodePayload {
                            id: identifier(episode.get("id"))?,
                            title: text(episode.get("title"), 300)
                                .unwrap_or_else(|| "Untitled episode".to_string()),
                            season: unsigned(episode.get("season")).unwrap_or(season_number as u64)
                                as u32,
                            episode: unsigned(episode.get("episode_num")).unwrap_or_default()
                                as u32,
                            container_extension: container_extension(
                                episode.get("container_extension"),
                            )
                            .unwrap_or_else(|| "mp4".to_string()),
                            plot: text(episode_info.get("plot"), 8_000),
                            duration_secs: duration_secs(episode_info),
                            cover: public_url(
                                episode_info
                                    .get("movie_image")
                                    .or_else(|| episode_info.get("cover")),
                            ),
                        })
                    })
                    .collect::<Vec<_>>();
                seasons.push(VodSeasonPayload {
                    number: season_number,
                    name: metadata
                        .and_then(|season| text(season.get("name"), 200))
                        .unwrap_or_else(|| format!("Season {season_number}")),
                    cover: metadata.and_then(|season| public_url(season.get("cover"))),
                    episodes,
                });
            }
            seasons.sort_by_key(|season| season.number);
            for season in &mut seasons {
                season.episodes.sort_by_key(|episode| episode.episode);
            }
        }
    }

    Ok(VodDetailsPayload {
        kind: kind.label().to_string(),
        id: identifier(movie_data.get("stream_id"))
            .unwrap_or_else(|| requested_id.chars().take(100).collect()),
        title,
        plot: text(info.get("plot").or_else(|| info.get("description")), 8_000),
        cover: public_url(
            info.get("movie_image")
                .or_else(|| info.get("cover"))
                .or_else(|| movie_data.get("stream_icon")),
        ),
        backdrop,
        rating: number(info.get("rating").or_else(|| info.get("rating_5based"))),
        year: year(info),
        genre: text(info.get("genre"), 500),
        cast: text(info.get("cast"), 2_000),
        director: text(info.get("director"), 1_000),
        duration_secs: duration_secs(info),
        container_extension: container_extension(movie_data.get("container_extension")),
        seasons,
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_vod_catalog, parse_vod_categories, parse_vod_details, public_url, VodKind};
    use serde_json::{json, Value};

    #[test]
    fn categories_are_bounded_normalized_and_skip_invalid_rows() {
        let categories = parse_vod_categories(&json!([
            {"category_id": "7", "category_name": " Action "},
            {"category_id": 8, "category_name": "Drama"},
            {"category_id": "../unsafe", "category_name": "Unsafe"},
            {"category_name": "Missing id"}
        ]))
        .expect("categories");

        assert_eq!(categories.len(), 2);
        assert_eq!(categories[0].id, "7");
        assert_eq!(categories[0].name, "Action");
        assert_eq!(categories[1].id, "8");
    }

    #[test]
    fn movie_catalog_exposes_metadata_without_stream_urls_or_credentials() {
        let catalog = parse_vod_catalog(
            VodKind::Movie,
            &json!([{
                "stream_id": 42,
                "name": "Example Movie",
                "category_id": "7",
                "stream_icon": "https://images.example/poster.jpg",
                "plot": "A useful plot.",
                "rating": "8.2",
                "year": "2025",
                "container_extension": "mkv",
                "added": "1700000000",
                "direct_source": "https://provider.example/movie/user/private/42.mkv"
            }, {
                "stream_id": "../unsafe",
                "name": "Unsafe descriptor"
            }]),
        )
        .expect("catalog");

        assert_eq!(catalog.items.len(), 1);
        assert!(!catalog.truncated);
        assert_eq!(catalog.item_limit, 20_000);
        assert_eq!(catalog.items[0].id, "42");
        assert_eq!(catalog.items[0].rating, Some(8.2));
        let serialized = serde_json::to_string(&catalog).expect("serialize");
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("direct_source"));
    }

    #[test]
    fn oversized_catalogs_report_visible_truncation_metadata() {
        let rows = (0..20_001)
            .map(|id| json!({ "stream_id": id, "name": format!("Title {id}") }))
            .collect::<Vec<_>>();
        let catalog = parse_vod_catalog(VodKind::Movie, &Value::Array(rows)).expect("catalog");
        assert_eq!(catalog.items.len(), 20_000);
        assert!(catalog.truncated);
        assert_eq!(catalog.item_limit, 20_000);
    }

    #[test]
    fn series_details_normalize_seasons_and_episode_playback_descriptors() {
        let details = parse_vod_details(
            VodKind::Series,
            "99",
            &json!({
                "info": {
                    "name": "Example Series",
                    "plot": "Series plot",
                    "cover": "https://images.example/series.jpg",
                    "backdrop_path": ["https://images.example/backdrop.jpg"],
                    "rating": "7.5",
                    "genre": "Drama",
                    "cast": "A, B",
                    "director": "Director"
                },
                "seasons": [{"season_number": 1, "name": "Season 1", "cover": "https://images.example/s1.jpg"}],
                "episodes": {
                    "1": [{
                        "id": "episode-1",
                        "episode_num": 1,
                        "title": "Pilot",
                        "container_extension": "mp4",
                        "info": {"plot": "Pilot plot", "duration_secs": 2700}
                    }]
                }
            }),
        )
        .expect("details");

        assert_eq!(details.title, "Example Series");
        assert_eq!(details.seasons.len(), 1);
        assert_eq!(details.seasons[0].episodes[0].id, "episode-1");
        assert_eq!(details.seasons[0].episodes[0].duration_secs, Some(2700));
    }

    #[test]
    fn malformed_provider_shapes_fail_without_echoing_response_data() {
        let marker = "private-provider-marker";
        let error = parse_vod_catalog(VodKind::Movie, &json!({"secret": marker}))
            .expect_err("object must be rejected");
        assert!(!error.contains(marker));
    }

    #[test]
    fn artwork_urls_remove_sensitive_query_values_and_reject_xtream_stream_paths() {
        let sanitized = public_url(Some(&json!(
            "https://images.example/poster.jpg?api_key=private&size=large&signature=secret&authorization=bearer&credential=hidden"
        )))
        .expect("safe artwork URL");
        assert_eq!(sanitized, "https://images.example/poster.jpg?size=large");
        for unsafe_url in [
            "https://provider.example/panel/movie/user/private/42.jpg",
            "https://provider.example/panel/%6dovie/user/private/42.jpg",
            "https://provider.example/panel/%6dovie%2Fuser%2Fprivate%2F42.jpg",
            "https://provider.example/panel/%6dovie%5Cuser%5Cprivate%5C42.jpg",
            "https://provider.example/panel/%256dovie/user/private/42.jpg",
            "https://provider.example/panel/%6/movie/user/private/42.jpg",
        ] {
            assert!(
                public_url(Some(&json!(unsafe_url))).is_none(),
                "missed {unsafe_url}"
            );
        }
    }
}
