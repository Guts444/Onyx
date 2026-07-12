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

/// App-state files are capped at 16 MiB, including the version envelope. This is
/// large enough for local UI snapshots while bounding memory and disk usage.
pub const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;
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
}

pub struct Store {
    directory: PathBuf,
}

impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
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
        if serialized.len() > MAX_STATE_BYTES {
            return Err(format!(
                "The app state is too large (maximum {MAX_STATE_BYTES} bytes)."
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
            if loaded.unsafe_bytes {
                secure_delete_best_effort(&backup)?;
            }
        }
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
        let primary = self.path(key);
        let backup = self.backup_path(key);
        if !primary.exists() {
            return self.read_backup(key, &backup, false, false);
        }

        let loaded = self.load_file(key, &primary)?;
        match loaded.parsed {
            Ok(parsed) => Ok(outcome_from_parsed(parsed, false, false, false)),
            Err(_) => {
                let quarantined = dispose_invalid(&primary, loaded.unsafe_bytes)?;
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
                let backup_quarantined = dispose_invalid(backup, loaded.unsafe_bytes)?;
                Ok(missing_outcome(true, quarantined || backup_quarantined))
            }
        }
    }

    fn load_file(&self, key: &str, path: &Path) -> Result<LoadedState, String> {
        let bytes = read_bounded(path)?;
        let unsafe_bytes = contains_unsafe_credentials(key, &bytes);
        let parsed = parse_state(key, &bytes);
        Ok(LoadedState {
            bytes,
            parsed,
            unsafe_bytes,
        })
    }

    fn prepare_directory(&self) -> Result<(), String> {
        fs::create_dir_all(&self.directory)
            .map_err(|error| format!("Could not create the app state directory: {error}"))?;
        restrict_directory_permissions(&self.directory)
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
        let unsafe_legacy_playlist = value_contains_credentials(&envelope.value);
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
    ReadOutcome {
        exists: true,
        value: Some(parsed.value),
        schema_version: Some(parsed.schema_version),
        recovered,
        corrupt,
        quarantined,
        unsafe_legacy_playlist: parsed.unsafe_legacy_playlist,
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
    }
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| format!("Could not open app state: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("Could not inspect app state: {error}"))?
        .len();
    if length > MAX_STATE_BYTES as u64 {
        return Err("The app state is too large to read safely.".to_string());
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take((MAX_STATE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read app state: {error}"))?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err("The app state is too large to read safely.".to_string());
    }
    Ok(bytes)
}

fn contains_unsafe_credentials(_key: &str, bytes: &[u8]) -> bool {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        return value_contains_credentials(&value);
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

    if let Ok(url) = reqwest::Url::parse(text) {
        if !url.username().is_empty() || url.password().is_some() {
            return true;
        }
        if url
            .query_pairs()
            .any(|(name, value)| !value.is_empty() && is_sensitive_name(&name))
        {
            return true;
        }
    }

    contains_xtream_path(&lower)
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

fn dispose_invalid(path: &Path, unsafe_bytes: bool) -> Result<bool, String> {
    if unsafe_bytes {
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
