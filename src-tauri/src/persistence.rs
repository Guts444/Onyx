use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{SystemTime, UNIX_EPOCH},
};

/// Default app-state cap, including the version envelope.
pub const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PLAYLIST_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_PLAYLIST_SELECTION_BYTES: usize = 4 * 1024;
pub const CURRENT_SCHEMA_VERSION: u32 = 1;
const MAX_KEY_BYTES: usize = 160;
const ENVELOPE_MAGIC: &str = "onyx-app-state";

static UNIQUE_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static KEY_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateEnvelope {
    format: String,
    schema_version: u32,
    value: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyStateEnvelope {
    schema_version: u32,
    value: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOutcome {
    pub exists: bool,
    pub value: Option<Value>,
    pub schema_version: Option<u32>,
    pub recovered: bool,
    pub corrupt: bool,
    pub quarantined: bool,
    pub unsafe_legacy_playlist: bool,
    pub requires_safe_rewrite: bool,
}

struct ParsedState {
    value: Value,
    schema_version: u32,
    unsafe_legacy_playlist: bool,
}

struct LoadedState {
    bytes: Vec<u8>,
    parsed: Result<ParsedState, String>,
    unsafe_bytes: bool,
    oversized: bool,
}

pub struct Store {
    directory: PathBuf,
}

impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn max_state_bytes(key: &str) -> usize {
        match key {
            "iptv-player:playlist-snapshot" => MAX_PLAYLIST_SNAPSHOT_BYTES,
            "iptv-player:playlist-selection" => MAX_PLAYLIST_SELECTION_BYTES,
            _ => MAX_STATE_BYTES,
        }
    }

    fn validate_key(key: &str) -> Result<(), String> {
        if key.is_empty() || key.len() > MAX_KEY_BYTES {
            return Err("The app state key is not valid.".to_string());
        }
        if key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_' | b'.'))
        {
            Ok(())
        } else {
            Err("The app state key contains unsupported characters.".to_string())
        }
    }

    fn encoded_name(key: &str) -> String {
        key.as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn path(&self, key: &str) -> PathBuf {
        self.directory
            .join(format!("{}.json", Self::encoded_name(key)))
    }

    fn backup_path(&self, key: &str) -> PathBuf {
        self.directory
            .join(format!("{}.json.bak", Self::encoded_name(key)))
    }

    fn lock_path(&self, key: &str) -> PathBuf {
        self.directory
            .join(format!("{}.lock", Self::encoded_name(key)))
    }

    fn lock_for(&self, key: &str) -> Arc<Mutex<()>> {
        let path = self.path(key);
        let mut locks = KEY_LOCKS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = locks.get(&path).and_then(Weak::upgrade) {
            return existing;
        }
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(Mutex::new(()));
        locks.insert(path, Arc::downgrade(&lock));
        lock
    }

    fn acquire_process_lock(&self, key: &str) -> Result<File, String> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        configure_private_file(&mut options);
        let file = options
            .open(self.lock_path(key))
            .map_err(|error| format!("Could not open the app state lock: {error}"))?;
        file.lock_exclusive()
            .map_err(|error| format!("Could not lock the app state: {error}"))?;
        Ok(file)
    }

    pub fn write(&self, key: &str, value: &Value) -> Result<(), String> {
        Self::validate_key(key)?;
        let max_state_bytes = Self::max_state_bytes(key);
        let serialized = serde_json::to_vec(&StateEnvelope {
            format: ENVELOPE_MAGIC.to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            value: value.clone(),
        })
        .map_err(|error| format!("Could not serialize the app state: {error}"))?;
        if contains_unsafe_credentials(key, &serialized) {
            return Err(
                "App state containing credentials cannot be persisted; use the OS credential store."
                    .to_string(),
            );
        }
        if serialized.len() > max_state_bytes {
            return Err(format!(
                "The app state is too large (maximum {max_state_bytes} bytes)."
            ));
        }

        let key_lock = self.lock_for(key);
        let _guard = key_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.prepare_directory()?;
        let _process_lock = self.acquire_process_lock(key)?;

        let primary = self.path(key);
        let backup = self.backup_path(key);
        if primary.exists() {
            let loaded = self.load_file(key, &primary)?;
            if let Ok(parsed) = loaded.parsed {
                if !parsed.unsafe_legacy_playlist {
                    atomic_write(&backup, &loaded.bytes)?;
                }
            }
        }

        // Replacement is the only operation that removes an unsafe primary. A
        // separately validated backup remains untouched until this succeeds.
        atomic_write(&primary, &serialized)?;

        // Preserve every backup until the safe primary is durable. Once it is,
        // credential-bearing legacy backup bytes are no longer a valid LKG.
        if backup.exists() {
            let loaded = self.load_file(key, &backup)?;
            if loaded.oversized {
                let _ = remove_if_exists(&backup);
            } else if loaded.unsafe_bytes {
                secure_delete_best_effort(&backup)?;
            }
        }
        self.cleanup_epg_artifacts(key);
        Ok(())
    }

    pub fn read(&self, key: &str) -> Result<ReadOutcome, String> {
        Self::validate_key(key)?;
        let key_lock = self.lock_for(key);
        let _guard = key_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.prepare_directory()?;
        let _process_lock = self.acquire_process_lock(key)?;
        self.read_locked(key)
    }

    fn read_locked(&self, key: &str) -> Result<ReadOutcome, String> {
        self.cleanup_epg_artifacts(key);
        let primary = self.path(key);
        let backup = self.backup_path(key);
        if !primary.exists() {
            return self.read_backup(key, &backup, false, false);
        }

        let loaded = self.load_file(key, &primary)?;
        match loaded.parsed {
            Ok(parsed) => {
                // A readable primary is sufficient for migration. Only now may a
                // second credential-bearing EPG copy be securely discarded.
                if is_epg_state_key(key)
                    && backup.exists()
                    && self
                        .load_file(key, &backup)
                        .is_ok_and(|loaded| loaded.parsed.is_ok() && loaded.unsafe_bytes)
                {
                    let _ = secure_delete_best_effort(&backup);
                }
                Ok(outcome_from_parsed(parsed, false, false, false))
            }
            Err(_) => {
                let quarantined = dispose_invalid(
                    &primary,
                    loaded.unsafe_bytes || is_epg_state_key(key),
                    loaded.oversized,
                )?;
                self.read_backup(key, &backup, true, quarantined)
            }
        }
    }

    fn read_backup(
        &self,
        key: &str,
        backup: &Path,
        corrupt: bool,
        quarantined: bool,
    ) -> Result<ReadOutcome, String> {
        if !backup.exists() {
            return Ok(missing_outcome(corrupt, quarantined));
        }

        let loaded = self.load_file(key, backup)?;
        if is_epg_state_key(key) && (loaded.oversized || loaded.parsed.is_err()) {
            let _ = secure_delete_best_effort(backup);
            return Ok(missing_outcome(true, quarantined));
        }
        match loaded.parsed {
            Ok(parsed) if parsed.unsafe_legacy_playlist => {
                // Return credential-bearing legacy data only in memory so the
                // frontend can sanitize it and atomically rewrite the primary.
                Ok(outcome_from_parsed(parsed, true, corrupt, quarantined))
            }
            Ok(parsed) => {
                atomic_write(&self.path(key), &loaded.bytes)?;
                Ok(outcome_from_parsed(parsed, true, corrupt, quarantined))
            }
            Err(_) => {
                let backup_quarantined =
                    dispose_invalid(backup, loaded.unsafe_bytes, loaded.oversized)?;
                Ok(missing_outcome(true, quarantined || backup_quarantined))
            }
        }
    }

    fn load_file(&self, key: &str, path: &Path) -> Result<LoadedState, String> {
        let Some(bytes) = read_bounded(path, Self::max_state_bytes(key))? else {
            return Ok(LoadedState {
                bytes: Vec::new(),
                parsed: Err("The app state is too large to read safely.".to_string()),
                // Oversized state is unreadable and must never be retained as a
                // backup or copied to quarantine.
                unsafe_bytes: true,
                oversized: true,
            });
        };
        let unsafe_bytes = contains_unsafe_credentials(key, &bytes);
        let parsed = parse_state(key, &bytes);
        Ok(LoadedState {
            bytes,
            parsed,
            unsafe_bytes,
            oversized: false,
        })
    }

    fn prepare_directory(&self) -> Result<(), String> {
        fs::create_dir_all(&self.directory)
            .map_err(|error| format!("Could not create the app state directory: {error}"))?;
        restrict_directory_permissions(&self.directory)
    }

    fn cleanup_epg_artifacts(&self, key: &str) {
        if !is_epg_state_key(key) {
            return;
        }
        let Some(base_name) = self
            .path(key)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
        else {
            return;
        };
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(suffix) = name.strip_prefix(&base_name) else {
                continue;
            };
            let owned_temporary = suffix.starts_with(".tmp-") || suffix.starts_with(".bak.tmp-");
            if owned_temporary || suffix.contains(".corrupt-") {
                let _ = secure_delete_best_effort(&entry.path());
            }
        }

        let backup = self.backup_path(key);
        if backup.exists()
            && self
                .load_file(key, &backup)
                .is_ok_and(|loaded| loaded.oversized || loaded.parsed.is_err())
        {
            let _ = secure_delete_best_effort(&backup);
        }
    }
}

fn parse_state(key: &str, bytes: &[u8]) -> Result<ParsedState, String> {
    let raw: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Could not parse the app state: {error}"))?;

    if raw.get("format").and_then(Value::as_str) == Some(ENVELOPE_MAGIC) {
        let envelope: StateEnvelope = serde_json::from_value(raw)
            .map_err(|error| format!("Could not validate the app state: {error}"))?;
        if envelope.schema_version != CURRENT_SCHEMA_VERSION {
            return Err(format!(
                "Unsupported app state schema version {}.",
                envelope.schema_version
            ));
        }
        let unsafe_legacy_playlist = value_contains_credentials(&envelope.value)
            || value_contains_unsafe_epg_state(key, &envelope.value);
        return Ok(ParsedState {
            value: envelope.value,
            schema_version: envelope.schema_version,
            unsafe_legacy_playlist,
        });
    }

    // ddeedd2 wrote envelopes without a discriminator. Accept only the exact
    // two-field shape; ordinary application objects containing schemaVersion
    // remain unambiguously legacy values.
    if raw.as_object().is_some_and(|object| {
        object.len() == 2 && object.contains_key("schemaVersion") && object.contains_key("value")
    }) {
        if let Ok(envelope) = serde_json::from_value::<LegacyStateEnvelope>(raw.clone()) {
            if envelope.schema_version == CURRENT_SCHEMA_VERSION {
                return Ok(ParsedState {
                    value: envelope.value,
                    schema_version: envelope.schema_version,
                    unsafe_legacy_playlist: contains_unsafe_credentials(key, bytes),
                });
            }
        }
    }

    Ok(ParsedState {
        unsafe_legacy_playlist: contains_unsafe_credentials(key, bytes),
        value: raw,
        schema_version: 0,
    })
}

fn outcome_from_parsed(
    parsed: ParsedState,
    recovered: bool,
    corrupt: bool,
    quarantined: bool,
) -> ReadOutcome {
    let requires_safe_rewrite = parsed.unsafe_legacy_playlist;
    ReadOutcome {
        exists: true,
        value: Some(parsed.value),
        schema_version: Some(parsed.schema_version),
        recovered,
        corrupt,
        quarantined,
        unsafe_legacy_playlist: parsed.unsafe_legacy_playlist,
        requires_safe_rewrite,
    }
}

fn missing_outcome(corrupt: bool, quarantined: bool) -> ReadOutcome {
    ReadOutcome {
        exists: false,
        value: None,
        schema_version: None,
        recovered: false,
        corrupt,
        quarantined,
        unsafe_legacy_playlist: false,
        requires_safe_rewrite: false,
    }
}

fn is_epg_state_key(key: &str) -> bool {
    matches!(
        key,
        "iptv-player:epg-sources" | "iptv-player:epg-manual-matches"
    )
}

fn read_bounded(path: &Path, max_state_bytes: usize) -> Result<Option<Vec<u8>>, String> {
    let file = File::open(path).map_err(|error| format!("Could not open app state: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("Could not inspect app state: {error}"))?
        .len();
    if length > max_state_bytes as u64 {
        return Ok(None);
    }
    // The metadata value is untrusted but already bounded above. The limited
    // read also handles a file that grows after the metadata check without
    // allocating from its attacker-controlled final length.
    let mut bytes = Vec::with_capacity(length as usize);
    file.take((max_state_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read app state: {error}"))?;
    if bytes.len() > max_state_bytes {
        return Ok(None);
    }
    Ok(Some(bytes))
}

fn contains_unsafe_credentials(key: &str, bytes: &[u8]) -> bool {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        return value_contains_credentials_for_key(key, &value)
            || value_contains_unsafe_epg_state(key, &value);
    }

    // Malformed legacy files cannot be traversed structurally. Keep the raw
    // fallback exact and conservative so credential bytes are deleted without
    // treating harmless substrings such as `compass` or `bypass` as secrets.
    let lower = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    [
        "\"password\"",
        "\"passwd\"",
        "\"pass\"",
        "\"username\"",
        "\"user\"",
        "\"credential\"",
        "\"credentials\"",
        "\"authorization\"",
        "\"token\"",
        "\"access_token\"",
        "\"accesstoken\"",
        "\"auth\"",
        "\"api_key\"",
        "\"apikey\"",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || malformed_text_contains_sensitive_assignment(&lower)
        || contains_xtream_path(&lower)
        || contains_url_userinfo(&lower)
}

fn value_contains_credentials_for_key(key: &str, value: &Value) -> bool {
    if key == "iptv-player:saved-sources" {
        return value_contains_saved_source_credentials(value);
    }
    value_contains_credentials(value)
}

fn value_contains_saved_source_credentials(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            // An Xtream username is connection metadata required to rebuild a
            // stream URL after restart. The password remains in Credential
            // Manager, and credential-bearing strings/URLs are still rejected.
            ((!key.eq_ignore_ascii_case("username") && !key.eq_ignore_ascii_case("user"))
                && is_sensitive_name(key)
                && sensitive_value_is_nonempty(value))
                || value_contains_saved_source_credentials(value)
        }),
        Value::Array(values) => values.iter().any(value_contains_saved_source_credentials),
        Value::String(text) => string_contains_credentials(text),
        _ => false,
    }
}

fn malformed_text_contains_sensitive_assignment(text: &str) -> bool {
    text.split(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '"' | '\'' | '\\' | '?' | '&' | '#' | '{' | '}' | ','
            )
    })
    .any(|part| {
        let Some((name, value)) = part.split_once('=') else {
            return false;
        };
        !value.is_empty()
            && percent_decode_query_name(name).is_some_and(|name| is_sensitive_name(&name))
    })
}

fn percent_decode_query_name(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let high = (bytes[index + 1] as char).to_digit(16)?;
                let low = (bytes[index + 2] as char).to_digit(16)?;
                decoded.push((high * 16 + low) as u8);
                index += 3;
            }
            b'%' => return None,
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).ok()
}

fn is_sensitive_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "password"
            | "passwd"
            | "pass"
            | "username"
            | "user"
            | "credential"
            | "credentials"
            | "authorization"
            | "token"
            | "access_token"
            | "accesstoken"
            | "auth"
            | "api_key"
            | "apikey"
    )
}

fn value_contains_unsafe_epg_state(key: &str, value: &Value) -> bool {
    match key {
        "iptv-player:epg-sources" => value_contains_nonempty_url_field(value),
        "iptv-player:epg-manual-matches" => value_contains_epg_url_scope(value),
        _ => false,
    }
}

fn value_contains_nonempty_url_field(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            (key.eq_ignore_ascii_case("url") && sensitive_value_is_nonempty(value))
                || value_contains_nonempty_url_field(value)
        }),
        Value::Array(values) => values.iter().any(value_contains_nonempty_url_field),
        _ => false,
    }
}

fn value_contains_epg_url_scope(value: &Value) -> bool {
    match value {
        Value::Object(object) => object
            .iter()
            .any(|(key, value)| is_url_or_xmltv_scope(key) || value_contains_epg_url_scope(value)),
        Value::Array(values) => values.iter().any(value_contains_epg_url_scope),
        Value::String(text) => is_url_or_xmltv_scope(text),
        _ => false,
    }
}

fn is_url_or_xmltv_scope(text: &str) -> bool {
    let candidate = text.trim().split('\u{1}').next().unwrap_or_default().trim();
    reqwest::Url::parse(candidate)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "xmltv"))
}

fn value_contains_credentials(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            (is_sensitive_name(key) && sensitive_value_is_nonempty(value))
                || value_contains_credentials(value)
        }),
        Value::Array(values) => values.iter().any(value_contains_credentials),
        Value::String(text) => string_contains_credentials(text),
        _ => false,
    }
}

fn sensitive_value_is_nonempty(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(values) => !values.is_empty(),
        Value::Object(object) => !object.is_empty(),
        Value::Bool(_) | Value::Number(_) => true,
    }
}

fn string_contains_credentials(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.trim_start().starts_with("bearer ") {
        return true;
    }

    embedded_urls_contain_credentials(text) || contains_xtream_path(&lower)
}

fn embedded_urls_contain_credentials(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.char_indices().any(|(start, _)| {
        let remainder = &lower[start..];
        if !remainder.starts_with("http://") && !remainder.starts_with("https://") {
            return false;
        }

        let end = text[start..]
            .char_indices()
            .find_map(|(offset, character)| {
                (character.is_whitespace()
                    || matches!(character, '"' | '\'' | '<' | '>' | '[' | ']' | '{' | '}'))
                .then_some(start + offset)
            })
            .unwrap_or(text.len());
        let candidate = text[start..end].trim_end_matches([')', ',', ';', '.', '!']);

        reqwest::Url::parse(candidate).is_ok_and(|url| {
            !url.username().is_empty()
                || url.password().is_some()
                || url
                    .query_pairs()
                    .any(|(name, value)| !value.is_empty() && is_sensitive_name(&name))
                || contains_xtream_path(&url.path().to_ascii_lowercase())
        })
    })
}

fn contains_xtream_path(text: &str) -> bool {
    let path = text.split(['?', '#']).next().unwrap_or(text);
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    segments.windows(4).any(|window| {
        matches!(window[0], "live" | "movie" | "series")
            && !window[1].is_empty()
            && !window[2].is_empty()
            && !window[3].is_empty()
    })
}

fn contains_url_userinfo(text: &str) -> bool {
    text.split_whitespace().any(|part| {
        part.find("://").is_some_and(|scheme_end| {
            let authority = &part[scheme_end + 3..];
            authority
                .split(['/', '?', '#'])
                .next()
                .is_some_and(|host| host.contains('@') && host.contains(':'))
        })
    })
}

fn unique_suffix() -> String {
    let id = UNIQUE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos}-{id}", std::process::id())
}

fn atomic_write(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "The app state path has no parent directory.".to_string())?;
    let name = destination
        .file_name()
        .ok_or_else(|| "The app state path has no file name.".to_string())?
        .to_string_lossy();
    let temporary = parent.join(format!("{name}.tmp-{}", unique_suffix()));

    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        configure_private_file(&mut options);
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("Could not create temporary app state: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Could not write temporary app state: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not flush temporary app state: {error}"))?;
        drop(file);
        replace_file(&temporary, destination)?;
        sync_parent_directory(parent)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn dispose_invalid(path: &Path, unsafe_bytes: bool, oversized: bool) -> Result<bool, String> {
    if oversized {
        // Never copy or overwrite an attacker-controlled amount of data. A
        // failed deletion is intentionally non-fatal so backup recovery can
        // still proceed.
        let _ = remove_if_exists(path);
        Ok(false)
    } else if unsafe_bytes {
        secure_delete_best_effort(path)?;
        Ok(false)
    } else {
        quarantine(path)
    }
}

fn quarantine(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let destination = path.with_file_name(format!("{name}.corrupt-{}", unique_suffix()));
    fs::rename(path, destination)
        .map_err(|error| format!("Could not quarantine corrupt app state: {error}"))?;
    Ok(true)
}

fn secure_delete_best_effort(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    // Overwriting is advisory (copy-on-write filesystems and SSD wear leveling
    // may retain blocks), but it reduces exposure on conventional filesystems.
    if let Ok(mut file) = OpenOptions::new().read(true).write(true).open(path) {
        if let Ok(length) = file.metadata().map(|metadata| metadata.len()) {
            if file.seek(SeekFrom::Start(0)).is_ok() {
                let zeroes = [0_u8; 8192];
                let mut remaining = length;
                while remaining > 0 {
                    let count = remaining.min(zeroes.len() as u64) as usize;
                    if file.write_all(&zeroes[..count]).is_err() {
                        break;
                    }
                    remaining -= count as u64;
                }
                let _ = file.sync_all();
            }
        }
    }

    remove_if_exists(path)
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove obsolete app state: {error}")),
    }
}

#[cfg(unix)]
fn configure_private_file(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(windows)]
fn configure_private_file(_options: &mut OpenOptions) {
    // AppLocalData is per-user and new files inherit its restricted Windows ACL.
    // Credentials still belong in Windows Credential Manager, never in this store.
}

#[cfg(unix)]
fn restrict_directory_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not restrict app state permissions: {error}"))
}

#[cfg(windows)]
fn restrict_directory_permissions(_path: &Path) -> Result<(), String> {
    // The app's per-user AppLocalData ACL is inherited by this directory.
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("Could not atomically replace app state: {error}"))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(format!(
            "Could not atomically replace app state: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not flush the app state directory: {error}"))
}

#[cfg(windows)]
fn sync_parent_directory(_path: &Path) -> Result<(), String> {
    // MOVEFILE_WRITE_THROUGH requests durable metadata replacement on Windows.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "onyx-persistence-{name}-{}-{id}",
                std::process::id()
            ));
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

    #[test]
    fn valid_round_trip_preserves_value_and_schema_version() {
        let directory = TestDirectory::new("round-trip");
        let store = Store::new(directory.0.clone());
        let value = json!({"theme": "dark", "volume": 42});

        store.write("settings", &value).unwrap();
        let loaded = store.read("settings").unwrap();

        assert!(loaded.exists);
        assert_eq!(loaded.value, Some(value));
        assert_eq!(loaded.schema_version, Some(CURRENT_SCHEMA_VERSION));
        assert!(!loaded.recovered);
        assert!(!loaded.corrupt);
    }

    #[test]
    fn invalid_keys_are_rejected() {
        let directory = TestDirectory::new("invalid-keys");
        let store = Store::new(directory.0.clone());
        for key in [
            "",
            "../escape",
            "has/slash",
            "white space",
            &"x".repeat(161),
        ] {
            assert!(store.write(key, &json!(true)).is_err(), "accepted {key:?}");
            assert!(store.read(key).is_err(), "accepted {key:?}");
        }
        assert!(fs::read_dir(&directory.0).unwrap().next().is_none());
    }

    #[test]
    fn oversize_payload_is_rejected_without_touching_primary_or_backup() {
        let directory = TestDirectory::new("oversize");
        let store = Store::new(directory.0.clone());
        store.write("large", &json!({"generation": 1})).unwrap();
        store.write("large", &json!({"generation": 2})).unwrap();
        let primary_before = fs::read(store.path("large")).unwrap();
        let backup_before = fs::read(store.backup_path("large")).unwrap();
        let oversized = json!("x".repeat(MAX_STATE_BYTES));

        let error = store.write("large", &oversized).unwrap_err();

        assert!(error.contains("too large"));
        assert_eq!(fs::read(store.path("large")).unwrap(), primary_before);
        assert_eq!(fs::read(store.backup_path("large")).unwrap(), backup_before);
    }

    fn value_with_envelope_size(target: usize) -> Value {
        let empty_size = serde_json::to_vec(&StateEnvelope {
            format: ENVELOPE_MAGIC.to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            value: json!(""),
        })
        .unwrap()
        .len();
        assert!(target >= empty_size);
        json!("x".repeat(target - empty_size))
    }

    #[test]
    fn key_specific_limits_are_envelope_inclusive_at_the_exact_boundary() {
        let directory = TestDirectory::new("key-specific-exact-boundaries");
        let store = Store::new(directory.0.clone());

        for (key, maximum) in [
            ("iptv-player:playlist-snapshot", 32 * 1024 * 1024),
            ("iptv-player:playlist-selection", 4 * 1024),
            ("settings", MAX_STATE_BYTES),
        ] {
            store
                .write(key, &value_with_envelope_size(maximum))
                .unwrap();
            assert_eq!(fs::metadata(store.path(key)).unwrap().len(), maximum as u64);
            let error = store
                .write(key, &value_with_envelope_size(maximum + 1))
                .unwrap_err();
            assert!(
                error.contains("too large"),
                "unexpected error for {key}: {error}"
            );
            assert_eq!(fs::metadata(store.path(key)).unwrap().len(), maximum as u64);
        }
    }

    #[test]
    fn realistic_playlist_above_the_legacy_global_limit_is_accepted_only_for_snapshot_key() {
        const REPRESENTATIVE_SNAPSHOT_BYTES: usize = 17_539_155;
        let directory = TestDirectory::new("production-playlist-size");
        let store = Store::new(directory.0.clone());
        let value = value_with_envelope_size(REPRESENTATIVE_SNAPSHOT_BYTES);

        store
            .write("iptv-player:playlist-snapshot", &value)
            .unwrap();
        let error = store.write("ordinary-state", &value).unwrap_err();

        assert_eq!(
            fs::metadata(store.path("iptv-player:playlist-snapshot"))
                .unwrap()
                .len(),
            REPRESENTATIVE_SNAPSHOT_BYTES as u64,
        );
        assert!(error.contains("too large"));
        assert!(!store.path("ordinary-state").exists());
    }

    #[test]
    fn oversized_selection_recovers_independently_without_affecting_playlist_snapshot() {
        let directory = TestDirectory::new("selection-independent-recovery");
        let store = Store::new(directory.0.clone());
        let snapshot_key = "iptv-player:playlist-snapshot";
        let selection_key = "iptv-player:playlist-selection";
        let snapshot = json!({"cacheId": "cache-a", "channels": ["channel-a"]});
        store.write(snapshot_key, &snapshot).unwrap();
        store
            .write(selection_key, &json!({"selected": "channel-a"}))
            .unwrap();
        store
            .write(selection_key, &json!({"selected": "channel-b"}))
            .unwrap();
        create_oversized_file_for_key(&store, selection_key);

        let selection = store.read(selection_key).unwrap();

        assert_eq!(selection.value, Some(json!({"selected": "channel-a"})));
        assert!(selection.recovered);
        assert!(selection.corrupt);
        assert_eq!(store.read(snapshot_key).unwrap().value, Some(snapshot));
    }

    #[test]
    fn playlist_above_its_32_mib_limit_is_removed_and_recovers_its_bounded_backup() {
        let directory = TestDirectory::new("oversized-playlist-recovery");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:playlist-snapshot";
        store.write(key, &json!({"generation": 1})).unwrap();
        store.write(key, &json!({"generation": 2})).unwrap();
        create_oversized_file_for_key(&store, key);

        let loaded = store.read(key).unwrap();

        assert_eq!(loaded.value, Some(json!({"generation": 1})));
        assert!(loaded.recovered);
        assert!(loaded.corrupt);
        assert!(!loaded.quarantined);
        assert!(fs::metadata(store.path(key)).unwrap().len() <= 32 * 1024 * 1024);
    }

    fn create_oversized_file_for_key(store: &Store, key: &str) {
        let file = File::create(store.path(key)).unwrap();
        file.set_len(Store::max_state_bytes(key) as u64 + 1)
            .unwrap();
    }

    fn create_oversized_file(path: &Path) {
        let file = File::create(path).unwrap();
        file.set_len(MAX_STATE_BYTES as u64 + 1).unwrap();
    }

    #[test]
    fn oversized_primary_recovers_valid_backup_without_copying_oversized_bytes() {
        let directory = TestDirectory::new("oversized-primary-backup");
        let store = Store::new(directory.0.clone());
        store.write("settings", &json!({"generation": 1})).unwrap();
        store.write("settings", &json!({"generation": 2})).unwrap();
        create_oversized_file(&store.path("settings"));

        let loaded = store.read("settings").unwrap();

        assert_eq!(loaded.value, Some(json!({"generation": 1})));
        assert!(loaded.recovered);
        assert!(loaded.corrupt);
        assert!(!loaded.quarantined);
        assert!(fs::metadata(store.path("settings")).unwrap().len() <= MAX_STATE_BYTES as u64);
        assert!(fs::read_dir(&directory.0).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".corrupt-")));
    }

    #[test]
    fn oversized_primary_without_backup_is_removed_and_reported_missing() {
        let directory = TestDirectory::new("oversized-primary-missing");
        let store = Store::new(directory.0.clone());
        create_oversized_file(&store.path("settings"));

        let loaded = store.read("settings").unwrap();

        assert!(!loaded.exists);
        assert!(loaded.corrupt);
        assert!(!loaded.quarantined);
        assert!(!store.path("settings").exists());
    }

    #[test]
    fn safe_write_atomically_replaces_oversized_primary() {
        let directory = TestDirectory::new("oversized-primary-write");
        let store = Store::new(directory.0.clone());
        store.write("settings", &json!({"generation": 1})).unwrap();
        store.write("settings", &json!({"generation": 2})).unwrap();
        let backup_before = fs::read(store.backup_path("settings")).unwrap();
        create_oversized_file(&store.path("settings"));

        store.write("settings", &json!({"safe": true})).unwrap();

        assert_eq!(
            store.read("settings").unwrap().value,
            Some(json!({"safe": true}))
        );
        assert_eq!(
            fs::read(store.backup_path("settings")).unwrap(),
            backup_before
        );
    }

    #[test]
    fn oversized_backup_is_removed_and_ignored_during_default_recovery() {
        let directory = TestDirectory::new("oversized-backup");
        let store = Store::new(directory.0.clone());
        create_oversized_file(&store.backup_path("settings"));

        let loaded = store.read("settings").unwrap();

        assert!(!loaded.exists);
        assert!(loaded.corrupt);
        assert!(!loaded.quarantined);
        assert!(!store.backup_path("settings").exists());
        assert!(!store.path("settings").exists());
    }

    #[test]
    fn missing_primary_recovers_valid_backup() {
        let directory = TestDirectory::new("missing-primary");
        let store = Store::new(directory.0.clone());
        store.write("settings", &json!({"generation": 1})).unwrap();
        store.write("settings", &json!({"generation": 2})).unwrap();
        fs::remove_file(store.path("settings")).unwrap();

        let loaded = store.read("settings").unwrap();

        assert_eq!(loaded.value, Some(json!({"generation": 1})));
        assert!(loaded.recovered);
        assert!(store.path("settings").exists());
    }

    #[test]
    fn corrupt_primary_recovers_valid_backup() {
        let directory = TestDirectory::new("recover-backup");
        let store = Store::new(directory.0.clone());
        store.write("settings", &json!({"generation": 1})).unwrap();
        store.write("settings", &json!({"generation": 2})).unwrap();
        fs::write(store.path("settings"), b"{broken").unwrap();

        let loaded = store.read("settings").unwrap();

        assert_eq!(loaded.value, Some(json!({"generation": 1})));
        assert!(loaded.recovered);
        assert!(loaded.corrupt);
        let repaired: Value =
            serde_json::from_slice(&fs::read(store.path("settings")).unwrap()).unwrap();
        assert_eq!(repaired["value"], json!({"generation": 1}));
    }

    #[test]
    fn both_corrupt_are_quarantined_and_report_recoverable_missing() {
        let directory = TestDirectory::new("both-corrupt");
        let store = Store::new(directory.0.clone());
        fs::write(store.path("settings"), b"primary secret body").unwrap();
        fs::write(store.backup_path("settings"), b"backup secret body").unwrap();

        let loaded = store.read("settings").unwrap();

        assert!(!loaded.exists);
        assert!(loaded.value.is_none());
        assert!(loaded.corrupt);
        assert!(loaded.quarantined);
        assert!(!store.path("settings").exists());
        assert!(!store.backup_path("settings").exists());
        let names = fs::read_dir(&directory.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-"))
            .collect::<Vec<_>>();
        assert!(names.iter().all(|name| !name.contains("secret")));
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn credential_bearing_playlist_payload_is_rejected_before_disk_write() {
        let directory = TestDirectory::new("unsafe-new-payload");
        let store = Store::new(directory.0.clone());

        let error = store
            .write(
                "playlist:snapshot",
                &json!({"url": "http://tv/get.php?username=u&password=secret"}),
            )
            .unwrap_err();

        assert!(error.contains("credentials"));
        assert!(!store.path("playlist:snapshot").exists());
    }

    #[test]
    fn credential_fields_are_rejected_for_legacy_saved_sources_key() {
        let directory = TestDirectory::new("unsafe-saved-sources");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:saved-sources";

        let error = store
            .write(key, &json!({"source": {"accessToken": "plain-secret"}}))
            .unwrap_err();

        assert!(error.contains("credentials"));
        assert!(!store.path(key).exists());
    }

    #[test]
    fn saved_xtream_username_metadata_is_persistable_but_passwords_are_not() {
        let safe = serde_json::to_vec(&json!({
            "source-1": {
                "id": "source-1",
                "kind": "xtream",
                "domain": "provider.example.test",
                "username": "subscriber-123",
                "password": ""
            }
        }))
        .unwrap();
        assert!(!contains_unsafe_credentials(
            "iptv-player:saved-sources",
            &safe
        ));

        let unsafe_password = serde_json::to_vec(&json!({
            "source-1": {
                "kind": "xtream",
                "domain": "provider.example.test",
                "username": "subscriber-123",
                "password": "secret"
            }
        }))
        .unwrap();
        assert!(contains_unsafe_credentials(
            "iptv-player:saved-sources",
            &unsafe_password
        ));

        let production_shape = serde_json::to_vec(&json!({
            "source_xtream_00000000-0000-4000-8000-000000000000": {
                "createdAt": "2026-07-13T01:00:00.000Z",
                "domain": "provider.example.test",
                "enabled": true,
                "id": "source_xtream_00000000-0000-4000-8000-000000000000",
                "kind": "xtream",
                "lastLoadedAt": "2026-07-13T02:14:40.000Z",
                "name": "Strong",
                "password": "",
                "updatedAt": "2026-07-13T02:14:40.000Z",
                "username": "subscriber-456"
            }
        }))
        .unwrap();
        assert!(!contains_unsafe_credentials(
            "iptv-player:saved-sources",
            &production_shape
        ));

        let directory = TestDirectory::new("saved-xtream-username-metadata");
        let store = Store::new(directory.0.clone());
        let value: Value = serde_json::from_slice(&production_shape).unwrap();
        store
            .write("iptv-player:saved-sources", &value)
            .expect("safe Xtream metadata should persist through the envelope writer");
        let stored = store.read("iptv-player:saved-sources").unwrap();
        assert_eq!(stored.value, Some(value));
    }

    #[test]
    fn detects_real_legacy_playlist_credential_variants_conservatively() {
        let unsafe_urls = [
            "http://tv/live/alice/s3cret/123.ts",
            "https://tv/movie/alice/s3cret/456.mkv",
            "https://tv/series/alice/s3cret/789.mkv",
            "http://alice:s3cret@tv.example/list.m3u",
            "http://tv/get.php?user=alice&pass=s3cret&type=m3u_plus",
            "http://tv/list?token=secret-token",
            "http://tv/list?auth=secret-token",
            "http://tv/list?api_key=secret-token",
        ];
        for url in unsafe_urls {
            let bytes = serde_json::to_vec(&json!({"url": url})).unwrap();
            assert!(
                contains_unsafe_credentials("playlist:snapshot", &bytes),
                "missed {url}"
            );
        }

        for safe in [
            "http://tv/live/news/123.ts",
            "http://tv/list?category=movies",
            "a bearer of good news",
        ] {
            let bytes = serde_json::to_vec(&json!({"label": safe})).unwrap();
            assert!(
                !contains_unsafe_credentials("playlist:snapshot", &bytes),
                "false positive for {safe}"
            );
        }
    }

    #[test]
    fn benign_substrings_and_empty_sensitive_fields_are_not_credentials() {
        let benign = json!({
            "compass": "north",
            "bypass": true,
            "notpassword": "harmless",
            "password": " ",
            "token": null,
            "urls": [
                "https://example.test/search?compass=north",
                "https://example.test/search?bypass=yes",
                "https://example.test/search?notpassword=harmless"
            ]
        });

        assert!(!value_contains_credentials(&benign));
    }

    #[test]
    fn url_query_credential_names_are_matched_exactly_after_percent_decoding() {
        for url in [
            "https://example.test/list?access%54oken=secret",
            "https://example.test/list?api%4Bey=secret",
            "https://example.test/list?authoriza%74ion=secret",
        ] {
            assert!(string_contains_credentials(url), "missed {url}");
        }
        for url in [
            "https://example.test/list?not%70assword=harmless",
            "https://example.test/list?comp%61ss=north",
            "https://example.test/list?by%70ass=yes",
        ] {
            assert!(
                !string_contains_credentials(url),
                "false positive for {url}"
            );
        }
    }

    #[test]
    fn credential_urls_embedded_in_larger_json_strings_are_detected_across_all_keys() {
        let unsafe_messages = [
            "Request failed for https://tv/get.php?username=u&password=secret (timeout)",
            "retry [https://tv/list?access%54oken=secret], later",
            "stream=https://tv/live/alice/s3cret/123.ts, unavailable",
            "upstream http://alice:s3cret@tv.example/list.m3u; failed",
            "response from https://tv/list?token=secret-token.",
        ];
        for message in unsafe_messages {
            let bytes = serde_json::to_vec(&json!({"ordinaryLogMessage": message})).unwrap();
            assert!(
                contains_unsafe_credentials("settings", &bytes),
                "missed embedded URL in {message:?}"
            );
        }
    }

    #[test]
    fn embedded_url_query_names_remain_exact_after_percent_decoding() {
        for message in [
            "Request failed for https://tv/list?compass=north (timeout)",
            "Request failed for https://tv/list?bypass=yes, retrying",
            "Request failed for https://tv/list?notpassword=harmless.",
            "Request failed for https://tv/list?not%70assword=harmless!",
        ] {
            let bytes = serde_json::to_vec(&json!({"message": message})).unwrap();
            assert!(
                !contains_unsafe_credentials("playlist:snapshot", &bytes),
                "false positive for embedded URL in {message:?}"
            );
        }
    }

    #[test]
    fn malformed_json_fallback_uses_exact_query_names_without_substring_false_positives() {
        for benign in [
            br#"{broken "url":"https://example.test/list?compass=north""# as &[u8],
            br#"{broken "url":"https://example.test/list?bypass=yes""#,
            br#"{broken "url":"https://example.test/list?notpassword=no""#,
        ] {
            assert!(!contains_unsafe_credentials("settings", benign));
        }
        assert!(contains_unsafe_credentials(
            "settings",
            br#"{broken "url":"https://example.test/list?pass=secret""#,
        ));
    }

    #[test]
    fn epg_source_urls_are_unsafe_regardless_of_url_shape() {
        let key = "iptv-player:epg-sources";
        for url in [
            "https://guide.example.test/ordinary.xml",
            "https://cdn.example.test/signed/opaque/guide.xml?sigv2=harmless",
            "https://example.test/feed?totallyUnknownName=benign",
        ] {
            let bytes = serde_json::to_vec(&json!([{"id": "epg-1", "url": url}])).unwrap();
            assert!(contains_unsafe_credentials(key, &bytes), "missed {url}");
        }

        let safe = serde_json::to_vec(&json!([{"id": "epg-1", "url": ""}])).unwrap();
        assert!(!contains_unsafe_credentials(key, &safe));
    }

    #[test]
    fn epg_manual_matches_reject_url_scopes_but_allow_source_id_scopes() {
        let key = "iptv-player:epg-manual-matches";
        let legacy = serde_json::to_vec(&json!({
            "https://guide.example.test/ordinary.xml\u{1}playlist-a": {"channel-a": "xmltv-a"}
        }))
        .unwrap();
        let url_property = serde_json::to_vec(&json!({
            "matches": {"https://cdn.example.test/signed/opaque.xml?sigv2=benign": "xmltv-b"}
        }))
        .unwrap();
        let url_value = serde_json::to_vec(&json!({
            "legacyScope": "https://guide.example.test/value-scoped.xml"
        }))
        .unwrap();
        let xmltv_property = serde_json::to_vec(&json!({
            "xmltv://legacy-guide\u{1}playlist-a": {"channel-a": "xmltv-a"}
        }))
        .unwrap();
        let migrated = serde_json::to_vec(&json!({
            "source-id-123\u{1}playlist-a": {"channel-a": "xmltv-a"}
        }))
        .unwrap();

        assert!(contains_unsafe_credentials(key, &legacy));
        assert!(contains_unsafe_credentials(key, &url_property));
        assert!(contains_unsafe_credentials(key, &url_value));
        assert!(contains_unsafe_credentials(key, &xmltv_property));
        assert!(!contains_unsafe_credentials(key, &migrated));
    }

    #[test]
    fn malformed_epg_url_primary_is_deleted_instead_of_quarantined() {
        let directory = TestDirectory::new("malformed-epg-url");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:epg-sources";
        let sentinel = "malformed-epg-url-sentinel";
        fs::write(
            store.path(key),
            format!(r#"[{{"url":"https://guide.example.test/{sentinel}.xml"#),
        )
        .unwrap();

        let loaded = store.read(key).unwrap();

        assert!(!loaded.exists);
        assert!(loaded.corrupt);
        assert!(!loaded.quarantined);
        assert!(!store.path(key).exists());
        for entry in fs::read_dir(&directory.0).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains(sentinel));
        }
    }

    fn sentinel_occurrence_count(directory: &Path, sentinel: &str) -> usize {
        let needle = sentinel.as_bytes();
        fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| fs::read(entry.path()).ok())
            .map(|bytes| {
                bytes
                    .windows(needle.len())
                    .filter(|window| *window == needle)
                    .count()
            })
            .sum()
    }

    #[test]
    fn missing_epg_sources_primary_recovers_sole_unsafe_backup_in_memory() {
        let directory = TestDirectory::new("unsafe-epg-backup-missing-primary");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:epg-sources";
        let sentinel = "sole-epg-source-url";
        let legacy = json!([{
            "id": "epg-1",
            "url": format!("https://guide.example.test/{sentinel}.xml")
        }]);
        let original = serde_json::to_vec(&legacy).unwrap();
        fs::write(store.backup_path(key), &original).unwrap();

        let loaded = store.read(key).unwrap();

        assert_eq!(loaded.value, Some(legacy));
        assert!(loaded.recovered);
        assert!(!loaded.corrupt);
        assert!(!loaded.quarantined);
        assert!(loaded.unsafe_legacy_playlist);
        assert!(loaded.requires_safe_rewrite);
        assert!(!store.path(key).exists());
        assert_eq!(fs::read(store.backup_path(key)).unwrap(), original);
        assert_eq!(sentinel_occurrence_count(&directory.0, sentinel), 1);
    }

    #[test]
    fn corrupt_epg_manual_matches_primary_recovers_sole_unsafe_backup_in_memory() {
        let directory = TestDirectory::new("unsafe-epg-matches-backup-corrupt-primary");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:epg-manual-matches";
        let sentinel = "sole-manual-match-url";
        let legacy = json!({
            format!("https://guide.example.test/{sentinel}.xml\u{1}playlist-a"): {
                "channel-a": "xmltv-a"
            }
        });
        let original = serde_json::to_vec(&legacy).unwrap();
        fs::write(store.backup_path(key), &original).unwrap();
        fs::write(store.path(key), b"{malformed epg primary").unwrap();

        let loaded = store.read(key).unwrap();

        assert_eq!(loaded.value, Some(legacy));
        assert!(loaded.recovered);
        assert!(loaded.corrupt);
        assert!(!loaded.quarantined);
        assert!(loaded.requires_safe_rewrite);
        assert!(!store.path(key).exists());
        assert_eq!(fs::read(store.backup_path(key)).unwrap(), original);
        assert_eq!(sentinel_occurrence_count(&directory.0, sentinel), 1);
    }

    #[test]
    fn successful_safe_rewrite_deletes_sole_unsafe_epg_backup_after_primary_is_durable() {
        let directory = TestDirectory::new("unsafe-epg-backup-successful-rewrite");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:epg-manual-matches";
        let sentinel = "successful-rewrite-manual-url";
        let legacy = json!({
            format!("https://guide.example.test/{sentinel}.xml\u{1}playlist-a"): {
                "channel-a": "xmltv-a"
            }
        });
        fs::write(store.backup_path(key), serde_json::to_vec(&legacy).unwrap()).unwrap();

        let recovered = store.read(key).unwrap();
        assert!(recovered.requires_safe_rewrite);
        assert_eq!(sentinel_occurrence_count(&directory.0, sentinel), 1);

        let migrated = json!({
            "source-id-123\u{1}playlist-a": {"channel-a": "xmltv-a"}
        });
        store.write(key, &migrated).unwrap();

        assert_eq!(store.read(key).unwrap().value, Some(migrated));
        assert!(!store.backup_path(key).exists());
        assert_eq!(sentinel_occurrence_count(&directory.0, sentinel), 0);
    }

    #[test]
    fn failed_safe_rewrite_retains_sole_unsafe_epg_backup_without_creating_primary() {
        let directory = TestDirectory::new("unsafe-epg-backup-failed-rewrite");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:epg-sources";
        let sentinel = "failed-rewrite-epg-url";
        let legacy = json!([{
            "id": "epg-1",
            "url": format!("https://guide.example.test/{sentinel}.xml")
        }]);
        let original = serde_json::to_vec(&legacy).unwrap();
        fs::write(store.backup_path(key), &original).unwrap();

        assert!(store.read(key).unwrap().requires_safe_rewrite);
        let error = store
            .write(key, &json!("x".repeat(MAX_STATE_BYTES)))
            .unwrap_err();

        assert!(error.contains("too large"));
        assert!(!store.path(key).exists());
        assert_eq!(fs::read(store.backup_path(key)).unwrap(), original);
        assert_eq!(sentinel_occurrence_count(&directory.0, sentinel), 1);
        assert!(store.read(key).unwrap().requires_safe_rewrite);
    }

    #[test]
    fn unsafe_epg_primary_is_read_for_migration_and_artifact_copies_are_removed() {
        let directory = TestDirectory::new("unsafe-epg-artifacts");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:epg-sources";
        let legacy = json!([{
            "id": "epg-1",
            "url": "https://guide.example.test/ordinary.xml?opaque=primary-sentinel"
        }]);
        fs::write(store.path(key), serde_json::to_vec(&legacy).unwrap()).unwrap();
        fs::write(
            store.backup_path(key),
            br#"[{"url":"https://guide.example.test/backup-sentinel.xml"}]"#,
        )
        .unwrap();
        let primary_name = store
            .path(key)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let stale_tmp = directory
            .0
            .join(format!("{primary_name}.tmp-999999999-1-1"));
        let corrupt = directory
            .0
            .join(format!("{primary_name}.corrupt-historical"));
        fs::write(&stale_tmp, b"tmp-sentinel").unwrap();
        fs::write(&corrupt, b"corrupt-sentinel").unwrap();
        let unrelated = directory.0.join("unrelated.json.tmp-still-active");
        fs::write(&unrelated, b"unrelated-sentinel").unwrap();

        let loaded = store.read(key).unwrap();

        assert_eq!(loaded.value, Some(legacy));
        assert!(loaded.unsafe_legacy_playlist);
        assert!(loaded.requires_safe_rewrite);
        assert!(store.path(key).exists());
        assert!(!store.backup_path(key).exists());
        assert!(!stale_tmp.exists());
        assert!(!corrupt.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn epg_safe_rewrite_removes_unsafe_primary_without_duplicating_it() {
        let directory = TestDirectory::new("unsafe-epg-rewrite");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:epg-manual-matches";
        let sentinel = "legacy-url-sentinel";
        fs::write(
            store.path(key),
            serde_json::to_vec(&json!({
                format!("https://guide.example.test/{sentinel}.xml\u{1}playlist-a"): {
                    "channel-a": "xmltv-a"
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let loaded = store.read(key).unwrap();
        assert!(loaded.requires_safe_rewrite);
        store
            .write(
                key,
                &json!({"source-id-123\u{1}playlist-a": {"channel-a": "xmltv-a"}}),
            )
            .unwrap();

        let rewritten = store.read(key).unwrap();
        assert!(!rewritten.requires_safe_rewrite);
        for entry in fs::read_dir(&directory.0).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains(sentinel));
        }
    }

    #[test]
    fn successful_epg_rewrite_preserves_safe_backup_then_removes_unsafe_remnants() {
        let directory = TestDirectory::new("epg-safe-backup-remnants");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:epg-sources";
        let safe_backup_value = json!([{"id": "safe-source", "url": ""}]);
        let safe_backup = serde_json::to_vec(&StateEnvelope {
            format: ENVELOPE_MAGIC.to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            value: safe_backup_value,
        })
        .unwrap();
        fs::write(store.backup_path(key), &safe_backup).unwrap();
        fs::write(
            store.path(key),
            br#"[{"id":"legacy","url":"https://guide.example.test/primary-remnant.xml"}]"#,
        )
        .unwrap();
        let primary_name = store
            .path(key)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let tmp = directory.0.join(format!("{primary_name}.tmp-stale"));
        let corrupt = directory.0.join(format!("{primary_name}.bak.corrupt-old"));
        fs::write(&tmp, b"tmp-remnant-sentinel").unwrap();
        fs::write(&corrupt, b"corrupt-remnant-sentinel").unwrap();

        store
            .write(key, &json!([{"id": "migrated", "url": ""}]))
            .unwrap();

        assert_eq!(fs::read(store.backup_path(key)).unwrap(), safe_backup);
        assert!(!tmp.exists());
        assert!(!corrupt.exists());
    }

    #[test]
    fn failed_epg_safe_write_keeps_unsafe_primary_for_retry_without_backup() {
        let directory = TestDirectory::new("unsafe-epg-failed-rewrite");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:epg-sources";
        let legacy = json!([{"id": "epg-1", "url": "https://guide.example.test/feed.xml"}]);
        let original = serde_json::to_vec(&legacy).unwrap();
        fs::write(store.path(key), &original).unwrap();

        let error = store
            .write(key, &json!("x".repeat(MAX_STATE_BYTES)))
            .unwrap_err();

        assert!(error.contains("too large"));
        assert_eq!(fs::read(store.path(key)).unwrap(), original);
        assert!(!store.backup_path(key).exists());
        assert!(store.read(key).unwrap().requires_safe_rewrite);
    }

    #[test]
    fn unsafe_legacy_playlist_is_returned_only_with_explicit_flag() {
        let directory = TestDirectory::new("unsafe-read-metadata");
        let store = Store::new(directory.0.clone());
        let key = "playlist:snapshot";
        let legacy = json!({"url": "http://tv/live/alice/s3cret/123.ts"});
        fs::write(store.path(key), serde_json::to_vec(&legacy).unwrap()).unwrap();

        let loaded = store.read(key).unwrap();

        assert_eq!(loaded.value, Some(legacy));
        assert_eq!(loaded.schema_version, Some(0));
        assert!(loaded.unsafe_legacy_playlist);
        assert!(!loaded.quarantined);
    }

    #[test]
    fn unsafe_saved_sources_envelope_is_flagged_without_quarantine() {
        let directory = TestDirectory::new("unsafe-saved-sources-read");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:saved-sources";
        let value = json!({"nested": {"apiKey": "plain-secret"}});
        let envelope = StateEnvelope {
            format: ENVELOPE_MAGIC.to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            value: value.clone(),
        };
        fs::write(store.path(key), serde_json::to_vec(&envelope).unwrap()).unwrap();

        let loaded = store.read(key).unwrap();

        assert_eq!(loaded.value, Some(value));
        assert!(loaded.unsafe_legacy_playlist);
        assert!(!loaded.quarantined);
        assert!(store.path(key).exists());
    }

    #[test]
    fn application_value_with_schema_version_is_legacy_not_an_envelope() {
        let directory = TestDirectory::new("schema-version-value");
        let store = Store::new(directory.0.clone());
        let value = json!({"schemaVersion": 99, "theme": "dark"});
        fs::write(store.path("settings"), serde_json::to_vec(&value).unwrap()).unwrap();

        let loaded = store.read("settings").unwrap();

        assert_eq!(loaded.value, Some(value));
        assert_eq!(loaded.schema_version, Some(0));
    }

    #[test]
    fn exact_ddeedd2_envelope_remains_readable() {
        let directory = TestDirectory::new("old-envelope");
        let store = Store::new(directory.0.clone());
        fs::write(
            store.path("settings"),
            serde_json::to_vec(&json!({"schemaVersion": 1, "value": {"theme": "dark"}})).unwrap(),
        )
        .unwrap();

        let loaded = store.read("settings").unwrap();

        assert_eq!(loaded.value, Some(json!({"theme": "dark"})));
        assert_eq!(loaded.schema_version, Some(1));
    }

    #[test]
    fn ddeedd2_playlist_envelope_with_missed_credentials_is_flagged_for_rewrite() {
        let directory = TestDirectory::new("old-unsafe-envelope");
        let store = Store::new(directory.0.clone());
        let key = "playlist:snapshot";
        fs::write(
            store.path(key),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "value": {"url": "http://tv/live/alice/secret/123.ts"}
            }))
            .unwrap(),
        )
        .unwrap();

        let loaded = store.read(key).unwrap();

        assert!(loaded.unsafe_legacy_playlist);
        assert_eq!(
            loaded.value,
            Some(json!({"url": "http://tv/live/alice/secret/123.ts"}))
        );
    }

    #[test]
    fn unsafe_legacy_playlist_primary_is_never_backed_up() {
        let directory = TestDirectory::new("unsafe-backup");
        let store = Store::new(directory.0.clone());
        let key = "playlist:snapshot";
        let secret = "plain-text-password-marker";
        fs::write(
            store.path(key),
            serde_json::to_vec(
                &json!({"url": format!("http://tv/get.php?username=u&password={secret}")}),
            )
            .unwrap(),
        )
        .unwrap();

        store.write(key, &json!({"migrated": true})).unwrap();

        assert!(!store.backup_path(key).exists());
        for entry in fs::read_dir(&directory.0).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains(secret));
        }
    }

    #[test]
    fn unsafe_current_envelope_never_replaces_an_existing_safe_backup() {
        let directory = TestDirectory::new("unsafe-envelope-backup");
        let store = Store::new(directory.0.clone());
        let key = "iptv-player:saved-sources";
        store
            .write(key, &json!({"safe": "last-known-good"}))
            .unwrap();
        store.write(key, &json!({"safe": "newer"})).unwrap();
        let safe_backup = fs::read(store.backup_path(key)).unwrap();
        let unsafe_envelope = StateEnvelope {
            format: ENVELOPE_MAGIC.to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            value: json!({"accessToken": "plain-secret"}),
        };
        fs::write(
            store.path(key),
            serde_json::to_vec(&unsafe_envelope).unwrap(),
        )
        .unwrap();

        store.write(key, &json!({"migrated": true})).unwrap();

        assert_eq!(fs::read(store.backup_path(key)).unwrap(), safe_backup);
    }

    #[test]
    fn replacing_unsafe_primary_preserves_safe_backup_until_primary_succeeds() {
        let directory = TestDirectory::new("unsafe-safe-lkg");
        let store = Store::new(directory.0.clone());
        let key = "playlist:snapshot";
        store
            .write(key, &json!({"safe": "last-known-good"}))
            .unwrap();
        store.write(key, &json!({"safe": "newer"})).unwrap();
        fs::write(
            store.path(key),
            serde_json::to_vec(&json!({"url": "http://alice:secret@tv/list"})).unwrap(),
        )
        .unwrap();
        let backup_before = fs::read(store.backup_path(key)).unwrap();

        store.write(key, &json!({"migrated": true})).unwrap();

        assert_eq!(fs::read(store.backup_path(key)).unwrap(), backup_before);
        assert_eq!(
            store.read(key).unwrap().value,
            Some(json!({"migrated": true}))
        );
    }

    #[test]
    fn unsafe_corrupt_files_are_deleted_instead_of_quarantined() {
        let directory = TestDirectory::new("unsafe-corrupt-delete");
        let store = Store::new(directory.0.clone());
        let key = "playlist:snapshot";
        fs::write(store.path(key), b"{broken password=plain-secret").unwrap();

        let loaded = store.read(key).unwrap();

        assert!(!loaded.exists);
        assert!(loaded.corrupt);
        assert!(!loaded.quarantined);
        assert!(!store.path(key).exists());
        assert!(fs::read_dir(&directory.0).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("corrupt")));
    }

    #[test]
    fn safe_rewrite_securely_deletes_an_unsafe_backup_after_primary_succeeds() {
        let directory = TestDirectory::new("unsafe-backup-rewrite");
        let store = Store::new(directory.0.clone());
        let key = "playlist:snapshot";
        let unsafe_backup = json!({"url": "http://tv/movie/alice/secret/456.mkv"});
        fs::write(
            store.backup_path(key),
            serde_json::to_vec(&unsafe_backup).unwrap(),
        )
        .unwrap();

        let loaded = store.read(key).unwrap();
        assert!(loaded.unsafe_legacy_playlist);
        assert!(store.backup_path(key).exists());

        store.write(key, &json!({"sanitized": true})).unwrap();

        assert!(!store.backup_path(key).exists());
        assert_eq!(
            store.read(key).unwrap().value,
            Some(json!({"sanitized": true}))
        );
    }

    #[test]
    fn temporary_files_owned_by_other_operations_are_not_deleted() {
        let directory = TestDirectory::new("temp-cleanup");
        let store = Store::new(directory.0.clone());
        let stale = directory.0.join(format!(
            "{}.tmp-stale",
            store
                .path("settings")
                .file_name()
                .unwrap()
                .to_string_lossy()
        ));
        fs::write(&stale, b"stale").unwrap();

        store.write("settings", &json!(1)).unwrap();

        assert!(stale.exists());
    }

    #[test]
    fn concurrent_writes_are_serialized_without_torn_json() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let directory = TestDirectory::new("concurrent");
        let store = Arc::new(Store::new(directory.0.clone()));
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|writer| {
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    for sequence in 0..20 {
                        let marker = format!("writer-{writer}-sequence-{sequence}");
                        store
                            .write(
                                "shared",
                                &json!({"marker": marker, "pad": "x".repeat(4096)}),
                            )
                            .unwrap();
                        let loaded = store.read("shared").unwrap();
                        assert!(loaded.value.unwrap()["marker"]
                            .as_str()
                            .unwrap()
                            .starts_with("writer-"));
                    }
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }
        assert!(store.read("shared").unwrap().exists);
    }
}
