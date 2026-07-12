use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
const CONNECT_TIMEOUT_SECS: u64 = 15;
const READ_TIMEOUT_SECS: u64 = 45;
const EPG_CACHE_PATH: &str = "epg/cache.json";
const GZIP_MAGIC_BYTES: [u8; 2] = [0x1f, 0x8b];
const MAX_EPG_CACHE_BYTES: usize = 256 * 1024 * 1024;
const MAX_WARNING_SAMPLES: usize = 5;
const TOTAL_REFRESH_TIMEOUT_SECS: u64 = 90;

#[derive(Default)]
pub struct EpgState {
    caches: Mutex<Option<HashMap<String, EpgCache>>>,
    diagnostics: Mutex<EpgCacheDiagnostics>,
    generations: Mutex<GenerationRegistry>,
    disk_writes: Mutex<()>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EpgCacheDiagnostics {
    recovered: bool,
    corrupt: bool,
    warnings: Vec<String>,
}

impl EpgState {
    fn install_disk_read(&self, outcome: EpgDiskRead) -> Result<(), String> {
        let mut caches = self
            .caches
            .lock()
            .map_err(|_| "Could not access the saved EPG caches.".to_string())?;
        if caches.is_some() {
            return Ok(());
        }
        let mut diagnostics = self
            .diagnostics
            .lock()
            .map_err(|_| "Could not access the EPG cache diagnostics.".to_string())?;
        *diagnostics = EpgCacheDiagnostics {
            recovered: outcome.recovered,
            corrupt: outcome.corrupt,
            warnings: outcome.warnings,
        };
        *caches = Some(outcome.caches);
        Ok(())
    }

    #[allow(dead_code)] // Used by the command once it is added to the app's handler list.
    fn cache_diagnostics(&self) -> Result<EpgCacheDiagnostics, String> {
        self.diagnostics
            .lock()
            .map(|diagnostics| diagnostics.clone())
            .map_err(|_| "Could not access the EPG cache diagnostics.".to_string())
    }
}

#[derive(Default)]
struct GenerationRegistry {
    next: u64,
    current: HashMap<String, u64>,
}

impl GenerationRegistry {
    fn advance(&mut self, url: &str) -> u64 {
        self.next = self.next.wrapping_add(1).max(1);
        self.current.insert(url.to_string(), self.next);
        self.next
    }

    fn begin_refresh(&mut self, url: &str) -> u64 {
        self.advance(url)
    }

    fn delete(&mut self, url: &str) {
        self.advance(url);
    }

    fn accept_refresh(&self, url: &str, generation: u64) -> bool {
        self.current
            .get(url)
            .is_some_and(|current| *current == generation)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EpgCache {
    source_url: String,
    fetched_at: String,
    channel_count: usize,
    programme_count: usize,
    channels: Vec<StoredEpgChannel>,
    programmes_by_channel: HashMap<String, Vec<EpgProgramme>>,
    #[serde(default)]
    skipped_programme_count: usize,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(skip)]
    recovered: bool,
    #[serde(skip)]
    corrupt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEpgChannel {
    id: String,
    display_names: Vec<String>,
    icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgDirectoryChannel {
    id: String,
    unique_id: String,
    source_url: String,
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
    skipped_programme_count: usize,
    warnings: Vec<String>,
    recovered: bool,
    corrupt: bool,
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
    epg_channel_key: String,
    current: Option<EpgProgrammeSummary>,
    next: Option<EpgProgrammeSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgProgrammeWindow {
    epg_channel_key: String,
    programmes: Vec<EpgProgrammeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EpgCacheStore {
    caches: HashMap<String, EpgCache>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpgCacheStoreRef<'a> {
    caches: &'a HashMap<String, EpgCache>,
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
            channels: self
                .channels
                .iter()
                .map(|channel| EpgDirectoryChannel {
                    id: channel.id.clone(),
                    unique_id: create_epg_channel_key(&self.source_url, &channel.id),
                    source_url: self.source_url.clone(),
                    display_names: channel.display_names.clone(),
                    icon: channel.icon.clone(),
                })
                .collect(),
            skipped_programme_count: self.skipped_programme_count,
            warnings: self.warnings.clone(),
            recovered: self.recovered,
            corrupt: self.corrupt,
        }
    }
}

fn create_epg_channel_key(source_url: &str, channel_id: &str) -> String {
    format!("{}\u{1}{}", source_url.trim(), channel_id.trim())
}

fn split_epg_channel_key(raw_key: &str) -> Option<(String, String)> {
    let (source_url, channel_id) = raw_key.split_once('\u{1}')?;
    let trimmed_source_url = source_url.trim();
    let trimmed_channel_id = channel_id.trim();

    if trimmed_source_url.is_empty() || trimmed_channel_id.is_empty() {
        return None;
    }

    Some((
        trimmed_source_url.to_string(),
        trimmed_channel_id.to_string(),
    ))
}

fn normalize_epg_cache_map(caches: HashMap<String, EpgCache>) -> HashMap<String, EpgCache> {
    let mut normalized_caches = HashMap::new();

    for (_, cache) in caches {
        let normalized_source_url = normalize_epg_url_input(&cache.source_url)
            .map(|url| url.to_string())
            .unwrap_or_else(|_| cache.source_url.clone());

        normalized_caches.insert(
            normalized_source_url.clone(),
            EpgCache {
                source_url: normalized_source_url,
                ..cache
            },
        );
    }

    normalized_caches
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(READ_TIMEOUT_SECS))
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

    let mut parsed_url =
        Url::parse(normalized_input).map_err(|_| "The EPG URL is not valid.".to_string())?;
    parsed_url.set_fragment(None);

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
        .map_err(|error| format!("{failure_label}: {}", error.without_url()))?;

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

    while let Some(chunk) = response.chunk().await.map_err(|error| {
        format!(
            "Could not read the server response: {}",
            error.without_url()
        )
    })? {
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
    _source_url: &Url,
    _content_type: Option<&str>,
) -> Result<Vec<u8>, String> {
    if compressed_body.starts_with(&GZIP_MAGIC_BYTES) {
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
            .decoded_and_normalized_value(quick_xml::XmlVersion::default(), reader.decoder())
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
    channels: &mut Vec<StoredEpgChannel>,
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

    channels.push(StoredEpgChannel {
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
    let mut channels: Vec<StoredEpgChannel> = Vec::new();
    let mut known_channel_ids = HashSet::new();
    let mut programmes_by_channel: HashMap<String, Vec<EpgProgramme>> = HashMap::new();
    let mut current_channel: Option<PendingChannel> = None;
    let mut current_programme: Option<PendingProgramme> = None;
    let mut text_target: Option<TextTarget> = None;
    let mut skipped_programme_count = 0;
    let mut warnings = Vec::new();

    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("Could not parse the EPG XML: {error}"))?
        {
            Event::Start(start) => {
                match start.local_name().as_ref() {
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
                        match parse_programme_start(&start, &reader) {
                            Ok(Some(programme)) => current_programme = Some(programme),
                            Ok(None) | Err(_) => {
                                current_programme = None;
                                skipped_programme_count += 1;
                                if warnings.len() < MAX_WARNING_SAMPLES {
                                    warnings.push("Skipped a programme with invalid attributes or timestamps.".to_string());
                                }
                            }
                        }
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
                }
            }
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
                b"programme" => match parse_programme_start(&start, &reader) {
                    Ok(Some(programme)) => {
                        finalize_programme(programme, &mut programmes_by_channel);
                    }
                    Ok(None) | Err(_) => {
                        skipped_programme_count += 1;
                        if warnings.len() < MAX_WARNING_SAMPLES {
                            warnings.push(
                                "Skipped a programme with invalid attributes or timestamps."
                                    .to_string(),
                            );
                        }
                    }
                },
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
            channels.push(StoredEpgChannel {
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
        skipped_programme_count,
        warnings,
        recovered: false,
        corrupt: false,
    })
}

fn get_epg_cache_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .resolve(EPG_CACHE_PATH, BaseDirectory::AppLocalData)
        .map_err(|error| format!("Could not resolve the EPG cache path: {error}"))
}

#[derive(Default)]
struct EpgDiskRead {
    caches: HashMap<String, EpgCache>,
    recovered: bool,
    corrupt: bool,
    warnings: Vec<String>,
}

struct EpgDiskStore {
    path: PathBuf,
}

impl EpgDiskStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn backup_path(&self) -> PathBuf {
        self.path.with_extension("json.bak")
    }

    fn parse(bytes: &[u8]) -> Result<HashMap<String, EpgCache>, String> {
        if let Ok(cache_store) = serde_json::from_slice::<EpgCacheStore>(bytes) {
            return Ok(normalize_epg_cache_map(cache_store.caches));
        }
        if let Ok(caches) = serde_json::from_slice::<HashMap<String, EpgCache>>(bytes) {
            return Ok(normalize_epg_cache_map(caches));
        }
        if let Ok(cache) = serde_json::from_slice::<EpgCache>(bytes) {
            return Ok(normalize_epg_cache_map(HashMap::from([(
                cache.source_url.clone(),
                cache,
            )])));
        }
        Err("Could not parse the saved EPG cache.".to_string())
    }

    fn read_file(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        let file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Could not open the saved EPG cache: {error}")),
        };
        let length = file
            .metadata()
            .map_err(|error| format!("Could not inspect the saved EPG cache: {error}"))?
            .len();
        if length > MAX_EPG_CACHE_BYTES as u64 {
            return Ok(None);
        }
        let mut bytes = Vec::with_capacity(length as usize);
        file.take((MAX_EPG_CACHE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Could not read the saved EPG cache: {error}"))?;
        (bytes.len() <= MAX_EPG_CACHE_BYTES)
            .then_some(bytes)
            .ok_or_else(|| "The saved EPG cache is too large to read safely.".to_string())
            .map(Some)
    }

    fn discard_invalid(path: &Path) {
        if !path.exists() {
            return;
        }
        let suffix = unique_epg_suffix();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let quarantine = path.with_file_name(format!("{name}.corrupt-{suffix}"));
        let _ = fs::rename(path, quarantine).or_else(|_| fs::remove_file(path));
    }

    fn read(&self) -> Result<EpgDiskRead, String> {
        self.read_with_repair(atomic_write_epg)
    }

    fn read_with_repair<F>(&self, repair: F) -> Result<EpgDiskRead, String>
    where
        F: FnOnce(&Path, &[u8]) -> Result<(), String>,
    {
        let primary_existed = self.path.exists();
        let primary = self.read_file(&self.path)?;
        if let Some(bytes) = primary.as_ref() {
            if let Ok(caches) = Self::parse(bytes) {
                return Ok(EpgDiskRead {
                    caches,
                    ..EpgDiskRead::default()
                });
            }
            Self::discard_invalid(&self.path);
        } else if self.path.exists() {
            let _ = fs::remove_file(&self.path);
        }

        let backup_path = self.backup_path();
        let backup_existed = backup_path.exists();
        let backup = self.read_file(&backup_path)?;
        if let Some(bytes) = backup.as_ref() {
            if let Ok(mut caches) = Self::parse(bytes) {
                let repair_failed = repair(&self.path, bytes).is_err();
                for cache in caches.values_mut() {
                    cache.recovered = true;
                    cache.corrupt = primary_existed;
                    cache.warnings.push(
                        "Recovered the EPG cache from its last-known-good backup.".to_string(),
                    );
                    if repair_failed && cache.warnings.len() < MAX_WARNING_SAMPLES {
                        cache.warnings.push(
                            "The recovered EPG cache could not be repaired on disk.".to_string(),
                        );
                    }
                    cache.warnings.truncate(MAX_WARNING_SAMPLES);
                }
                let mut warnings = vec!["Recovered the EPG cache from backup.".to_string()];
                if repair_failed {
                    warnings
                        .push("The recovered EPG cache could not be repaired on disk.".to_string());
                }
                warnings.truncate(MAX_WARNING_SAMPLES);
                return Ok(EpgDiskRead {
                    caches,
                    recovered: true,
                    corrupt: primary_existed,
                    warnings,
                });
            }
            Self::discard_invalid(&backup_path);
        } else if backup_path.exists() {
            let _ = fs::remove_file(&backup_path);
        }

        let corrupt = primary_existed || backup_existed;
        Ok(EpgDiskRead {
            corrupt,
            warnings: corrupt
                .then(|| "The saved EPG cache was corrupt and has been reset safely.".to_string())
                .into_iter()
                .collect(),
            ..EpgDiskRead::default()
        })
    }

    fn write(&self, caches: &HashMap<String, EpgCache>) -> Result<(), String> {
        let serialized = serde_json::to_vec(&EpgCacheStoreRef { caches })
            .map_err(|error| format!("Could not serialize the EPG cache store: {error}"))?;
        if serialized.len() > MAX_EPG_CACHE_BYTES {
            return Err("The EPG cache is too large to save safely.".to_string());
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create the EPG cache directory: {error}"))?;
        }
        if let Some(existing) = self.read_file(&self.path)? {
            if Self::parse(&existing).is_ok() {
                atomic_write_epg(&self.backup_path(), &existing)?;
            }
        }
        atomic_write_epg(&self.path, &serialized)
    }
}

fn unique_epg_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos}", std::process::id())
}

fn atomic_write_epg(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The EPG cache path has no parent.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the EPG cache directory: {error}"))?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let temporary = parent.join(format!("{name}.tmp-{}", unique_epg_suffix()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Could not create a temporary EPG cache: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Could not write the temporary EPG cache: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not flush the temporary EPG cache: {error}"))?;
        drop(file);
        replace_epg_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_epg_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("Could not atomically replace the EPG cache: {error}"))
}

#[cfg(windows)]
fn replace_epg_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(format!(
            "Could not atomically replace the EPG cache: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

fn persist_epg_snapshot(path: &Path, state: &EpgState) -> Result<(), String> {
    let _write_guard = state
        .disk_writes
        .lock()
        .map_err(|_| "Could not coordinate the EPG cache write.".to_string())?;
    let snapshot = state
        .caches
        .lock()
        .map_err(|_| "Could not access the saved EPG caches.".to_string())?
        .clone()
        .unwrap_or_default();
    EpgDiskStore::new(path.to_path_buf()).write(&snapshot)
}

#[derive(Debug, PartialEq, Eq)]
enum EpgRefreshCommit {
    Committed,
    DeadlineExpired,
    Superseded,
}

fn commit_epg_refresh_if_current<F>(
    path: &Path,
    state: &EpgState,
    source_url: &str,
    generation: u64,
    cache: EpgCache,
    may_commit: F,
) -> Result<EpgRefreshCommit, String>
where
    F: FnOnce() -> bool,
{
    let _write_guard = state
        .disk_writes
        .lock()
        .map_err(|_| "Could not coordinate the EPG cache write.".to_string())?;
    let generations = state
        .generations
        .lock()
        .map_err(|_| "Could not coordinate the EPG refresh.".to_string())?;
    if !generations.accept_refresh(source_url, generation) {
        return Ok(EpgRefreshCommit::Superseded);
    }
    if !may_commit() {
        return Ok(EpgRefreshCommit::DeadlineExpired);
    }

    let mut cache_guard = state
        .caches
        .lock()
        .map_err(|_| "Could not save the in-memory EPG cache.".to_string())?;
    let caches = cache_guard
        .as_mut()
        .ok_or_else(|| "Could not initialize the in-memory EPG cache store.".to_string())?;
    let mut snapshot = caches.clone();
    snapshot.insert(source_url.to_string(), cache.clone());
    EpgDiskStore::new(path.to_path_buf()).write(&snapshot)?;
    caches.insert(source_url.to_string(), cache);
    Ok(EpgRefreshCommit::Committed)
}

fn read_epg_caches_from_disk<R: Runtime>(app: &AppHandle<R>) -> Result<EpgDiskRead, String> {
    EpgDiskStore::new(get_epg_cache_path(app)?).read()
}

fn ensure_epg_caches_loaded<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, EpgState>,
) -> Result<(), String> {
    {
        let cache_guard = state
            .caches
            .lock()
            .map_err(|_| "Could not access the saved EPG caches.".to_string())?;
        if cache_guard.is_some() {
            return Ok(());
        }
    }

    state.install_disk_read(read_epg_caches_from_disk(app)?)
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
    let next_index = programmes.partition_point(|programme| programme.start_ms <= now_ms);

    if let Some(current_index) = next_index.checked_sub(1) {
        let programme = &programmes[current_index];
        let inferred_stop = programme.stop_ms.or_else(|| {
            programmes
                .get(current_index + 1)
                .map(|candidate| candidate.start_ms)
        });

        if inferred_stop.is_none_or(|stop_ms| now_ms < stop_ms) {
            return (
                Some(programme_to_summary(programme)),
                programmes.get(current_index + 1).map(programme_to_summary),
            );
        }
    }

    (None, programmes.get(next_index).map(programme_to_summary))
}

fn get_programmes_for_window(
    programmes: &[EpgProgramme],
    window_start_ms: i64,
    window_end_ms: i64,
) -> Vec<EpgProgrammeSummary> {
    let mut matching_programmes = Vec::new();

    for (index, programme) in programmes.iter().enumerate() {
        let inferred_stop_ms = programme
            .stop_ms
            .or_else(|| {
                programmes
                    .get(index + 1)
                    .map(|candidate| candidate.start_ms)
            })
            .unwrap_or(window_end_ms);

        if programme.start_ms >= window_end_ms {
            break;
        }

        if inferred_stop_ms <= window_start_ms {
            continue;
        }

        matching_programmes.push(programme_to_summary(programme));
    }

    matching_programmes
}

#[tauri::command]
pub async fn refresh_epg_cache(
    app: AppHandle,
    state: State<'_, EpgState>,
    url: String,
) -> Result<EpgDirectoryResponse, String> {
    let normalized_url = normalize_epg_url_input(&url)?;
    let normalized_url_text = normalized_url.to_string();
    ensure_epg_caches_loaded(&app, &state)?;
    let generation = state
        .generations
        .lock()
        .map_err(|_| "Could not coordinate the EPG refresh.".to_string())?
        .begin_refresh(&normalized_url_text);
    let client = build_http_client()?;
    let source_for_work = normalized_url.clone();
    let deadline = Instant::now() + Duration::from_secs(TOTAL_REFRESH_TIMEOUT_SECS);
    let work = async move {
        let (body, content_type) = fetch_bytes_with_limit(
            &client,
            normalized_url,
            MAX_EPG_DOWNLOAD_BYTES,
            "Could not download the EPG file",
        )
        .await?;
        tauri::async_runtime::spawn_blocking(move || {
            let xml = decode_epg_bytes(body, &source_for_work, content_type.as_deref())?;
            parse_xmltv_document(source_for_work.to_string(), xml)
        })
        .await
        .map_err(|error| format!("Could not process the EPG file: {error}"))?
    };
    let cache = tokio::time::timeout(Duration::from_secs(TOTAL_REFRESH_TIMEOUT_SECS), work)
        .await
        .map_err(|_| "The EPG refresh exceeded its total time limit.".to_string())??;
    let response = cache.directory_response();
    let path = get_epg_cache_path(&app)?;
    let app_for_write = app.clone();
    let source_for_write = normalized_url_text.clone();

    // The deadline applies only to cancellable network and pure parsing work. The
    // commit closure rechecks both deadline and generation while holding the disk
    // and generation locks; after it starts writing, we await its durable result.
    let commit = tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_write.state::<EpgState>();
        commit_epg_refresh_if_current(
            &path,
            state.inner(),
            &source_for_write,
            generation,
            cache,
            || Instant::now() < deadline,
        )
    })
    .await
    .map_err(|error| format!("Could not save the EPG cache: {error}"))??;

    match commit {
        EpgRefreshCommit::Committed => Ok(response),
        EpgRefreshCommit::DeadlineExpired => {
            Err("The EPG refresh exceeded its total time limit.".to_string())
        }
        EpgRefreshCommit::Superseded => {
            Err("This EPG refresh was superseded by a newer operation.".to_string())
        }
    }
}

#[tauri::command]
pub fn load_epg_cache_directories(
    app: AppHandle,
    state: State<'_, EpgState>,
) -> Result<Vec<EpgDirectoryResponse>, String> {
    ensure_epg_caches_loaded(&app, &state)?;

    let cache_guard = state
        .caches
        .lock()
        .map_err(|_| "Could not access the saved EPG cache.".to_string())?;
    let Some(caches) = cache_guard.as_ref() else {
        return Ok(Vec::new());
    };

    let mut directories = caches
        .values()
        .map(EpgCache::directory_response)
        .collect::<Vec<_>>();
    directories.sort_by(|left, right| left.source_url.cmp(&right.source_url));
    Ok(directories)
}

#[tauri::command]
#[allow(dead_code)] // Registration is intentionally owned by src-tauri/src/lib.rs.
pub fn get_epg_cache_diagnostics(
    app: AppHandle,
    state: State<'_, EpgState>,
) -> Result<EpgCacheDiagnostics, String> {
    ensure_epg_caches_loaded(&app, &state)?;
    state.cache_diagnostics()
}

#[tauri::command]
pub fn delete_epg_cache(
    app: AppHandle,
    state: State<'_, EpgState>,
    url: String,
) -> Result<bool, String> {
    let normalized_url = normalize_epg_url_input(&url)?.to_string();
    ensure_epg_caches_loaded(&app, &state)?;

    let did_remove = {
        let mut generations = state
            .generations
            .lock()
            .map_err(|_| "Could not coordinate the EPG deletion.".to_string())?;
        generations.delete(&normalized_url);
        let mut cache_guard = state
            .caches
            .lock()
            .map_err(|_| "Could not access the saved EPG cache.".to_string())?;
        let caches = cache_guard
            .as_mut()
            .ok_or_else(|| "Could not initialize the in-memory EPG cache store.".to_string())?;
        caches.remove(&normalized_url).is_some()
    };

    if did_remove {
        let path = get_epg_cache_path(&app)?;
        persist_epg_snapshot(&path, state.inner())?;
    }

    Ok(did_remove)
}

#[tauri::command]
pub fn get_epg_programme_snapshots(
    app: AppHandle,
    state: State<'_, EpgState>,
    epg_channel_keys: Vec<String>,
    at_ms: Option<i64>,
) -> Result<Vec<EpgProgrammeSnapshot>, String> {
    ensure_epg_caches_loaded(&app, &state)?;

    let now_ms = at_ms.unwrap_or_else(|| Utc::now().timestamp_millis());
    let cache_guard = state
        .caches
        .lock()
        .map_err(|_| "Could not access the saved EPG cache.".to_string())?;
    let Some(caches) = cache_guard.as_ref() else {
        return Ok(Vec::new());
    };

    let mut seen_channel_keys = HashSet::new();
    let mut snapshots = Vec::new();

    for epg_channel_key in epg_channel_keys {
        let Some((source_url, channel_id)) = split_epg_channel_key(&epg_channel_key) else {
            continue;
        };
        let normalized_url = normalize_epg_url_input(&source_url)?.to_string();
        let unique_channel_key = create_epg_channel_key(&normalized_url, &channel_id);

        if !seen_channel_keys.insert(unique_channel_key.clone()) {
            continue;
        }

        let Some(cache) = caches.get(&normalized_url) else {
            continue;
        };

        let Some(programmes) = cache.programmes_by_channel.get(&channel_id) else {
            continue;
        };

        let (current, next) = get_programme_snapshots_for_channel(programmes, now_ms);

        snapshots.push(EpgProgrammeSnapshot {
            epg_channel_key: unique_channel_key,
            current,
            next,
        });
    }

    Ok(snapshots)
}

#[tauri::command]
pub fn get_epg_programme_windows(
    app: AppHandle,
    state: State<'_, EpgState>,
    epg_channel_keys: Vec<String>,
    window_start_ms: i64,
    window_end_ms: i64,
) -> Result<Vec<EpgProgrammeWindow>, String> {
    if window_end_ms <= window_start_ms {
        return Err("The guide window is not valid.".to_string());
    }

    ensure_epg_caches_loaded(&app, &state)?;

    let cache_guard = state
        .caches
        .lock()
        .map_err(|_| "Could not access the saved EPG cache.".to_string())?;
    let Some(caches) = cache_guard.as_ref() else {
        return Ok(Vec::new());
    };

    let mut seen_channel_keys = HashSet::new();
    let mut windows = Vec::new();

    for epg_channel_key in epg_channel_keys {
        let Some((source_url, channel_id)) = split_epg_channel_key(&epg_channel_key) else {
            continue;
        };
        let normalized_url = normalize_epg_url_input(&source_url)?.to_string();
        let unique_channel_key = create_epg_channel_key(&normalized_url, &channel_id);

        if !seen_channel_keys.insert(unique_channel_key.clone()) {
            continue;
        }

        let Some(cache) = caches.get(&normalized_url) else {
            continue;
        };

        let Some(programmes) = cache.programmes_by_channel.get(&channel_id) else {
            continue;
        };

        windows.push(EpgProgrammeWindow {
            epg_channel_key: unique_channel_key,
            programmes: get_programmes_for_window(programmes, window_start_ms, window_end_ms),
        });
    }

    Ok(windows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(0);
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new(name: &str) -> Self {
            let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("onyx-epg-{name}-{}-{id}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn xml(programmes: &str) -> Vec<u8> {
        format!(r#"<?xml version="1.0"?><tv><channel id="one"><display-name>One</display-name></channel>{programmes}</tv>"#).into_bytes()
    }

    #[test]
    fn epg_url_fragments_do_not_change_source_identity() {
        let without_fragment = normalize_epg_url_input("https://example.test/guide.xml").unwrap();
        let fragment_one = normalize_epg_url_input("https://example.test/guide.xml#one").unwrap();
        let fragment_two = normalize_epg_url_input("https://example.test/guide.xml#two").unwrap();

        assert_eq!(fragment_one, without_fragment);
        assert_eq!(fragment_two, without_fragment);
    }

    #[test]
    fn epg_url_identity_preserves_case_sensitive_path_and_query() {
        let baseline = normalize_epg_url_input("https://example.test/Guide.xml?Token=AbC").unwrap();
        let different_path =
            normalize_epg_url_input("https://example.test/guide.xml?Token=AbC").unwrap();
        let different_query_name =
            normalize_epg_url_input("https://example.test/Guide.xml?token=AbC").unwrap();
        let different_query_value =
            normalize_epg_url_input("https://example.test/Guide.xml?Token=abc").unwrap();

        assert_ne!(baseline, different_path);
        assert_ne!(baseline, different_query_name);
        assert_ne!(baseline, different_query_value);
    }

    #[test]
    fn epg_url_identity_keeps_existing_scheme_host_and_default_port_canonicalization() {
        let http =
            normalize_epg_url_input("XMLTV: HTTP://EXAMPLE.TEST:80/Guide.xml?Token=AbC#ignored")
                .unwrap();
        let https = normalize_epg_url_input("https://EXAMPLE.TEST:443/Guide.xml?Token=AbC#ignored")
            .unwrap();

        assert_eq!(http.as_str(), "http://example.test/Guide.xml?Token=AbC");
        assert_eq!(https.as_str(), "https://example.test/Guide.xml?Token=AbC");
        assert_ne!(http, https);
    }

    #[test]
    fn epg_url_errors_do_not_expose_url_secrets() {
        let invalid = normalize_epg_url_input("https://user:password@[::1?token=secret")
            .expect_err("the malformed URL must be rejected");
        let unsupported =
            normalize_epg_url_input("ftp://user:password@example.test/guide?token=secret")
                .expect_err("the unsupported URL scheme must be rejected");

        assert_eq!(invalid, "The EPG URL is not valid.");
        assert_eq!(unsupported, "Only http and https EPG URLs are supported.");
    }

    #[test]
    fn gzip_is_selected_only_by_magic_bytes_and_decoded_once() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let plain = xml(
            r#"<programme channel="one" start="20260101000000 +0000"><title>A</title></programme>"#,
        );
        let hinted_url = Url::parse("https://example.test/guide.xml.gz").unwrap();
        assert_eq!(
            decode_epg_bytes(plain.clone(), &hinted_url, Some("application/gzip")).unwrap(),
            plain
        );
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&plain).unwrap();
        let compressed = encoder.finish().unwrap();
        let decoded = decode_epg_bytes(compressed, &hinted_url, None).unwrap();
        assert_eq!(decoded, plain);
        assert_eq!(
            decode_epg_bytes(decoded.clone(), &hinted_url, Some("application/gzip")).unwrap(),
            decoded
        );
    }

    #[test]
    fn gzip_truncation_and_decoded_limit_are_rejected() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&[b'x'; 128]).unwrap();
        let compressed = encoder.finish().unwrap();
        assert!(decode_gzip_with_limit(&compressed, 64)
            .unwrap_err()
            .contains("too large"));
        assert!(decode_gzip_with_limit(&compressed[..compressed.len() - 3], 256).is_err());
    }

    #[test]
    fn malformed_programmes_are_skipped_without_losing_neighbors_and_warnings_are_capped() {
        let mut programmes = String::from(
            r#"<programme channel="one" start="20260101000000 +0000"><title>Before</title></programme>"#,
        );
        for _ in 0..20 {
            programmes.push_str(
                r#"<programme channel="one" start="not-a-time"><title>Bad</title></programme>"#,
            );
        }
        programmes.push_str(r#"<programme channel="one" start="20260101020000 +0000"><title>After</title></programme>"#);
        let cache = parse_xmltv_document(
            "https://example.test/secret?token=nope".into(),
            xml(&programmes),
        )
        .unwrap();
        let retained = &cache.programmes_by_channel["one"];
        assert_eq!(
            retained
                .iter()
                .map(|item| item.title.as_str())
                .collect::<Vec<_>>(),
            ["Before", "After"]
        );
        assert_eq!(cache.skipped_programme_count, 20);
        assert_eq!(cache.warnings.len(), MAX_WARNING_SAMPLES);
        assert!(cache
            .warnings
            .iter()
            .all(|warning| !warning.contains("secret") && !warning.contains("nope")));
    }

    fn sample_store(source: &str) -> HashMap<String, EpgCache> {
        let cache = parse_xmltv_document(source.into(), xml(r#"<programme channel="one" start="20260101000000 +0000"><title>A</title></programme>"#)).unwrap();
        HashMap::from([(source.to_string(), cache)])
    }

    #[test]
    fn corrupt_primary_recovers_backup_and_both_corrupt_become_empty_diagnostics() {
        let directory = TestDirectory::new("recovery");
        let path = directory.0.join("cache.json");
        let store = EpgDiskStore::new(path.clone());
        store
            .write(&sample_store("https://one.test/guide"))
            .unwrap();
        store
            .write(&sample_store("https://two.test/guide"))
            .unwrap();
        fs::write(&path, b"broken").unwrap();
        let recovered = store.read().unwrap();
        assert!(recovered.recovered && recovered.corrupt);
        assert!(recovered.caches.contains_key("https://one.test/guide"));
        fs::write(&path, b"broken again").unwrap();
        fs::write(store.backup_path(), b"also broken").unwrap();
        let empty = store.read().unwrap();
        assert!(empty.caches.is_empty());
        assert!(empty.corrupt);
        assert!(!empty.warnings.is_empty());
    }

    #[test]
    fn oversized_cache_is_removed_and_reported_as_corrupt() {
        let directory = TestDirectory::new("oversized");
        let path = directory.0.join("cache.json");
        File::create(&path)
            .unwrap()
            .set_len(MAX_EPG_CACHE_BYTES as u64 + 1)
            .unwrap();
        let outcome = EpgDiskStore::new(path.clone()).read().unwrap();
        assert!(outcome.caches.is_empty());
        assert!(outcome.corrupt);
        assert!(!path.exists());
    }

    #[test]
    fn backup_recovery_survives_a_failed_primary_repair() {
        let directory = TestDirectory::new("repair-failure");
        let path = directory.0.join("cache.json");
        let store = EpgDiskStore::new(path.clone());
        store
            .write(&sample_store("https://one.test/guide"))
            .unwrap();
        store
            .write(&sample_store("https://two.test/guide"))
            .unwrap();
        fs::write(&path, b"broken").unwrap();

        let recovered = store
            .read_with_repair(|_, _| Err("simulated repair failure".to_string()))
            .expect("a failed best-effort repair must not discard a valid backup");

        assert!(recovered.recovered && recovered.corrupt);
        assert!(recovered.caches.contains_key("https://one.test/guide"));
        assert!(recovered.warnings.len() <= MAX_WARNING_SAMPLES);
        assert!(recovered
            .warnings
            .iter()
            .any(|warning| warning.contains("could not be repaired")));
    }

    #[test]
    fn empty_store_recovery_diagnostics_are_preserved_in_state() {
        let state = EpgState::default();
        state
            .install_disk_read(EpgDiskRead {
                caches: HashMap::new(),
                recovered: false,
                corrupt: true,
                warnings: vec!["The saved EPG cache was corrupt.".to_string()],
            })
            .unwrap();

        let diagnostics = state.cache_diagnostics().unwrap();
        assert!(!diagnostics.recovered);
        assert!(diagnostics.corrupt);
        assert_eq!(
            diagnostics.warnings,
            ["The saved EPG cache was corrupt.".to_string()]
        );
        assert!(state.caches.lock().unwrap().as_ref().unwrap().is_empty());
    }

    #[test]
    fn expired_refresh_does_not_commit_to_memory_or_disk() {
        let directory = TestDirectory::new("expired-before-commit");
        let path = directory.0.join("cache.json");
        let state = EpgState::default();
        let source = "https://one.test/guide";
        let generation = state.generations.lock().unwrap().begin_refresh(source);
        *state.caches.lock().unwrap() = Some(HashMap::new());
        let cache = sample_store(source).remove(source).unwrap();

        let outcome =
            commit_epg_refresh_if_current(&path, &state, source, generation, cache, || false)
                .unwrap();

        assert_eq!(outcome, EpgRefreshCommit::DeadlineExpired);
        assert!(state.caches.lock().unwrap().as_ref().unwrap().is_empty());
        assert!(!path.exists());
        std::thread::sleep(Duration::from_millis(20));
        assert!(state.caches.lock().unwrap().as_ref().unwrap().is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn generations_make_latest_refresh_win_and_delete_tombstones_inflight_refresh() {
        let mut generations = GenerationRegistry::default();
        let first = generations.begin_refresh("u");
        let second = generations.begin_refresh("u");
        assert!(!generations.accept_refresh("u", first));
        assert!(generations.accept_refresh("u", second));
        let inflight = generations.begin_refresh("u");
        generations.delete("u");
        assert!(!generations.accept_refresh("u", inflight));
    }

    #[test]
    fn persistence_rechecks_generation_after_serializing_concurrent_writes() {
        let directory = TestDirectory::new("latest-persistence");
        let path = directory.0.join("cache.json");
        let state = EpgState::default();
        let source = "https://one.test/guide";
        let stale_generation = state.generations.lock().unwrap().begin_refresh(source);
        state.generations.lock().unwrap().begin_refresh(source);
        *state.caches.lock().unwrap() = Some(HashMap::new());
        let cache = sample_store(source).remove(source).unwrap();

        assert_eq!(
            commit_epg_refresh_if_current(&path, &state, source, stale_generation, cache, || true,)
                .unwrap(),
            EpgRefreshCommit::Superseded
        );
        assert!(state.caches.lock().unwrap().as_ref().unwrap().is_empty());
        assert!(!path.exists());
    }
}
