use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

/// App-state files are capped at 16 MiB, including the version envelope. This is
/// large enough for local UI snapshots while bounding memory and disk usage.
pub const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;
pub const CURRENT_SCHEMA_VERSION: u32 = 1;
const MAX_KEY_BYTES: usize = 160;

static UNIQUE_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static KEY_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateEnvelope {
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
}

struct ParsedState {
    value: Value,
    schema_version: u32,
    unsafe_legacy_playlist: bool,
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

    pub fn write(&self, key: &str, value: &Value) -> Result<(), String> {
        Self::validate_key(key)?;
        let serialized = serde_json::to_vec(&StateEnvelope {
            schema_version: CURRENT_SCHEMA_VERSION,
            value: value.clone(),
        })
        .map_err(|error| format!("Could not serialize the app state: {error}"))?;
        if is_unsafe_legacy_playlist(key, &serialized) {
            return Err(
                "Playlist snapshots containing credentials cannot be persisted; use the OS credential store."
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
        self.cleanup_temporary_files(key)?;

        let primary = self.path(key);
        let backup = self.backup_path(key);
        if primary.exists() {
            match self.read_and_parse(key, &primary) {
                Ok(parsed) if !parsed.unsafe_legacy_playlist => {
                    let bytes = read_bounded(&primary)?;
                    atomic_write(&backup, &bytes)?;
                }
                Ok(_) => {
                    remove_if_exists(&backup)?;
                }
                Err(_) => {}
            }
        }

        atomic_write(&primary, &serialized)?;
        Ok(())
    }

    pub fn read(&self, key: &str) -> Result<ReadOutcome, String> {
        Self::validate_key(key)?;
        let key_lock = self.lock_for(key);
        let _guard = key_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.directory.exists() {
            self.cleanup_temporary_files(key)?;
        }
        self.read_locked(key)
    }

    fn read_locked(&self, key: &str) -> Result<ReadOutcome, String> {
        let primary = self.path(key);
        let backup = self.backup_path(key);
        if !primary.exists() {
            if !backup.exists() {
                return Ok(missing_outcome(false, false));
            }
            return match self.read_and_parse(key, &backup) {
                Ok(parsed) if !parsed.unsafe_legacy_playlist => {
                    let bytes = read_bounded(&backup)?;
                    atomic_write(&primary, &bytes)?;
                    Ok(outcome_from_parsed(parsed, true, false, false))
                }
                Ok(_) | Err(_) => {
                    let quarantined = quarantine(&backup)?;
                    Ok(missing_outcome(true, quarantined))
                }
            };
        }

        match self.read_and_parse(key, &primary) {
            Ok(parsed) => Ok(outcome_from_parsed(parsed, false, false, false)),
            Err(_) => {
                let primary_quarantined = quarantine(&primary)?;
                if backup.exists() {
                    match self.read_and_parse(key, &backup) {
                        Ok(parsed) if !parsed.unsafe_legacy_playlist => {
                            let bytes = read_bounded(&backup)?;
                            atomic_write(&primary, &bytes)?;
                            return Ok(outcome_from_parsed(
                                parsed,
                                true,
                                true,
                                primary_quarantined,
                            ));
                        }
                        Ok(_) | Err(_) => {
                            let backup_quarantined = quarantine(&backup)?;
                            return Ok(missing_outcome(
                                true,
                                primary_quarantined || backup_quarantined,
                            ));
                        }
                    }
                }
                Ok(missing_outcome(true, primary_quarantined))
            }
        }
    }

    fn read_and_parse(&self, key: &str, path: &Path) -> Result<ParsedState, String> {
        let bytes = read_bounded(path)?;
        let raw: Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not parse the app state: {error}"))?;

        if raw.get("schemaVersion").is_some() {
            let envelope: StateEnvelope = serde_json::from_value(raw)
                .map_err(|error| format!("Could not validate the app state: {error}"))?;
            if envelope.schema_version != CURRENT_SCHEMA_VERSION {
                return Err(format!(
                    "Unsupported app state schema version {}.",
                    envelope.schema_version
                ));
            }
            return Ok(ParsedState {
                value: envelope.value,
                schema_version: envelope.schema_version,
                unsafe_legacy_playlist: false,
            });
        }

        let unsafe_legacy_playlist = is_unsafe_legacy_playlist(key, &bytes);
        Ok(ParsedState {
            value: raw,
            schema_version: 0,
            unsafe_legacy_playlist,
        })
    }

    fn prepare_directory(&self) -> Result<(), String> {
        fs::create_dir_all(&self.directory)
            .map_err(|error| format!("Could not create the app state directory: {error}"))?;
        restrict_directory_permissions(&self.directory)
    }

    fn cleanup_temporary_files(&self, key: &str) -> Result<(), String> {
        let prefixes = [
            format!(
                "{}.tmp-",
                self.path(key).file_name().unwrap().to_string_lossy()
            ),
            format!(
                "{}.tmp-",
                self.backup_path(key).file_name().unwrap().to_string_lossy()
            ),
        ];
        for entry in fs::read_dir(&self.directory)
            .map_err(|error| format!("Could not inspect the app state directory: {error}"))?
        {
            let entry = entry.map_err(|error| format!("Could not inspect app state: {error}"))?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if prefixes.iter().any(|prefix| name.starts_with(prefix)) {
                remove_if_exists(&entry.path())?;
            }
        }
        Ok(())
    }
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

fn is_unsafe_legacy_playlist(key: &str, bytes: &[u8]) -> bool {
    if !key.to_ascii_lowercase().contains("playlist") {
        return false;
    }
    let lower = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    [
        "password=",
        "username=",
        "\"password\"",
        "\"credential",
        "authorization",
        "bearer ",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn atomic_write(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "The app state path has no parent directory.".to_string())?;
    let name = destination
        .file_name()
        .ok_or_else(|| "The app state path has no file name.".to_string())?
        .to_string_lossy();
    let id = UNIQUE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = parent.join(format!("{name}.tmp-{}-{id}", std::process::id()));

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

fn quarantine(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let id = UNIQUE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let destination = path.with_file_name(format!("{name}.corrupt-{}-{id}", std::process::id()));
    fs::rename(path, destination)
        .map_err(|error| format!("Could not quarantine corrupt app state: {error}"))?;
    Ok(true)
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
    fn oversize_payload_is_rejected_without_touching_primary() {
        let directory = TestDirectory::new("oversize");
        let store = Store::new(directory.0.clone());
        let oversized = json!("x".repeat(MAX_STATE_BYTES));

        let error = store.write("large", &oversized).unwrap_err();

        assert!(error.contains("too large"));
        assert!(!store.path("large").exists());
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
    fn stale_temporary_files_are_cleaned_before_write() {
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

        assert!(!stale.exists());
        assert!(fs::read_dir(&directory.0).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp-")));
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
