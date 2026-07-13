mod epg;
mod persistence;

use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::Value;
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime, State};
use tokio_util::sync::CancellationToken;

const MAX_PLAYLIST_BYTES: usize = 32 * 1024 * 1024;
const MAX_XTREAM_BYTES: usize = 32 * 1024 * 1024;
const CONNECT_TIMEOUT_SECS: u64 = 15;
const READ_TIMEOUT_SECS: u64 = 45;
const PLAYLIST_OPERATION_TIMEOUT_SECS: u64 = 90;
const MAX_PLAYLIST_OPERATION_ID_BYTES: usize = 128;
const PLAYLIST_TIMEOUT_MESSAGE: &str = "The playlist import timed out.";
const PLAYLIST_CANCELLED_MESSAGE: &str = "The playlist import was cancelled.";
const INVALID_PLAYLIST_OPERATION_ID_MESSAGE: &str = "The playlist operation id is not valid.";
const DUPLICATE_PLAYLIST_OPERATION_ID_MESSAGE: &str = "The playlist operation is already running.";
const APP_STATE_DIRECTORY: &str = "state";
const XTREAM_SECRET_SERVICE_PROD: &str = "Onyx Xtream";
const XTREAM_SECRET_SERVICE_DEV: &str = "Onyx Dev Xtream";
const M3U_URL_SECRET_SERVICE_PROD: &str = "Onyx M3U URL";
const M3U_URL_SECRET_SERVICE_DEV: &str = "Onyx Dev M3U URL";
const EPG_URL_SECRET_SERVICE_PROD: &str = "Onyx EPG URL";
const EPG_URL_SECRET_SERVICE_DEV: &str = "Onyx Dev EPG URL";
const XTREAM_SECRET_SERVICE: &str = if cfg!(debug_assertions) {
    XTREAM_SECRET_SERVICE_DEV
} else {
    XTREAM_SECRET_SERVICE_PROD
};
const M3U_URL_SECRET_SERVICE: &str = if cfg!(debug_assertions) {
    M3U_URL_SECRET_SERVICE_DEV
} else {
    M3U_URL_SECRET_SERVICE_PROD
};
const EPG_URL_SECRET_SERVICE: &str = if cfg!(debug_assertions) {
    EPG_URL_SECRET_SERVICE_DEV
} else {
    EPG_URL_SECRET_SERVICE_PROD
};
const INVALID_M3U_URL_MESSAGE: &str = "The playlist URL is not valid.";
const UNSUPPORTED_M3U_URL_SCHEME_MESSAGE: &str = "Only http and https playlist URLs are supported.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct XtreamChannelPayload {
    name: String,
    group: String,
    stream: String,
    is_direct_source: bool,
    logo: Option<String>,
    tvg_id: Option<String>,
    tvg_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct XtreamImportResponse {
    provider_name: String,
    channels: Vec<XtreamChannelPayload>,
}

#[derive(Clone, Default)]
struct PlaylistOperationRegistry {
    operations: Arc<Mutex<HashMap<String, Arc<CancellationToken>>>>,
}

struct RegisteredPlaylistOperation {
    registry: PlaylistOperationRegistry,
    operation_id: String,
    token: Arc<CancellationToken>,
}

impl Drop for RegisteredPlaylistOperation {
    fn drop(&mut self) {
        if let Ok(mut operations) = self.registry.operations.lock() {
            if operations
                .get(&self.operation_id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.token))
            {
                operations.remove(&self.operation_id);
            }
        }
    }
}

fn validate_playlist_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty()
        || operation_id.len() > MAX_PLAYLIST_OPERATION_ID_BYTES
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(INVALID_PLAYLIST_OPERATION_ID_MESSAGE.to_string());
    }
    Ok(())
}

impl PlaylistOperationRegistry {
    fn register(&self, operation_id: &str) -> Result<RegisteredPlaylistOperation, String> {
        validate_playlist_operation_id(operation_id)?;
        let token = Arc::new(CancellationToken::new());
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| "Could not initialize the playlist operation.".to_string())?;
        if operations.contains_key(operation_id) {
            return Err(DUPLICATE_PLAYLIST_OPERATION_ID_MESSAGE.to_string());
        }
        operations.insert(operation_id.to_string(), token.clone());
        Ok(RegisteredPlaylistOperation {
            registry: self.clone(),
            operation_id: operation_id.to_string(),
            token,
        })
    }

    fn cancel(&self, operation_id: &str) -> Result<bool, String> {
        validate_playlist_operation_id(operation_id)?;
        let token = self
            .operations
            .lock()
            .map_err(|_| "Could not cancel the playlist operation.".to_string())?
            .get(operation_id)
            .cloned();
        if let Some(token) = token {
            token.cancel();
            return Ok(true);
        }
        Ok(false)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.operations
            .lock()
            .map(|operations| operations.len())
            .unwrap_or(0)
    }
}

async fn run_playlist_operation<T, F, Fut>(
    registry: &PlaylistOperationRegistry,
    operation_id: &str,
    deadline: Duration,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce(CancellationToken) -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let registered = registry.register(operation_id)?;
    let token = registered.token.clone();
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(PLAYLIST_CANCELLED_MESSAGE.to_string()),
        result = tokio::time::timeout(deadline, operation(token.as_ref().clone())) => match result {
            Ok(result) => result,
            Err(_) => Err(PLAYLIST_TIMEOUT_MESSAGE.to_string()),
        },
    }
}

#[tauri::command]
fn cancel_playlist_operation(
    registry: State<'_, PlaylistOperationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    registry.cancel(&operation_id).map(|_| ())
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(READ_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("onyx/0.1")
        .build()
        .map_err(|error| format!("Could not initialize the network client: {error}"))
}

fn validate_source_id(source_id: &str) -> Result<(), String> {
    if source_id.is_empty() || source_id.len() > 160 {
        return Err("The source id is not valid.".to_string());
    }

    if source_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_' | b'.'))
    {
        return Ok(());
    }

    Err("The source id contains unsupported characters.".to_string())
}

fn map_secret_error(error: keyring::Error) -> String {
    format!("Could not access the OS credential store: {error}")
}

fn get_xtream_secret_entry(source_id: &str) -> Result<keyring::Entry, String> {
    validate_source_id(source_id)?;
    keyring::Entry::new(XTREAM_SECRET_SERVICE, source_id).map_err(map_secret_error)
}

fn get_m3u_url_secret_entry(source_id: &str) -> Result<keyring::Entry, String> {
    validate_source_id(source_id)?;
    keyring::Entry::new(M3U_URL_SECRET_SERVICE, source_id).map_err(map_secret_error)
}

fn get_epg_url_secret_entry(source_id: &str) -> Result<keyring::Entry, String> {
    validate_source_id(source_id)?;
    keyring::Entry::new(EPG_URL_SECRET_SERVICE, source_id)
        .map_err(|_| "Could not access the OS credential store.".to_string())
}

fn validate_epg_url_for_storage(url: &str) -> Result<String, String> {
    const INVALID: &str = "The EPG URL is not valid.";
    const UNSUPPORTED: &str = "Only http and https EPG URLs are supported.";
    let trimmed = url.trim();
    let normalized = trimmed
        .strip_prefix("XMLTV:")
        .or_else(|| trimmed.strip_prefix("xmltv:"))
        .unwrap_or(trimmed)
        .trim();
    if normalized.is_empty() {
        return Err(INVALID.to_string());
    }
    let parsed = Url::parse(normalized).map_err(|_| INVALID.to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(normalized.to_string()),
        _ => Err(UNSUPPORTED.to_string()),
    }
}

fn validate_m3u_url_for_storage(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(INVALID_M3U_URL_MESSAGE.to_string());
    }
    let parsed = Url::parse(trimmed).map_err(|_| INVALID_M3U_URL_MESSAGE.to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.to_string()),
        _ => Err(UNSUPPORTED_M3U_URL_SCHEME_MESSAGE.to_string()),
    }
}

fn get_app_state_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .resolve(APP_STATE_DIRECTORY, BaseDirectory::AppLocalData)
        .map_err(|error| format!("Could not resolve the app state path: {error}"))
}

#[tauri::command]
fn load_app_state(app: AppHandle, key: String) -> Result<persistence::ReadOutcome, String> {
    persistence::Store::new(get_app_state_directory(&app)?).read(&key)
}

#[tauri::command]
fn save_app_state(app: AppHandle, key: String, mut value: Value) -> Result<(), String> {
    scrub_saved_source_secrets(&key, &mut value);
    persistence::Store::new(get_app_state_directory(&app)?).write(&key, &value)
}

fn scrub_saved_source_secrets(key: &str, value: &mut Value) {
    if key != "iptv-player:saved-sources" {
        return;
    }
    scrub_saved_source_value(value);
}

fn scrub_saved_source_value(value: &mut Value) {
    match value {
        Value::Object(object) => {
            match object.get("kind").and_then(Value::as_str) {
                Some("xtream") => {
                    if let Some(password) = object.get_mut("password") {
                        *password = Value::String(String::new());
                    }
                }
                Some("m3u_url") => {
                    if let Some(url) = object.get_mut("url") {
                        *url = Value::String(String::new());
                    }
                }
                _ => {}
            }
            for child in object.values_mut() {
                scrub_saved_source_value(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                scrub_saved_source_value(child);
            }
        }
        _ => {}
    }
}

#[tauri::command]
fn load_xtream_password(source_id: String) -> Result<Option<String>, String> {
    let entry = get_xtream_secret_entry(&source_id)?;

    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(map_secret_error(error)),
    }
}

#[tauri::command]
fn save_xtream_password(source_id: String, password: String) -> Result<(), String> {
    let entry = get_xtream_secret_entry(&source_id)?;

    if password.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_secret_error(error)),
        };
    }

    entry.set_password(&password).map_err(map_secret_error)
}

#[tauri::command]
fn delete_xtream_password(source_id: String) -> Result<(), String> {
    let entry = get_xtream_secret_entry(&source_id)?;

    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(map_secret_error(error)),
    }
}

#[tauri::command]
fn load_m3u_url(source_id: String) -> Result<Option<String>, String> {
    let entry = get_m3u_url_secret_entry(&source_id)?;
    match entry.get_password() {
        Ok(url) => Ok(Some(url)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(map_secret_error(error)),
    }
}

#[tauri::command]
fn save_m3u_url(source_id: String, url: String) -> Result<(), String> {
    let validated_url = validate_m3u_url_for_storage(&url)?;
    get_m3u_url_secret_entry(&source_id)?
        .set_password(&validated_url)
        .map_err(map_secret_error)
}

#[tauri::command]
fn delete_m3u_url(source_id: String) -> Result<(), String> {
    let entry = get_m3u_url_secret_entry(&source_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(map_secret_error(error)),
    }
}

#[tauri::command]
fn load_epg_url(source_id: String) -> Result<Option<String>, String> {
    let entry = get_epg_url_secret_entry(&source_id)?;
    match entry.get_password() {
        Ok(url) => Ok(Some(url)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not access the OS credential store.".to_string()),
    }
}

#[tauri::command]
fn save_epg_url(source_id: String, url: String) -> Result<(), String> {
    let url = validate_epg_url_for_storage(&url)?;
    get_epg_url_secret_entry(&source_id)?
        .set_password(&url)
        .map_err(|_| "Could not access the OS credential store.".to_string())
}

#[tauri::command]
fn delete_epg_url(source_id: String) -> Result<(), String> {
    let entry = get_epg_url_secret_entry(&source_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not access the OS credential store.".to_string()),
    }
}

fn normalize_playlist_url_input(raw_input: &str) -> Result<Url, String> {
    let trimmed_input = raw_input.trim();
    let normalized_input = trimmed_input
        .strip_prefix("M3U:")
        .or_else(|| trimmed_input.strip_prefix("m3u:"))
        .unwrap_or(trimmed_input)
        .trim();

    if normalized_input.is_empty() {
        return Err("Enter a playlist URL first.".to_string());
    }

    let parsed_url =
        Url::parse(normalized_input).map_err(|_| "The playlist URL is not valid.".to_string())?;

    match parsed_url.scheme() {
        "http" | "https" => Ok(parsed_url),
        _ => Err("Only http and https playlist URLs are supported.".to_string()),
    }
}

fn normalize_xtream_domain_input(raw_input: &str) -> Result<Url, String> {
    let trimmed_input = raw_input.trim().trim_end_matches('/');

    if trimmed_input.is_empty() {
        return Err("Enter the Xtream domain first.".to_string());
    }

    let normalized_input =
        if trimmed_input.starts_with("http://") || trimmed_input.starts_with("https://") {
            trimmed_input.to_string()
        } else {
            format!("http://{trimmed_input}")
        };

    let mut parsed_url =
        Url::parse(&normalized_input).map_err(|_| "The Xtream domain is not valid.".to_string())?;

    match parsed_url.scheme() {
        "http" | "https" => {}
        _ => return Err("Xtream domain must use http or https.".to_string()),
    }

    parsed_url.set_query(None);
    parsed_url.set_fragment(None);

    if !parsed_url.path().ends_with('/') {
        let new_path = if parsed_url.path().is_empty() {
            "/".to_string()
        } else {
            format!("{}/", parsed_url.path().trim_end_matches('/'))
        };
        parsed_url.set_path(&new_path);
    }

    Ok(parsed_url)
}

async fn fetch_text_with_limit(
    client: &Client,
    url: Url,
    byte_limit: usize,
    failure_label: &str,
) -> Result<String, String> {
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
            return Err("The response is too large to import safely.".to_string());
        }
    }

    let mut body = Vec::new();

    while let Some(chunk) = response.chunk().await.map_err(|error| {
        format!(
            "Could not read the server response: {}",
            error.without_url()
        )
    })? {
        if body.len() + chunk.len() > byte_limit {
            return Err("The response is too large to import safely.".to_string());
        }

        body.extend_from_slice(&chunk);
    }

    let response_text = String::from_utf8_lossy(&body).into_owned();

    if response_text.trim().is_empty() {
        return Err("The server returned an empty response.".to_string());
    }

    Ok(response_text)
}

fn get_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = text.trim();

            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::Bool(boolean)) => Some(boolean.to_string()),
        _ => None,
    }
}

fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(boolean)) => *boolean,
        Some(Value::Number(number)) => number.as_i64().unwrap_or_default() != 0,
        Some(Value::String(text)) => matches!(text.trim(), "1" | "true" | "True" | "yes"),
        _ => false,
    }
}

fn get_required_object<'a>(value: &'a Value, key: &str) -> Result<&'a Value, String> {
    value
        .get(key)
        .ok_or_else(|| format!("The provider response is missing `{key}`."))
}

fn build_player_api_url(
    base_url: &Url,
    username: &str,
    password: &str,
    action: Option<&str>,
) -> Result<Url, String> {
    let mut url = base_url
        .join("player_api.php")
        .map_err(|_| "Could not build the Xtream API URL.".to_string())?;

    {
        let mut query = url.query_pairs_mut();
        query.append_pair("username", username);
        query.append_pair("password", password);

        if let Some(action_name) = action {
            query.append_pair("action", action_name);
        }
    }

    Ok(url)
}

fn choose_output_extension(auth_response: &Value) -> String {
    let Some(formats) = auth_response
        .get("user_info")
        .and_then(|user_info| user_info.get("allowed_output_formats"))
        .and_then(Value::as_array)
    else {
        return "ts".to_string();
    };

    let available_formats = formats
        .iter()
        .filter_map(|item| item.as_str())
        .collect::<Vec<_>>();

    if available_formats.contains(&"ts") {
        "ts".to_string()
    } else if available_formats.contains(&"m3u8") {
        "m3u8".to_string()
    } else {
        available_formats
            .first()
            .copied()
            .unwrap_or("ts")
            .to_string()
    }
}

fn build_stream_origin(auth_response: &Value, fallback_url: &Url) -> Result<Url, String> {
    let server_info = get_required_object(auth_response, "server_info")?;
    let scheme = get_string(server_info.get("server_protocol"))
        .unwrap_or_else(|| fallback_url.scheme().to_string());
    let host = get_string(server_info.get("url"))
        .or_else(|| fallback_url.host_str().map(str::to_string))
        .ok_or_else(|| "The provider response is missing the stream host.".to_string())?;

    let port_key = if scheme == "https" {
        "https_port"
    } else {
        "port"
    };
    let port = get_string(server_info.get(port_key))
        .and_then(|value| value.parse::<u16>().ok())
        .or_else(|| fallback_url.port());

    let mut origin = format!("{scheme}://{host}");

    if let Some(port_number) = port {
        let is_default_port =
            (scheme == "http" && port_number == 80) || (scheme == "https" && port_number == 443);

        if !is_default_port {
            origin.push_str(&format!(":{port_number}"));
        }
    }

    let mut origin_url =
        Url::parse(&origin).map_err(|_| "The provider stream origin is invalid.".to_string())?;
    origin_url.set_path("/");
    Ok(origin_url)
}

fn build_xtream_stream_url(
    stream_origin: &Url,
    username: &str,
    password: &str,
    stream_id: &str,
    extension: &str,
) -> Result<String, String> {
    let mut url = stream_origin.clone();
    let file_name = format!("{stream_id}.{extension}");
    let mut path_segments = url
        .path_segments_mut()
        .map_err(|_| "Could not construct the Xtream stream URL.".to_string())?;

    path_segments.push("live");
    path_segments.push(username);
    path_segments.push(password);
    path_segments.push(&file_name);
    drop(path_segments);

    Ok(url.to_string())
}

fn choose_xtream_stream<F>(
    direct_source: Option<String>,
    build_generated_stream: F,
) -> Result<(String, bool), String>
where
    F: FnOnce() -> Result<String, String>,
{
    match direct_source {
        Some(source) => Ok((source, true)),
        None => build_generated_stream().map(|stream| (stream, false)),
    }
}

async fn fetch_playlist_from_url_inner(url: String) -> Result<String, String> {
    let normalized_url = normalize_playlist_url_input(&url)?;
    let client = build_http_client()?;

    match fetch_text_with_limit(
        &client,
        normalized_url.clone(),
        MAX_PLAYLIST_BYTES,
        "Could not download the playlist",
    )
    .await
    {
        Ok(playlist_text) => Ok(playlist_text),
        Err(error) if error == "The server returned an empty response." => {
            let hint = if normalized_url.path().ends_with("get.php")
                && normalized_url
                    .query_pairs()
                    .any(|(key, _)| key == "username")
                && normalized_url
                    .query_pairs()
                    .any(|(key, _)| key == "password")
            {
                " The provider may support Xtream login even when the M3U export is empty."
            } else {
                ""
            };

            Err(format!("The URL returned an empty playlist.{hint}"))
        }
        Err(error) => Err(error),
    }
}

async fn fetch_xtream_live_channels_inner(
    domain: String,
    username: String,
    password: String,
) -> Result<XtreamImportResponse, String> {
    let trimmed_username = username.trim();
    let trimmed_password = password.trim();

    if trimmed_username.is_empty() || trimmed_password.is_empty() {
        return Err("Xtream username and password are required.".to_string());
    }

    let normalized_domain = normalize_xtream_domain_input(&domain)?;
    let client = build_http_client()?;

    let auth_url =
        build_player_api_url(&normalized_domain, trimmed_username, trimmed_password, None)?;
    let auth_text = fetch_text_with_limit(
        &client,
        auth_url,
        MAX_XTREAM_BYTES,
        "Could not reach the Xtream login endpoint",
    )
    .await?;
    let auth_response: Value = serde_json::from_str(&auth_text)
        .map_err(|_| "The Xtream login response was not valid JSON.".to_string())?;
    let user_info = get_required_object(&auth_response, "user_info")?;

    if !is_truthy(user_info.get("auth")) {
        let provider_message = get_string(user_info.get("message")).unwrap_or_else(|| {
            get_string(user_info.get("status"))
                .unwrap_or_else(|| "authentication failed".to_string())
        });

        return Err(format!("Xtream login failed: {provider_message}."));
    }

    let categories_url = build_player_api_url(
        &normalized_domain,
        trimmed_username,
        trimmed_password,
        Some("get_live_categories"),
    )?;
    let categories_text = fetch_text_with_limit(
        &client,
        categories_url,
        MAX_XTREAM_BYTES,
        "Could not download Xtream live categories",
    )
    .await?;
    let categories_response: Value = serde_json::from_str(&categories_text)
        .map_err(|_| "The Xtream categories response was not valid JSON.".to_string())?;
    let categories = categories_response
        .as_array()
        .ok_or_else(|| "The Xtream categories response was not an array.".to_string())?;

    let mut category_map = HashMap::new();

    for category in categories {
        if let Some(category_id) = get_string(category.get("category_id")) {
            let category_name = get_string(category.get("category_name"))
                .unwrap_or_else(|| "Ungrouped".to_string());
            category_map.insert(category_id, category_name);
        }
    }

    let streams_url = build_player_api_url(
        &normalized_domain,
        trimmed_username,
        trimmed_password,
        Some("get_live_streams"),
    )?;
    let streams_text = fetch_text_with_limit(
        &client,
        streams_url,
        MAX_XTREAM_BYTES,
        "Could not download Xtream live streams",
    )
    .await?;
    let streams_response: Value = serde_json::from_str(&streams_text)
        .map_err(|_| "The Xtream streams response was not valid JSON.".to_string())?;
    let streams = streams_response
        .as_array()
        .ok_or_else(|| "The Xtream streams response was not an array.".to_string())?;

    let output_extension = choose_output_extension(&auth_response);
    let stream_origin = build_stream_origin(&auth_response, &normalized_domain)?;
    let provider_name = stream_origin.host_str().unwrap_or("Xtream").to_string();
    let mut channels = Vec::new();

    for stream in streams {
        let Some(stream_id) = get_string(stream.get("stream_id")) else {
            continue;
        };

        let channel_name =
            get_string(stream.get("name")).unwrap_or_else(|| format!("Stream {stream_id}"));
        let category_id = get_string(stream.get("category_id")).unwrap_or_default();
        let group_name = category_map
            .get(&category_id)
            .cloned()
            .unwrap_or_else(|| "Ungrouped".to_string());
        let direct_source = get_string(stream.get("direct_source"));
        let (stream_url, is_direct_source) = choose_xtream_stream(direct_source, || {
            build_xtream_stream_url(
                &stream_origin,
                trimmed_username,
                trimmed_password,
                &stream_id,
                &output_extension,
            )
        })?;

        channels.push(XtreamChannelPayload {
            name: channel_name,
            group: group_name,
            stream: stream_url,
            is_direct_source,
            logo: get_string(stream.get("stream_icon")),
            tvg_id: get_string(stream.get("epg_channel_id")),
            tvg_name: get_string(stream.get("name")),
        });
    }

    if channels.is_empty() {
        return Err("The Xtream account returned no live channels.".to_string());
    }

    Ok(XtreamImportResponse {
        provider_name,
        channels,
    })
}

#[tauri::command]
async fn fetch_playlist_from_url(
    registry: State<'_, PlaylistOperationRegistry>,
    url: String,
    operation_id: String,
) -> Result<String, String> {
    run_playlist_operation(
        &registry,
        &operation_id,
        Duration::from_secs(PLAYLIST_OPERATION_TIMEOUT_SECS),
        |_| fetch_playlist_from_url_inner(url),
    )
    .await
}

#[tauri::command]
async fn fetch_xtream_live_channels(
    registry: State<'_, PlaylistOperationRegistry>,
    domain: String,
    username: String,
    password: String,
    operation_id: String,
) -> Result<XtreamImportResponse, String> {
    run_playlist_operation(
        &registry,
        &operation_id,
        Duration::from_secs(PLAYLIST_OPERATION_TIMEOUT_SECS),
        |_| fetch_xtream_live_channels_inner(domain, username, password),
    )
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(epg::EpgState::default())
        .manage(PlaylistOperationRegistry::default())
        .plugin(tauri_plugin_libmpv::init())
        .invoke_handler(tauri::generate_handler![
            fetch_playlist_from_url,
            fetch_xtream_live_channels,
            cancel_playlist_operation,
            load_app_state,
            save_app_state,
            load_xtream_password,
            save_xtream_password,
            delete_xtream_password,
            load_m3u_url,
            save_m3u_url,
            delete_m3u_url,
            load_epg_url,
            save_epg_url,
            delete_epg_url,
            epg::refresh_epg_cache,
            epg::load_epg_cache_directories,
            epg::delete_epg_cache,
            epg::get_epg_cache_diagnostics,
            epg::get_epg_programme_snapshots,
            epg::get_epg_programme_windows
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        choose_xtream_stream, scrub_saved_source_secrets, validate_epg_url_for_storage,
        validate_m3u_url_for_storage, XtreamChannelPayload, EPG_URL_SECRET_SERVICE,
        EPG_URL_SECRET_SERVICE_DEV, EPG_URL_SECRET_SERVICE_PROD, INVALID_M3U_URL_MESSAGE,
        M3U_URL_SECRET_SERVICE, M3U_URL_SECRET_SERVICE_DEV, M3U_URL_SECRET_SERVICE_PROD,
        UNSUPPORTED_M3U_URL_SCHEME_MESSAGE, XTREAM_SECRET_SERVICE, XTREAM_SECRET_SERVICE_DEV,
        XTREAM_SECRET_SERVICE_PROD,
    };
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::{Duration, Instant},
    };

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
    }

    #[test]
    fn trickling_playlist_body_is_bounded_by_the_overall_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .expect("headers");
            for _ in 0..20 {
                if stream.write_all(b"1\r\nx\r\n").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        let registry = super::PlaylistOperationRegistry::default();
        let client = super::build_http_client().expect("client");
        let url = reqwest::Url::parse(&format!("http://{address}/list.m3u")).expect("url");
        let started = Instant::now();

        let result = test_runtime().block_on(super::run_playlist_operation(
            &registry,
            "deadline-operation",
            Duration::from_millis(75),
            |_: tokio_util::sync::CancellationToken| async move {
                super::fetch_text_with_limit(&client, url, 1024, "download failed").await
            },
        ));

        assert_eq!(result.unwrap_err(), super::PLAYLIST_TIMEOUT_MESSAGE);
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(registry.len(), 0);
        server.join().expect("server thread");
    }

    #[test]
    fn cancellation_interrupts_waiting_and_registry_is_cleaned() {
        let registry = super::PlaylistOperationRegistry::default();
        let canceller = registry.clone();
        let started = Instant::now();

        let result = test_runtime().block_on(async {
            let cancel_task = async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                assert!(canceller.cancel("cancel-operation").expect("cancel"));
            };
            let operation = super::run_playlist_operation(
                &registry,
                "cancel-operation",
                Duration::from_secs(2),
                |_: tokio_util::sync::CancellationToken| async {
                    std::future::pending::<Result<(), String>>().await
                },
            );
            let (result, ()) = tokio::join!(operation, cancel_task);
            result
        });

        assert_eq!(result.unwrap_err(), super::PLAYLIST_CANCELLED_MESSAGE);
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn operation_ids_are_validated_and_bounded_without_registry_leaks() {
        let too_long = "a".repeat(129);
        for invalid in ["", "contains space", "contains/slash", too_long.as_str()] {
            assert_eq!(
                super::validate_playlist_operation_id(invalid).unwrap_err(),
                super::INVALID_PLAYLIST_OPERATION_ID_MESSAGE,
            );
        }
        for valid in ["550e8400-e29b-41d4-a716-446655440000", "opaque_ID-42"] {
            super::validate_playlist_operation_id(valid).expect("valid opaque id");
        }

        let registry = super::PlaylistOperationRegistry::default();
        assert!(!registry
            .cancel("unknown-operation")
            .expect("valid unknown id"));
        assert_eq!(registry.len(), 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_credential_entries_build_with_native_backend_for_all_secret_types() {
        for (credential_type, entry) in [
            (
                "M3U",
                super::get_m3u_url_secret_entry("test:m3u-builder")
                    .expect("M3U credential entry should build"),
            ),
            (
                "Xtream",
                super::get_xtream_secret_entry("test:xtream-builder")
                    .expect("Xtream credential entry should build"),
            ),
            (
                "EPG",
                super::get_epg_url_secret_entry("test:epg-builder")
                    .expect("EPG credential entry should build"),
            ),
        ] {
            assert!(
                entry
                    .get_credential()
                    .is::<keyring::windows::WinCredential>(),
                "{credential_type} entry should use the Windows native credential builder"
            );
        }
    }

    #[test]
    fn secret_services_are_isolated_between_build_profiles_and_credential_types() {
        let production = [
            M3U_URL_SECRET_SERVICE_PROD,
            XTREAM_SECRET_SERVICE_PROD,
            EPG_URL_SECRET_SERVICE_PROD,
        ];
        let development = [
            M3U_URL_SECRET_SERVICE_DEV,
            XTREAM_SECRET_SERVICE_DEV,
            EPG_URL_SECRET_SERVICE_DEV,
        ];
        for services in [production, development] {
            assert_ne!(services[0], services[1]);
            assert_ne!(services[0], services[2]);
            assert_ne!(services[1], services[2]);
        }
        assert_ne!(M3U_URL_SECRET_SERVICE_DEV, M3U_URL_SECRET_SERVICE_PROD);
        assert_ne!(XTREAM_SECRET_SERVICE_DEV, XTREAM_SECRET_SERVICE_PROD);
        assert_ne!(EPG_URL_SECRET_SERVICE_DEV, EPG_URL_SECRET_SERVICE_PROD);

        if cfg!(debug_assertions) {
            assert_eq!(M3U_URL_SECRET_SERVICE, M3U_URL_SECRET_SERVICE_DEV);
            assert_eq!(XTREAM_SECRET_SERVICE, XTREAM_SECRET_SERVICE_DEV);
            assert_eq!(EPG_URL_SECRET_SERVICE, EPG_URL_SECRET_SERVICE_DEV);
        } else {
            assert_eq!(M3U_URL_SECRET_SERVICE, M3U_URL_SECRET_SERVICE_PROD);
            assert_eq!(XTREAM_SECRET_SERVICE, XTREAM_SECRET_SERVICE_PROD);
            assert_eq!(EPG_URL_SECRET_SERVICE, EPG_URL_SECRET_SERVICE_PROD);
        }
    }

    #[test]
    fn epg_url_storage_accepts_xmltv_http_urls_and_never_leaks_rejected_input() {
        assert_eq!(
            validate_epg_url_for_storage(" XMLTV: https://example.invalid/guide.xml?token=safe ")
                .unwrap(),
            "https://example.invalid/guide.xml?token=safe"
        );
        assert!(validate_epg_url_for_storage("http://example.invalid/guide.xml").is_ok());
        let sentinel = "private-token-must-not-appear";
        for invalid in [
            format!("file:///tmp/{sentinel}"),
            format!("not-a-url-{sentinel}"),
            "   ".to_string(),
        ] {
            let error = validate_epg_url_for_storage(&invalid).unwrap_err();
            assert!(!error.contains(sentinel));
            assert!(!error.contains(&invalid));
        }
    }

    #[test]
    fn m3u_url_storage_accepts_only_http_and_https_without_leaking_invalid_input() {
        let sentinel = "private-token-must-not-appear";
        assert_eq!(
            validate_m3u_url_for_storage(" https://example.invalid/list.m3u?token=safe ")
                .expect("https URL should be accepted"),
            "https://example.invalid/list.m3u?token=safe"
        );
        assert!(validate_m3u_url_for_storage("http://example.invalid/list.m3u").is_ok());

        for (invalid, expected_error) in [
            (
                format!("file:///tmp/{sentinel}"),
                UNSUPPORTED_M3U_URL_SCHEME_MESSAGE,
            ),
            (format!("not-a-url-{sentinel}"), INVALID_M3U_URL_MESSAGE),
            ("   ".to_string(), INVALID_M3U_URL_MESSAGE),
        ] {
            let error = validate_m3u_url_for_storage(&invalid).expect_err("URL must be rejected");
            assert_eq!(error, expected_error);
            assert!(!error.contains(sentinel));
            assert!(!error.contains(&invalid));
        }
        assert!(validate_m3u_url_for_storage("").is_err());
    }

    #[test]
    fn xtream_direct_source_selection_marks_provider_provenance() {
        let direct = "https://cdn.example/live/vendor/provider-pass/42.ts".to_string();
        let selected = choose_xtream_stream(Some(direct.clone()), || {
            panic!("generated Xtream URL must not be selected for a direct source")
        })
        .expect("direct source should be selected");

        assert_eq!(selected, (direct, true));
    }

    #[test]
    fn xtream_channel_payload_serializes_explicit_direct_source_provenance() {
        let payload = XtreamChannelPayload {
            name: "Direct News".to_string(),
            group: "Live".to_string(),
            stream: "https://cdn.example/live/vendor/provider-pass/42.ts".to_string(),
            is_direct_source: true,
            logo: None,
            tvg_id: None,
            tvg_name: None,
        };

        let serialized = serde_json::to_value(payload).expect("payload should serialize");
        assert_eq!(serialized["isDirectSource"], true);
    }

    #[test]
    fn saved_source_command_boundary_scrubs_recognized_secrets_only() {
        let mut sources = serde_json::json!({
            "xtream": {
                "kind": "xtream",
                "domain": "provider.example",
                "username": "viewer",
                "password": "private-password"
            },
            "m3u": {
                "kind": "m3u_url",
                "url": "https://provider.example/private.m3u"
            },
            "unknown": {
                "kind": "future-source",
                "password": "must-still-be-rejected"
            }
        });
        scrub_saved_source_secrets("iptv-player:saved-sources", &mut sources);
        assert_eq!(sources["xtream"]["username"], "viewer");
        assert_eq!(sources["xtream"]["password"], "");
        assert_eq!(sources["m3u"]["url"], "");
        assert_eq!(sources["unknown"]["password"], "must-still-be-rejected");

        let mut unrelated = serde_json::json!({"kind": "xtream", "password": "keep"});
        scrub_saved_source_secrets("unrelated-key", &mut unrelated);
        assert_eq!(unrelated["password"], "keep");
    }
}
