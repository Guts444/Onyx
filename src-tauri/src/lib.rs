mod epg;

use std::{collections::HashMap, fs, path::PathBuf, time::Duration};

use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::Value;
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};

const MAX_PLAYLIST_BYTES: usize = 32 * 1024 * 1024;
const MAX_XTREAM_BYTES: usize = 32 * 1024 * 1024;
const CONNECT_TIMEOUT_SECS: u64 = 15;
const READ_TIMEOUT_SECS: u64 = 45;
const APP_STATE_DIRECTORY: &str = "state";
const XTREAM_SECRET_SERVICE: &str = "Onyx Xtream";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct XtreamChannelPayload {
    name: String,
    group: String,
    stream: String,
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

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(READ_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("onyx/0.1")
        .build()
        .map_err(|error| format!("Could not initialize the network client: {error}"))
}

fn validate_app_state_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 160 {
        return Err("The app state key is not valid.".to_string());
    }

    if key
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_' | b'.'))
    {
        return Ok(());
    }

    Err("The app state key contains unsupported characters.".to_string())
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

fn encode_app_state_file_name(key: &str) -> String {
    key.as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn get_app_state_path<R: Runtime>(app: &AppHandle<R>, key: &str) -> Result<PathBuf, String> {
    validate_app_state_key(key)?;
    app.path()
        .resolve(
            format!(
                "{APP_STATE_DIRECTORY}/{}.json",
                encode_app_state_file_name(key)
            ),
            BaseDirectory::AppLocalData,
        )
        .map_err(|error| format!("Could not resolve the app state path: {error}"))
}

#[tauri::command]
fn load_app_state(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let state_path = get_app_state_path(&app, &key)?;

    if !state_path.exists() {
        return Ok(None);
    }

    let bytes =
        fs::read(state_path).map_err(|error| format!("Could not read the app state: {error}"))?;
    let value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not parse the app state: {error}"))?;

    Ok(Some(value))
}

#[tauri::command]
fn save_app_state(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let state_path = get_app_state_path(&app, &key)?;

    if let Some(parent_directory) = state_path.parent() {
        fs::create_dir_all(parent_directory)
            .map_err(|error| format!("Could not create the app state directory: {error}"))?;
    }

    let serialized = serde_json::to_vec(&value)
        .map_err(|error| format!("Could not serialize the app state: {error}"))?;

    fs::write(state_path, serialized)
        .map_err(|error| format!("Could not write the app state: {error}"))?;

    Ok(())
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

#[tauri::command]
async fn fetch_playlist_from_url(url: String) -> Result<String, String> {
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

#[tauri::command]
async fn fetch_xtream_live_channels(
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
        let stream_url = if let Some(source) = direct_source {
            source
        } else {
            build_xtream_stream_url(
                &stream_origin,
                trimmed_username,
                trimmed_password,
                &stream_id,
                &output_extension,
            )?
        };

        channels.push(XtreamChannelPayload {
            name: channel_name,
            group: group_name,
            stream: stream_url,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(epg::EpgState::default())
        .plugin(tauri_plugin_libmpv::init())
        .invoke_handler(tauri::generate_handler![
            fetch_playlist_from_url,
            fetch_xtream_live_channels,
            load_app_state,
            save_app_state,
            load_xtream_password,
            save_xtream_password,
            delete_xtream_password,
            epg::refresh_epg_cache,
            epg::load_epg_cache_directories,
            epg::delete_epg_cache,
            epg::get_epg_programme_snapshots
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
