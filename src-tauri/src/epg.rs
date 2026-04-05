use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Read},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use flate2::read::GzDecoder;
use quick_xml::{
    escape::unescape,
    events::{BytesCData, BytesStart, BytesText, Event},
    reader::Reader,
};
use reqwest::{header::CONTENT_TYPE, Client, Url};
use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime, State};

const MAX_EPG_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_EPG_XML_BYTES: usize = 192 * 1024 * 1024;
const REQUEST_TIMEOUT_SECS: u64 = 20;
const EPG_CACHE_PATH: &str = "epg/cache.json";
const GZIP_MAGIC_BYTES: [u8; 2] = [0x1f, 0x8b];

#[derive(Default)]
pub struct EpgState {
    cache: Mutex<Option<EpgCache>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EpgCache {
    source_url: String,
    fetched_at: String,
    channel_count: usize,
    programme_count: usize,
    channels: Vec<EpgDirectoryChannel>,
    programmes_by_channel: HashMap<String, Vec<EpgProgramme>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgDirectoryChannel {
    id: String,
    display_names: Vec<String>,
    icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EpgProgramme {
    start_ms: i64,
    stop_ms: Option<i64>,
    title: String,
    sub_title: Option<String>,
    description: Option<String>,
    icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgDirectoryResponse {
    source_url: String,
    fetched_at: String,
    channel_count: usize,
    programme_count: usize,
    channels: Vec<EpgDirectoryChannel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgProgrammeSummary {
    start_ms: i64,
    stop_ms: Option<i64>,
    title: String,
    sub_title: Option<String>,
    description: Option<String>,
    icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgProgrammeSnapshot {
    epg_channel_id: String,
    current: Option<EpgProgrammeSummary>,
    next: Option<EpgProgrammeSummary>,
}

#[derive(Default)]
struct PendingChannel {
    id: String,
    display_names: Vec<String>,
    icon: Option<String>,
}

struct PendingProgramme {
    channel_id: String,
    start_ms: i64,
    stop_ms: Option<i64>,
    title: Option<String>,
    sub_title: Option<String>,
    description: Option<String>,
    icon: Option<String>,
}

enum TextTarget {
    ChannelDisplayName,
    ProgrammeTitle,
    ProgrammeSubTitle,
    ProgrammeDescription,
}

impl EpgCache {
    fn directory_response(&self) -> EpgDirectoryResponse {
        EpgDirectoryResponse {
            source_url: self.source_url.clone(),
            fetched_at: self.fetched_at.clone(),
            channel_count: self.channel_count,
            programme_count: self.programme_count,
            channels: self.channels.clone(),
        }
    }
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("onyx/0.1 epg")
        .build()
        .map_err(|error| format!("Could not initialize the EPG network client: {error}"))
}

fn normalize_epg_url_input(raw_input: &str) -> Result<Url, String> {
    let trimmed_input = raw_input.trim();
    let normalized_input = trimmed_input
        .strip_prefix("XMLTV:")
        .or_else(|| trimmed_input.strip_prefix("xmltv:"))
        .unwrap_or(trimmed_input)
        .trim();

    if normalized_input.is_empty() {
        return Err("Enter an EPG URL first.".to_string());
    }

    let parsed_url =
        Url::parse(normalized_input).map_err(|_| "The EPG URL is not valid.".to_string())?;

    match parsed_url.scheme() {
        "http" | "https" => Ok(parsed_url),
        _ => Err("Only http and https EPG URLs are supported.".to_string()),
    }
}

async fn fetch_bytes_with_limit(
    client: &Client,
    url: Url,
    byte_limit: usize,
    failure_label: &str,
) -> Result<(Vec<u8>, Option<String>), String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("{failure_label}: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "The request failed with HTTP {}.",
            response.status()
        ));
    }

    if let Some(content_length) = response.content_length() {
        if content_length > byte_limit as u64 {
            return Err("The EPG response is too large to import safely.".to_string());
        }
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let mut body = Vec::new();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read the server response: {error}"))?
    {
        if body.len() + chunk.len() > byte_limit {
            return Err("The EPG response is too large to import safely.".to_string());
        }

        body.extend_from_slice(&chunk);
    }

    if body.is_empty() {
        return Err("The EPG server returned an empty response.".to_string());
    }

    Ok((body, content_type))
}

fn decode_gzip_with_limit(compressed: &[u8], byte_limit: usize) -> Result<Vec<u8>, String> {
    let mut decoder = GzDecoder::new(Cursor::new(compressed));
    let mut decoded = Vec::new();
    let mut buffer = [0_u8; 8192];

    loop {
        let bytes_read = decoder
            .read(&mut buffer)
            .map_err(|error| format!("Could not decompress the EPG response: {error}"))?;

        if bytes_read == 0 {
            break;
        }

        if decoded.len() + bytes_read > byte_limit {
            return Err("The decompressed EPG response is too large to import safely.".to_string());
        }

        decoded.extend_from_slice(&buffer[..bytes_read]);
    }

    Ok(decoded)
}

fn decode_epg_bytes(
    compressed_body: Vec<u8>,
    source_url: &Url,
    content_type: Option<&str>,
) -> Result<Vec<u8>, String> {
    let looks_gzipped = compressed_body.starts_with(&GZIP_MAGIC_BYTES)
        || source_url.path().to_ascii_lowercase().ends_with(".gz")
        || content_type
            .map(|value| value.to_ascii_lowercase().contains("gzip"))
            .unwrap_or(false);

    if looks_gzipped {
        return decode_gzip_with_limit(&compressed_body, MAX_EPG_XML_BYTES);
    }

    if compressed_body.len() > MAX_EPG_XML_BYTES {
        return Err("The EPG response is too large to import safely.".to_string());
    }

    Ok(compressed_body)
}

fn decode_text(_reader: &Reader<Cursor<Vec<u8>>>, event: &BytesText<'_>) -> Result<String, String> {
    let decoded = event
        .decode()
        .map_err(|error| format!("Could not decode EPG text: {error}"))?;
    let unescaped =
        unescape(&decoded).map_err(|error| format!("Could not unescape EPG text: {error}"))?;

    Ok(unescaped.trim().to_string())
}

fn decode_cdata(
    reader: &Reader<Cursor<Vec<u8>>>,
    event: &BytesCData<'_>,
) -> Result<String, String> {
    let decoded = reader
        .decoder()
        .decode(event.as_ref())
        .map_err(|error| format!("Could not decode EPG CDATA: {error}"))?;

    Ok(decoded.trim().to_string())
}

fn get_attribute(
    start: &BytesStart<'_>,
    reader: &Reader<Cursor<Vec<u8>>>,
    key: &[u8],
) -> Result<Option<String>, String> {
    for attribute in start.attributes().with_checks(false) {
        let attribute =
            attribute.map_err(|error| format!("Could not read an EPG XML attribute: {error}"))?;

        if attribute.key.as_ref() != key {
            continue;
        }

        let value = attribute
            .decode_and_unescape_value(reader.decoder())
            .map_err(|error| format!("Could not decode an EPG XML attribute: {error}"))?;
        let trimmed_value = value.trim();

        return Ok((!trimmed_value.is_empty()).then(|| trimmed_value.to_string()));
    }

    Ok(None)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn append_first_text(target: &mut Option<String>, value: String) {
    if target.is_none() {
        let trimmed = value.trim();

        if !trimmed.is_empty() {
            *target = Some(trimmed.to_string());
        }
    }
}

fn parse_xmltv_timestamp(raw_value: &str) -> Result<i64, String> {
    let trimmed_value = raw_value.trim();

    if trimmed_value.is_empty() {
        return Err("The guide contains a programme without a start time.".to_string());
    }

    let formats_with_offset = [
        "%Y%m%d%H%M%S %z",
        "%Y%m%d%H%M %z",
        "%Y%m%d%H %z",
        "%Y%m%d %z",
    ];

    for format in formats_with_offset {
        if let Ok(parsed) = DateTime::parse_from_str(trimmed_value, format) {
            return Ok(parsed.timestamp_millis());
        }
    }

    let normalized_value = trimmed_value.replace(' ', "");
    let formats_without_offset = ["%Y%m%d%H%M%S", "%Y%m%d%H%M", "%Y%m%d%H", "%Y%m%d"];

    for format in formats_without_offset {
        if let Ok(parsed) = NaiveDateTime::parse_from_str(&normalized_value, format) {
            return Ok(Utc.from_utc_datetime(&parsed).timestamp_millis());
        }
    }

    if let Ok(parsed) = NaiveDate::parse_from_str(&normalized_value, "%Y%m%d") {
        let midnight = NaiveTime::from_hms_opt(0, 0, 0)
            .ok_or_else(|| "Could not create the guide fallback time.".to_string())?;
        let parsed_datetime = NaiveDateTime::new(parsed, midnight);
        return Ok(Utc.from_utc_datetime(&parsed_datetime).timestamp_millis());
    }

    Err(format!("Unsupported XMLTV timestamp: {trimmed_value}"))
}

fn finalize_channel(
    channel: PendingChannel,
    channels: &mut Vec<EpgDirectoryChannel>,
    known_channel_ids: &mut HashSet<String>,
) {
    let channel_id = channel.id.trim();

    if channel_id.is_empty() || !known_channel_ids.insert(channel_id.to_string()) {
        return;
    }

    let mut seen_display_names = HashSet::new();
    let mut display_names = Vec::new();

    for display_name in channel.display_names {
        let trimmed = display_name.trim();

        if trimmed.is_empty() || !seen_display_names.insert(trimmed.to_string()) {
            continue;
        }

        display_names.push(trimmed.to_string());
    }

    if display_names.is_empty() {
        display_names.push(channel_id.to_string());
    }

    channels.push(EpgDirectoryChannel {
        id: channel_id.to_string(),
        display_names,
        icon: normalize_optional_text(channel.icon),
    });
}

fn finalize_programme(
    programme: PendingProgramme,
    programmes_by_channel: &mut HashMap<String, Vec<EpgProgramme>>,
) {
    let title = programme
        .title
        .and_then(|value| normalize_optional_text(Some(value)))
        .unwrap_or_else(|| "Untitled programme".to_string());

    programmes_by_channel
        .entry(programme.channel_id)
        .or_default()
        .push(EpgProgramme {
            start_ms: programme.start_ms,
            stop_ms: programme.stop_ms,
            title,
            sub_title: normalize_optional_text(programme.sub_title),
            description: normalize_optional_text(programme.description),
            icon: normalize_optional_text(programme.icon),
        });
}

fn parse_programme_start(
    start: &BytesStart<'_>,
    reader: &Reader<Cursor<Vec<u8>>>,
) -> Result<Option<PendingProgramme>, String> {
    let Some(channel_id) = get_attribute(start, reader, b"channel")? else {
        return Ok(None);
    };

    let Some(start_text) = get_attribute(start, reader, b"start")? else {
        return Ok(None);
    };

    let start_ms = parse_xmltv_timestamp(&start_text)?;
    let stop_ms = get_attribute(start, reader, b"stop")?
        .map(|value| parse_xmltv_timestamp(&value))
        .transpose()?;

    Ok(Some(PendingProgramme {
        channel_id,
        start_ms,
        stop_ms,
        title: None,
        sub_title: None,
        description: None,
        icon: None,
    }))
}

fn parse_xmltv_document(source_url: String, xml_bytes: Vec<u8>) -> Result<EpgCache, String> {
    let mut reader = Reader::from_reader(Cursor::new(xml_bytes));
    reader.config_mut().trim_text(true);

    let mut buffer = Vec::new();
    let mut channels = Vec::new();
    let mut known_channel_ids = HashSet::new();
    let mut programmes_by_channel: HashMap<String, Vec<EpgProgramme>> = HashMap::new();
    let mut current_channel: Option<PendingChannel> = None;
    let mut current_programme: Option<PendingProgramme> = None;
    let mut text_target: Option<TextTarget> = None;

    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("Could not parse the EPG XML: {error}"))?
        {
            Event::Start(start) => match start.local_name().as_ref() {
                b"channel" => {
                    current_channel = Some(PendingChannel {
                        id: get_attribute(&start, &reader, b"id")?.unwrap_or_default(),
                        ..PendingChannel::default()
                    });
                    text_target = None;
                }
                b"display-name" if current_channel.is_some() => {
                    text_target = Some(TextTarget::ChannelDisplayName);
                }
                b"icon" if current_channel.is_some() => {
                    if let Some(icon) = get_attribute(&start, &reader, b"src")? {
                        if let Some(channel) = current_channel.as_mut() {
                            channel.icon = Some(icon);
                        }
                    }
                }
                b"programme" => {
                    current_programme = parse_programme_start(&start, &reader)?;
                    text_target = None;
                }
                b"title" if current_programme.is_some() => {
                    text_target = Some(TextTarget::ProgrammeTitle);
                }
                b"sub-title" if current_programme.is_some() => {
                    text_target = Some(TextTarget::ProgrammeSubTitle);
                }
                b"desc" if current_programme.is_some() => {
                    text_target = Some(TextTarget::ProgrammeDescription);
                }
                b"icon" if current_programme.is_some() => {
                    if let Some(icon) = get_attribute(&start, &reader, b"src")? {
                        if let Some(programme) = current_programme.as_mut() {
                            programme.icon = Some(icon);
                        }
                    }
                }
                _ => {}
            },
            Event::Empty(start) => match start.local_name().as_ref() {
                b"channel" => {
                    finalize_channel(
                        PendingChannel {
                            id: get_attribute(&start, &reader, b"id")?.unwrap_or_default(),
                            ..PendingChannel::default()
                        },
                        &mut channels,
                        &mut known_channel_ids,
                    );
                }
                b"icon" if current_channel.is_some() => {
                    if let Some(icon) = get_attribute(&start, &reader, b"src")? {
                        if let Some(channel) = current_channel.as_mut() {
                            channel.icon = Some(icon);
                        }
                    }
                }
                b"programme" => {
                    if let Some(programme) = parse_programme_start(&start, &reader)? {
                        finalize_programme(programme, &mut programmes_by_channel);
                    }
                }
                b"icon" if current_programme.is_some() => {
                    if let Some(icon) = get_attribute(&start, &reader, b"src")? {
                        if let Some(programme) = current_programme.as_mut() {
                            programme.icon = Some(icon);
                        }
                    }
                }
                _ => {}
            },
            Event::End(end) => match end.local_name().as_ref() {
                b"display-name" | b"title" | b"sub-title" | b"desc" => {
                    text_target = None;
                }
                b"channel" => {
                    if let Some(channel) = current_channel.take() {
                        finalize_channel(channel, &mut channels, &mut known_channel_ids);
                    }
                }
                b"programme" => {
                    if let Some(programme) = current_programme.take() {
                        finalize_programme(programme, &mut programmes_by_channel);
                    }
                }
                _ => {}
            },
            Event::Text(text) => {
                let decoded_text = decode_text(&reader, &text)?;

                if decoded_text.is_empty() {
                    buffer.clear();
                    continue;
                }

                match text_target {
                    Some(TextTarget::ChannelDisplayName) => {
                        if let Some(channel) = current_channel.as_mut() {
                            channel.display_names.push(decoded_text);
                        }
                    }
                    Some(TextTarget::ProgrammeTitle) => {
                        if let Some(programme) = current_programme.as_mut() {
                            append_first_text(&mut programme.title, decoded_text);
                        }
                    }
                    Some(TextTarget::ProgrammeSubTitle) => {
                        if let Some(programme) = current_programme.as_mut() {
                            append_first_text(&mut programme.sub_title, decoded_text);
                        }
                    }
                    Some(TextTarget::ProgrammeDescription) => {
                        if let Some(programme) = current_programme.as_mut() {
                            append_first_text(&mut programme.description, decoded_text);
                        }
                    }
                    None => {}
                }
            }
            Event::CData(text) => {
                let decoded_text = decode_cdata(&reader, &text)?;

                if decoded_text.is_empty() {
                    buffer.clear();
                    continue;
                }

                match text_target {
                    Some(TextTarget::ChannelDisplayName) => {
                        if let Some(channel) = current_channel.as_mut() {
                            channel.display_names.push(decoded_text);
                        }
                    }
                    Some(TextTarget::ProgrammeTitle) => {
                        if let Some(programme) = current_programme.as_mut() {
                            append_first_text(&mut programme.title, decoded_text);
                        }
                    }
                    Some(TextTarget::ProgrammeSubTitle) => {
                        if let Some(programme) = current_programme.as_mut() {
                            append_first_text(&mut programme.sub_title, decoded_text);
                        }
                    }
                    Some(TextTarget::ProgrammeDescription) => {
                        if let Some(programme) = current_programme.as_mut() {
                            append_first_text(&mut programme.description, decoded_text);
                        }
                    }
                    None => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }

        buffer.clear();
    }

    if let Some(channel) = current_channel.take() {
        finalize_channel(channel, &mut channels, &mut known_channel_ids);
    }

    if let Some(programme) = current_programme.take() {
        finalize_programme(programme, &mut programmes_by_channel);
    }

    for (channel_id, programmes) in &mut programmes_by_channel {
        if !known_channel_ids.contains(channel_id) {
            known_channel_ids.insert(channel_id.clone());
            channels.push(EpgDirectoryChannel {
                id: channel_id.clone(),
                display_names: vec![channel_id.clone()],
                icon: None,
            });
        }

        programmes.sort_by_key(|programme| programme.start_ms);
    }

    if programmes_by_channel.is_empty() {
        return Err("The XMLTV file did not contain any programmes.".to_string());
    }

    channels.sort_by(|left, right| {
        let left_name = left.display_names.first().unwrap_or(&left.id);
        let right_name = right.display_names.first().unwrap_or(&right.id);

        left_name
            .to_ascii_lowercase()
            .cmp(&right_name.to_ascii_lowercase())
    });

    let programme_count = programmes_by_channel.values().map(Vec::len).sum();
    let fetched_at = Utc::now().to_rfc3339();

    Ok(EpgCache {
        source_url,
        fetched_at,
        channel_count: channels.len(),
        programme_count,
        channels,
        programmes_by_channel,
    })
}

fn get_epg_cache_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .resolve(EPG_CACHE_PATH, BaseDirectory::AppLocalData)
        .map_err(|error| format!("Could not resolve the EPG cache path: {error}"))
}

fn write_epg_cache_to_disk<R: Runtime>(app: &AppHandle<R>, cache: &EpgCache) -> Result<(), String> {
    let cache_path = get_epg_cache_path(app)?;

    if let Some(parent_directory) = cache_path.parent() {
        fs::create_dir_all(parent_directory)
            .map_err(|error| format!("Could not create the EPG cache directory: {error}"))?;
    }

    let serialized = serde_json::to_vec(cache)
        .map_err(|error| format!("Could not serialize the EPG cache: {error}"))?;

    fs::write(cache_path, serialized)
        .map_err(|error| format!("Could not write the EPG cache to disk: {error}"))?;

    Ok(())
}

fn read_epg_cache_from_disk<R: Runtime>(app: &AppHandle<R>) -> Result<Option<EpgCache>, String> {
    let cache_path = get_epg_cache_path(app)?;

    if !cache_path.exists() {
        return Ok(None);
    }

    let bytes = fs::read(cache_path)
        .map_err(|error| format!("Could not read the saved EPG cache: {error}"))?;
    let cache = serde_json::from_slice::<EpgCache>(&bytes)
        .map_err(|error| format!("Could not parse the saved EPG cache: {error}"))?;

    Ok(Some(cache))
}

fn ensure_epg_cache_loaded<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, EpgState>,
) -> Result<(), String> {
    let mut cache_guard = state
        .cache
        .lock()
        .map_err(|_| "Could not access the saved EPG cache.".to_string())?;

    if cache_guard.is_some() {
        return Ok(());
    }

    *cache_guard = read_epg_cache_from_disk(app)?;
    Ok(())
}

fn programme_to_summary(programme: &EpgProgramme) -> EpgProgrammeSummary {
    EpgProgrammeSummary {
        start_ms: programme.start_ms,
        stop_ms: programme.stop_ms,
        title: programme.title.clone(),
        sub_title: programme.sub_title.clone(),
        description: programme.description.clone(),
        icon: programme.icon.clone(),
    }
}

fn get_programme_snapshots_for_channel(
    programmes: &[EpgProgramme],
    now_ms: i64,
) -> (Option<EpgProgrammeSummary>, Option<EpgProgrammeSummary>) {
    let mut current = None;
    let mut next = None;

    for (index, programme) in programmes.iter().enumerate() {
        let inferred_stop = programme.stop_ms.or_else(|| {
            programmes
                .get(index + 1)
                .map(|candidate| candidate.start_ms)
        });

        if programme.start_ms <= now_ms && inferred_stop.map_or(true, |stop_ms| now_ms < stop_ms) {
            current = Some(programme_to_summary(programme));
            next = programmes.get(index + 1).map(programme_to_summary);
            break;
        }

        if programme.start_ms > now_ms {
            next = Some(programme_to_summary(programme));
            break;
        }
    }

    (current, next)
}

#[tauri::command]
pub async fn refresh_epg_cache(
    app: AppHandle,
    state: State<'_, EpgState>,
    url: String,
) -> Result<EpgDirectoryResponse, String> {
    let normalized_url = normalize_epg_url_input(&url)?;
    let client = build_http_client()?;
    let (compressed_body, content_type) = fetch_bytes_with_limit(
        &client,
        normalized_url.clone(),
        MAX_EPG_DOWNLOAD_BYTES,
        "Could not download the EPG file",
    )
    .await?;
    let xml_bytes = decode_epg_bytes(compressed_body, &normalized_url, content_type.as_deref())?;
    let cache = parse_xmltv_document(normalized_url.to_string(), xml_bytes)?;
    let response = cache.directory_response();

    write_epg_cache_to_disk(&app, &cache)?;

    let mut cache_guard = state
        .cache
        .lock()
        .map_err(|_| "Could not save the in-memory EPG cache.".to_string())?;
    *cache_guard = Some(cache);

    Ok(response)
}

#[tauri::command]
pub fn load_epg_cache_directory(
    app: AppHandle,
    state: State<'_, EpgState>,
) -> Result<Option<EpgDirectoryResponse>, String> {
    ensure_epg_cache_loaded(&app, &state)?;

    let cache_guard = state
        .cache
        .lock()
        .map_err(|_| "Could not access the saved EPG cache.".to_string())?;

    Ok(cache_guard.as_ref().map(EpgCache::directory_response))
}

#[tauri::command]
pub fn get_epg_programme_snapshots(
    app: AppHandle,
    state: State<'_, EpgState>,
    epg_channel_ids: Vec<String>,
    at_ms: Option<i64>,
) -> Result<Vec<EpgProgrammeSnapshot>, String> {
    ensure_epg_cache_loaded(&app, &state)?;

    let now_ms = at_ms.unwrap_or_else(|| Utc::now().timestamp_millis());
    let cache_guard = state
        .cache
        .lock()
        .map_err(|_| "Could not access the saved EPG cache.".to_string())?;
    let Some(cache) = cache_guard.as_ref() else {
        return Ok(Vec::new());
    };

    let mut seen_channel_ids = HashSet::new();
    let mut snapshots = Vec::new();

    for epg_channel_id in epg_channel_ids {
        let trimmed_channel_id = epg_channel_id.trim();

        if trimmed_channel_id.is_empty() || !seen_channel_ids.insert(trimmed_channel_id.to_string())
        {
            continue;
        }

        let Some(programmes) = cache.programmes_by_channel.get(trimmed_channel_id) else {
            continue;
        };

        let (current, next) = get_programme_snapshots_for_channel(programmes, now_ms);

        snapshots.push(EpgProgrammeSnapshot {
            epg_channel_id: trimmed_channel_id.to_string(),
            current,
            next,
        });
    }

    Ok(snapshots)
}
