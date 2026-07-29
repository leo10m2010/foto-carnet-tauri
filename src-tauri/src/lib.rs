use aes_gcm::aead::{Aead, Generate, Key, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use atomic_write_file::AtomicWriteFile;
use base64::Engine;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use rayon::prelude::*;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, Metadata};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{Emitter, Manager};
use zeroize::Zeroizing;

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "bmp", "webp", "gif"];
const DATA_EXTS: &[&str] = &["csv", "xlsx", "xls"];
const MAX_DIM: u32 = 1600;
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_DATA_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGE_DIM: u32 = 12_000;
const MAX_IMAGE_PIXELS: u64 = 32_000_000;
const MAX_BATCH_FILES: usize = 1_000;
const MAX_BATCH_BYTES: u64 = 200 * 1024 * 1024;
const MAX_BATCH_PIXELS: u64 = 96_000_000;
const MAX_INSPECTION_SOURCE_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_DECODE_CONCURRENCY: usize = 2;
const MAX_DECODED_BYTES: u64 = 256 * 1024 * 1024;
const DECODED_BYTES_PER_PIXEL: u64 = 8;
const FILE_CACHE_BYTES: usize = 64 * 1024 * 1024;
const THUMB_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_FOLDER_IMAGES: usize = 1_000;
const MAX_FOLDER_DIRECTORIES: usize = 2_048;
const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
const MAX_PRINT_HTML_BYTES: usize = 25 * 1024 * 1024;
const MAX_SAVE_BYTES: usize = 100 * 1024 * 1024;
const PRINT_FILE_PREFIX: &str = "fotocarnet-preview-";
const PRINT_FILE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const UPDATE_RELEASES_URL: &str =
    "https://api.github.com/repos/leo10m2010/foto-carnet-tauri/releases?per_page=100";
const MAX_SECURE_SESSION_BYTES: usize = 16 * 1024 * 1024;
const SESSION_FILE_NAME: &str = "secure-session-v1.bin";
const SESSION_FILE_MAGIC: &[u8; 4] = b"FCS1";
const SESSION_AAD: &[u8] = b"FotoCarnet secure session v1";
const KEYRING_SERVICE: &str = "com.fotocarnet.desktop";
const SESSION_KEYRING_USER: &str = "session-encryption-key-v1";
const RENIEC_KEYRING_USER: &str = "reniec-api-token-v1";
const ERR_SESSION_TOO_LARGE: &str = "La sesión supera el tamaño máximo permitido";
const ERR_SESSION_FORMAT: &str = "La sesión no tiene un formato válido";
const ERR_SESSION_SAVE: &str = "No se pudo guardar la sesión segura";
const ERR_SESSION_LOAD: &str = "No se pudo abrir la sesión segura";
const ERR_SESSION_CLEAR: &str = "No se pudo eliminar la sesión segura";
const ERR_TOKEN_STORE: &str = "No se pudo guardar el token RENIEC de forma segura";
const ERR_TOKEN_LOAD: &str = "No se pudo leer el token RENIEC guardado";
const ERR_TOKEN_CLEAR: &str = "No se pudo eliminar el token RENIEC guardado";

// -- App state ----------------------------------------------------------------

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
    path: String,
    max_dim: u32,
}

struct CacheEntry {
    data_url: String,
    fingerprint: SourceFingerprint,
    source_bytes: u64,
    pixels: u64,
    last_used: u64,
}

struct BoundedCache {
    entries: HashMap<CacheKey, CacheEntry>,
    max_entries: usize,
    max_bytes: usize,
    data_url_bytes: usize,
    clock: u64,
}

impl BoundedCache {
    fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            max_entries,
            max_bytes,
            data_url_bytes: 0,
            clock: 0,
        }
    }

    fn next_tick(&mut self) -> u64 {
        self.clock = self.clock.wrapping_add(1);
        self.clock
    }

    fn get(
        &mut self,
        key: &CacheKey,
        fingerprint: Option<&SourceFingerprint>,
    ) -> Option<(String, u64, u64)> {
        let fingerprint = fingerprint?;
        let stale = self
            .entries
            .get(key)
            .is_some_and(|entry| &entry.fingerprint != fingerprint);
        if stale {
            if let Some(entry) = self.entries.remove(key) {
                self.data_url_bytes = self.data_url_bytes.saturating_sub(entry.data_url.len());
            }
            return None;
        }

        let tick = self.next_tick();
        self.entries.get_mut(key).map(|entry| {
            entry.last_used = tick;
            (entry.data_url.clone(), entry.source_bytes, entry.pixels)
        })
    }

    fn insert(
        &mut self,
        key: CacheKey,
        data_url: String,
        fingerprint: SourceFingerprint,
        source_bytes: u64,
        pixels: u64,
    ) {
        if data_url.len() > self.max_bytes {
            return;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.data_url_bytes = self.data_url_bytes.saturating_sub(previous.data_url.len());
        }
        self.data_url_bytes = self.data_url_bytes.saturating_add(data_url.len());
        let last_used = self.next_tick();
        self.entries.insert(
            key,
            CacheEntry {
                data_url,
                fingerprint,
                source_bytes,
                pixels,
                last_used,
            },
        );

        while self.entries.len() > self.max_entries || self.data_url_bytes > self.max_bytes {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.data_url_bytes = self.data_url_bytes.saturating_sub(entry.data_url.len());
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.data_url_bytes = 0;
    }
}

#[derive(Default)]
struct WatcherSlot {
    debouncer: Option<Debouncer<RecommendedWatcher, FileIdMap>>,
    watched_path: Option<String>,
}

struct AppState {
    file_cache: Arc<Mutex<BoundedCache>>,
    thumb_cache: Arc<Mutex<BoundedCache>>,
    watcher: Mutex<WatcherSlot>,
    filesystem_authority: Arc<Mutex<FilesystemAuthority>>,
    http_client: reqwest::Client,
    decode_pool: Arc<rayon::ThreadPool>,
    decode_budget: Arc<DecodeBudget>,
    secure_storage: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceFingerprint {
    source_bytes: u64,
    modified: SystemTime,
    file_identity: Option<FileIdentity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity {
    volume: u64,
    index: u64,
}

struct AuthorizedFile {
    file: File,
    resolved_path: PathBuf,
    metadata: Metadata,
    fingerprint: Option<SourceFingerprint>,
}

struct AuthorizedFolder {
    _file: File,
    resolved_path: PathBuf,
    identity: Option<FileIdentity>,
}

#[derive(Default)]
struct FilesystemAuthority {
    picker_read_files: HashMap<PathBuf, Option<FileIdentity>>,
    picker_read_folders: HashMap<PathBuf, Option<FileIdentity>>,
    session_read_files: HashMap<PathBuf, Option<FileIdentity>>,
    session_read_folders: HashMap<PathBuf, Option<FileIdentity>>,
    approved_save_paths: HashSet<PathBuf>,
}

impl FilesystemAuthority {
    fn register_picker_file(&mut self, path: &Path) -> Result<PathBuf, String> {
        let opened = open_secure_file(path)?;
        let identity = file_identity(&opened.file)?;
        self.picker_read_files
            .insert(opened.resolved_path.clone(), identity);
        Ok(opened.resolved_path)
    }

    fn register_picker_folder(&mut self, path: &Path) -> Result<PathBuf, String> {
        let opened = open_secure_folder(path)?;
        self.picker_read_folders
            .insert(opened.resolved_path.clone(), opened.identity.clone());
        Ok(opened.resolved_path)
    }

    fn register_native_drop(&mut self, paths: &[PathBuf]) {
        for path in paths
            .iter()
            .filter(|path| (is_image_path(path) || is_data_path(path)) && path.is_file())
            .take(MAX_BATCH_FILES)
        {
            let _ = self.register_picker_file(path);
        }
    }

    fn read_snapshot(&self) -> Self {
        Self {
            picker_read_files: self.picker_read_files.clone(),
            picker_read_folders: self.picker_read_folders.clone(),
            session_read_files: self.session_read_files.clone(),
            session_read_folders: self.session_read_folders.clone(),
            approved_save_paths: HashSet::new(),
        }
    }

    fn open_authorized_file(&self, path: &Path) -> Result<AuthorizedFile, String> {
        let opened = open_secure_file(path)?;
        let opened_identity = file_identity(&opened.file)?;
        let exact = self
            .picker_read_files
            .get(&opened.resolved_path)
            .or_else(|| self.session_read_files.get(&opened.resolved_path))
            .is_some_and(|approved_identity| identities_match(approved_identity, &opened_identity));
        let in_approved_folder = self
            .picker_read_folders
            .iter()
            .chain(&self.session_read_folders)
            .any(|(folder, identity)| {
                path_is_within(&opened.resolved_path, folder)
                    && folder_grant_is_current(folder, identity)
            });
        if exact || in_approved_folder {
            Ok(opened)
        } else {
            Err("La ruta no fue autorizada por el usuario".to_string())
        }
    }

    fn open_authorized_folder(&self, path: &Path) -> Result<AuthorizedFolder, String> {
        let opened = open_secure_folder(path)?;
        let approved = self
            .picker_read_folders
            .iter()
            .chain(&self.session_read_folders)
            .any(|(folder, identity)| {
                path_is_within(&opened.resolved_path, folder)
                    && if opened.resolved_path == *folder {
                        identities_match(identity, &opened.identity)
                    } else {
                        folder_grant_is_current(folder, identity)
                    }
            });
        if approved {
            Ok(opened)
        } else {
            Err("La carpeta no fue autorizada por el usuario".to_string())
        }
    }

    fn replace_session_authorizations(&mut self, paths: &SessionAuthorizationPaths) {
        self.session_read_files.clear();
        self.session_read_folders.clear();
        for path in &paths.files {
            if is_image_path(path) {
                if let Ok(opened) = open_secure_file(path) {
                    if let Ok(identity) = file_identity(&opened.file) {
                        self.session_read_files
                            .insert(opened.resolved_path, identity);
                    }
                }
            }
        }
        if let Some(folder) = &paths.watched_folder {
            if let Ok(opened) = open_secure_folder(folder) {
                self.session_read_folders
                    .insert(opened.resolved_path, opened.identity);
            }
        }
    }

    fn clear_session(&mut self) {
        self.session_read_files.clear();
        self.session_read_folders.clear();
    }

    fn register_save_path(&mut self, path: &Path) -> Result<PathBuf, String> {
        let normalized = normalize_save_path(path)?;
        self.approved_save_paths.insert(normalized.clone());
        Ok(normalized)
    }

    fn consume_save_path(&mut self, path: &Path) -> Result<PathBuf, String> {
        let normalized = normalize_save_path(path)?;
        if self.approved_save_paths.remove(&normalized) {
            Ok(normalized)
        } else {
            Err("La ruta de guardado no fue autorizada o ya fue utilizada".to_string())
        }
    }

    fn clear_all(&mut self) {
        self.picker_read_files.clear();
        self.picker_read_folders.clear();
        self.clear_session();
        self.approved_save_paths.clear();
    }
}

#[derive(Debug, Default, Eq, PartialEq)]
struct SessionAuthorizationPaths {
    files: Vec<PathBuf>,
    watched_folder: Option<PathBuf>,
}

#[derive(Default)]
struct DecodeBudgetState {
    decoded_bytes: u64,
    active_decodes: usize,
}

struct DecodeBudget {
    state: Mutex<DecodeBudgetState>,
    available: Condvar,
}

impl DecodeBudget {
    fn new() -> Self {
        Self {
            state: Mutex::new(DecodeBudgetState::default()),
            available: Condvar::new(),
        }
    }

    fn acquire(&self, decoded_bytes: u64) -> Result<DecodePermit<'_>, String> {
        if decoded_bytes > MAX_DECODED_BYTES {
            return Err("La imagen supera el presupuesto de memoria de decodificación".to_string());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "No se pudo reservar memoria para la imagen".to_string())?;
        while state.active_decodes >= MAX_DECODE_CONCURRENCY
            || state.decoded_bytes.saturating_add(decoded_bytes) > MAX_DECODED_BYTES
        {
            state = self
                .available
                .wait(state)
                .map_err(|_| "No se pudo reservar memoria para la imagen".to_string())?;
        }
        state.active_decodes += 1;
        state.decoded_bytes += decoded_bytes;
        Ok(DecodePermit {
            budget: self,
            decoded_bytes,
        })
    }

    #[cfg(test)]
    fn try_acquire(&self, decoded_bytes: u64) -> Option<DecodePermit<'_>> {
        if decoded_bytes > MAX_DECODED_BYTES {
            return None;
        }
        let mut state = self.state.lock().ok()?;
        if state.active_decodes >= MAX_DECODE_CONCURRENCY
            || state.decoded_bytes.saturating_add(decoded_bytes) > MAX_DECODED_BYTES
        {
            return None;
        }
        state.active_decodes += 1;
        state.decoded_bytes += decoded_bytes;
        Some(DecodePermit {
            budget: self,
            decoded_bytes,
        })
    }
}

struct DecodePermit<'a> {
    budget: &'a DecodeBudget,
    decoded_bytes: u64,
}

impl Drop for DecodePermit<'_> {
    fn drop(&mut self) {
        let mut state = self
            .budget
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.decoded_bytes = state.decoded_bytes.saturating_sub(self.decoded_bytes);
        state.active_decodes = state.active_decodes.saturating_sub(1);
        self.budget.available.notify_all();
    }
}

struct BatchBudget {
    bytes: AtomicU64,
    pixels: AtomicU64,
}

impl BatchBudget {
    fn new() -> Self {
        Self {
            bytes: AtomicU64::new(0),
            pixels: AtomicU64::new(0),
        }
    }

    fn reserve_bytes(&self, amount: u64) -> Result<(), String> {
        reserve_atomic(&self.bytes, amount, MAX_BATCH_BYTES)
            .map_err(|_| "El lote supera el límite total de 200 MB".to_string())
    }

    fn reserve_pixels(&self, amount: u64) -> Result<(), String> {
        reserve_atomic(&self.pixels, amount, MAX_BATCH_PIXELS)
            .map_err(|_| "El lote supera el límite total de 96 megapíxeles".to_string())
    }
}

fn reserve_atomic(counter: &AtomicU64, amount: u64, limit: u64) -> Result<(), ()> {
    let mut current = counter.load(Ordering::Relaxed);
    loop {
        let next = current.checked_add(amount).ok_or(())?;
        if next > limit {
            return Err(());
        }
        match counter.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Relaxed) {
            Ok(_) => return Ok(()),
            Err(observed) => current = observed,
        }
    }
}

// -- Secure persistence --------------------------------------------------------

fn encrypt_session_payload(payload: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() > MAX_SECURE_SESSION_BYTES {
        return Err(ERR_SESSION_TOO_LARGE.to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ERR_SESSION_SAVE.to_string())?;
    let nonce = aes_gcm::Nonce::generate();
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: payload,
                aad: SESSION_AAD,
            },
        )
        .map_err(|_| ERR_SESSION_SAVE.to_string())?;
    let mut encrypted =
        Vec::with_capacity(SESSION_FILE_MAGIC.len() + nonce.len() + ciphertext.len());
    encrypted.extend_from_slice(SESSION_FILE_MAGIC);
    encrypted.extend_from_slice(&nonce);
    encrypted.extend_from_slice(&ciphertext);
    Ok(encrypted)
}

fn decrypt_session_payload(encrypted: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    const NONCE_BYTES: usize = 12;
    const TAG_BYTES: usize = 16;
    let minimum_size = SESSION_FILE_MAGIC.len() + NONCE_BYTES + TAG_BYTES;
    if encrypted.len() < minimum_size
        || encrypted.len() > MAX_SECURE_SESSION_BYTES + minimum_size
        || !encrypted.starts_with(SESSION_FILE_MAGIC)
    {
        return Err(ERR_SESSION_LOAD.to_string());
    }
    let nonce_start = SESSION_FILE_MAGIC.len();
    let ciphertext_start = nonce_start + NONCE_BYTES;
    let nonce = aes_gcm::Nonce::try_from(&encrypted[nonce_start..ciphertext_start])
        .map_err(|_| ERR_SESSION_LOAD.to_string())?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ERR_SESSION_LOAD.to_string())?;
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &encrypted[ciphertext_start..],
                aad: SESSION_AAD,
            },
        )
        .map_err(|_| ERR_SESSION_LOAD.to_string())?;
    if plaintext.len() > MAX_SECURE_SESSION_BYTES {
        return Err(ERR_SESSION_TOO_LARGE.to_string());
    }
    Ok(plaintext)
}

fn credential_entry(username: &str, error: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, username).map_err(|_| error.to_string())
}

fn load_session_key() -> Result<Zeroizing<Vec<u8>>, String> {
    let entry = credential_entry(SESSION_KEYRING_USER, ERR_SESSION_LOAD)?;
    let key = Zeroizing::new(
        entry
            .get_secret()
            .map_err(|_| ERR_SESSION_LOAD.to_string())?,
    );
    if key.len() != 32 {
        return Err(ERR_SESSION_LOAD.to_string());
    }
    Ok(key)
}

fn load_or_create_session_key() -> Result<Zeroizing<Vec<u8>>, String> {
    let entry = credential_entry(SESSION_KEYRING_USER, ERR_SESSION_SAVE)?;
    match entry.get_secret() {
        Ok(key) if key.len() == 32 => Ok(Zeroizing::new(key)),
        Ok(_) => Err(ERR_SESSION_SAVE.to_string()),
        Err(keyring::Error::NoEntry) => {
            let key = Key::<Aes256Gcm>::generate();
            entry
                .set_secret(&key)
                .map_err(|_| ERR_SESSION_SAVE.to_string())?;
            Ok(Zeroizing::new(key.to_vec()))
        }
        Err(_) => Err(ERR_SESSION_SAVE.to_string()),
    }
}

fn delete_credential(username: &str, error: &str) -> Result<(), String> {
    let entry = credential_entry(username, error)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(error.to_string()),
    }
}

fn write_secure_session(path: &Path, session_json: String) -> Result<(), String> {
    if session_json.len() > MAX_SECURE_SESSION_BYTES {
        return Err(ERR_SESSION_TOO_LARGE.to_string());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&session_json).map_err(|_| ERR_SESSION_FORMAT.to_string())?;
    if !parsed.is_object() {
        return Err(ERR_SESSION_FORMAT.to_string());
    }
    let key = load_or_create_session_key()?;
    let encrypted = encrypt_session_payload(session_json.as_bytes(), &key)?;
    let parent = path.parent().ok_or_else(|| ERR_SESSION_SAVE.to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| ERR_SESSION_SAVE.to_string())?;
    let mut file = AtomicWriteFile::options()
        .open(path)
        .map_err(|_| ERR_SESSION_SAVE.to_string())?;
    file.write_all(&encrypted)
        .map_err(|_| ERR_SESSION_SAVE.to_string())?;
    file.commit().map_err(|_| ERR_SESSION_SAVE.to_string())
}

fn read_secure_session(path: &Path) -> Result<Option<String>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ERR_SESSION_LOAD.to_string()),
    };
    let maximum_file_bytes = MAX_SECURE_SESSION_BYTES + SESSION_FILE_MAGIC.len() + 12 + 16;
    if file
        .metadata()
        .map_err(|_| ERR_SESSION_LOAD.to_string())?
        .len()
        > maximum_file_bytes as u64
    {
        return Err(ERR_SESSION_LOAD.to_string());
    }
    let mut encrypted = Vec::new();
    file.take(maximum_file_bytes as u64 + 1)
        .read_to_end(&mut encrypted)
        .map_err(|_| ERR_SESSION_LOAD.to_string())?;
    if encrypted.len() > maximum_file_bytes {
        return Err(ERR_SESSION_LOAD.to_string());
    }
    let key = load_session_key()?;
    let plaintext = decrypt_session_payload(&encrypted, &key)?;
    let session_json = String::from_utf8(plaintext).map_err(|_| ERR_SESSION_LOAD.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&session_json).map_err(|_| ERR_SESSION_LOAD.to_string())?;
    if !parsed.is_object() {
        return Err(ERR_SESSION_LOAD.to_string());
    }
    Ok(Some(session_json))
}

fn remove_secure_session(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(ERR_SESSION_CLEAR.to_string()),
    }
    delete_credential(SESSION_KEYRING_USER, ERR_SESSION_CLEAR)
}

#[tauri::command]
async fn save_secure_session(
    session_json: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let secure_storage = Arc::clone(&state.secure_storage);
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| ERR_SESSION_SAVE.to_string())?
        .join(SESSION_FILE_NAME);
    let _guard = secure_storage.lock().await;
    tauri::async_runtime::spawn_blocking(move || write_secure_session(&path, session_json))
        .await
        .map_err(|_| ERR_SESSION_SAVE.to_string())?
}

#[tauri::command]
async fn load_secure_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let secure_storage = Arc::clone(&state.secure_storage);
    let filesystem_authority = Arc::clone(&state.filesystem_authority);
    filesystem_authority
        .lock()
        .map_err(|_| ERR_SESSION_LOAD.to_string())?
        .clear_session();
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| ERR_SESSION_LOAD.to_string())?
        .join(SESSION_FILE_NAME);
    let _guard = secure_storage.lock().await;
    let session = tauri::async_runtime::spawn_blocking(move || read_secure_session(&path))
        .await
        .map_err(|_| ERR_SESSION_LOAD.to_string())??;
    let mut authority = filesystem_authority
        .lock()
        .map_err(|_| ERR_SESSION_LOAD.to_string())?;
    if let Some(session_json) = &session {
        let authenticated: serde_json::Value =
            serde_json::from_str(session_json).map_err(|_| ERR_SESSION_LOAD.to_string())?;
        authority
            .replace_session_authorizations(&extract_session_authorization_paths(&authenticated));
    }
    Ok(session)
}

#[tauri::command]
async fn clear_secure_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let secure_storage = Arc::clone(&state.secure_storage);
    let filesystem_authority = Arc::clone(&state.filesystem_authority);
    filesystem_authority
        .lock()
        .map_err(|_| ERR_SESSION_CLEAR.to_string())?
        .clear_session();
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| ERR_SESSION_CLEAR.to_string())?
        .join(SESSION_FILE_NAME);
    let _guard = secure_storage.lock().await;
    let removal = tauri::async_runtime::spawn_blocking(move || remove_secure_session(&path))
        .await
        .map_err(|_| ERR_SESSION_CLEAR.to_string())?;
    removal
}

#[tauri::command]
async fn get_reniec_token(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let secure_storage = Arc::clone(&state.secure_storage);
    let _guard = secure_storage.lock().await;
    tauri::async_runtime::spawn_blocking(|| {
        let entry = credential_entry(RENIEC_KEYRING_USER, ERR_TOKEN_LOAD)?;
        match entry.get_password() {
            Ok(token) if validate_reniec_token(&token).is_ok() => Ok(Some(token)),
            Ok(_) => Err(ERR_TOKEN_LOAD.to_string()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(ERR_TOKEN_LOAD.to_string()),
        }
    })
    .await
    .map_err(|_| ERR_TOKEN_LOAD.to_string())?
}

#[tauri::command]
async fn set_reniec_token(token: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let token = validate_reniec_token(&token).map_err(|_| "El token RENIEC no es válido")?;
    let secure_storage = Arc::clone(&state.secure_storage);
    let _guard = secure_storage.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        credential_entry(RENIEC_KEYRING_USER, ERR_TOKEN_STORE)?
            .set_password(&token)
            .map_err(|_| ERR_TOKEN_STORE.to_string())
    })
    .await
    .map_err(|_| ERR_TOKEN_STORE.to_string())?
}

#[tauri::command]
async fn clear_reniec_token(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let secure_storage = Arc::clone(&state.secure_storage);
    let _guard = secure_storage.lock().await;
    tauri::async_runtime::spawn_blocking(|| delete_credential(RENIEC_KEYRING_USER, ERR_TOKEN_CLEAR))
        .await
        .map_err(|_| ERR_TOKEN_CLEAR.to_string())?
}

// -- Command types -------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct ReniecResult {
    ok: bool,
    body: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileResult {
    ok: bool,
    #[serde(rename = "dataUrl")]
    data_url: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageInfo {
    ok: bool,
    width: Option<u32>,
    height: Option<u32>,
    format: Option<String>,
    source_bytes: Option<u64>,
    source_version: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct UpdateInfo {
    version: String,
    url: String,
}

#[derive(Debug, Serialize)]
struct ApiError {
    code: String,
    message: String,
}

#[derive(Serialize)]
struct UpdateCheckResult {
    ok: bool,
    update: Option<UpdateInfo>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

fn file_error(message: impl Into<String>) -> FileResult {
    FileResult {
        ok: false,
        data_url: None,
        error: Some(message.into()),
    }
}

fn image_info_error(message: impl Into<String>) -> ImageInfo {
    ImageInfo {
        ok: false,
        width: None,
        height: None,
        format: None,
        source_bytes: None,
        source_version: None,
        error: Some(message.into()),
    }
}

fn api_error(code: &str, message: impl Into<String>) -> ApiError {
    ApiError {
        code: code.to_string(),
        message: message.into(),
    }
}

// -- General helpers -----------------------------------------------------------

fn parse_version(value: &str) -> Option<Version> {
    Version::parse(value.trim().strip_prefix('v').unwrap_or(value.trim())).ok()
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(sanitized_reqwest_error)
}

fn sanitized_reqwest_error(error: reqwest::Error) -> String {
    let _error_without_url = error.without_url();
    "No se pudo completar la solicitud de red".to_string()
}

async fn read_bounded_response(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, ApiError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(api_error(
            "response_too_large",
            "La respuesta remota supera el tamaño permitido",
        ));
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| api_error("network", sanitized_reqwest_error(error)))?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(api_error(
                "response_too_large",
                "La respuesta remota supera el tamaño permitido",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn path_to_string(path: PathBuf) -> Option<String> {
    path.to_str().map(ToOwned::to_owned)
}

fn canonical_existing_file(path: &Path) -> Result<PathBuf, String> {
    open_secure_file(path).map(|opened| opened.resolved_path)
}

fn canonical_existing_folder(path: &Path) -> Result<PathBuf, String> {
    open_secure_folder(path).map(|opened| opened.resolved_path)
}

fn open_secure_file(path: &Path) -> Result<AuthorizedFile, String> {
    #[cfg(windows)]
    absolute_path_without_traversal(path)?;
    #[cfg(not(windows))]
    reject_final_traversal_link(path)?;

    let file = File::open(path).map_err(|_| "No se pudo abrir el archivo de imagen".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "No se pudieron leer los metadatos del archivo".to_string())?;
    if !metadata.is_file() {
        return Err("La ruta no corresponde a un archivo regular".to_string());
    }
    let resolved_path = final_path_for_handle(&file, path)?;
    let fingerprint = source_fingerprint(&file, &metadata).ok();
    Ok(AuthorizedFile {
        file,
        resolved_path,
        metadata,
        fingerprint,
    })
}

fn open_secure_folder(path: &Path) -> Result<AuthorizedFolder, String> {
    #[cfg(windows)]
    {
        absolute_path_without_traversal(path)?;
        let file = open_windows_nofollow(path)
            .map_err(|_| "No se pudo acceder a la carpeta seleccionada".to_string())?;
        let metadata = file
            .metadata()
            .map_err(|_| "No se pudo verificar la carpeta seleccionada".to_string())?;
        if !metadata.is_dir() {
            return Err("La ruta no corresponde a una carpeta regular".to_string());
        }
        let resolved_path = final_path_for_handle(&file, path)?;
        let identity = file_identity(&file)?;
        Ok(AuthorizedFolder {
            _file: file,
            resolved_path,
            identity,
        })
    }
    #[cfg(not(windows))]
    {
        reject_final_traversal_link(path)?;
        let file = File::open(path)
            .map_err(|_| "No se pudo acceder a la carpeta seleccionada".to_string())?;
        let metadata = file
            .metadata()
            .map_err(|_| "No se pudo verificar la carpeta seleccionada".to_string())?;
        if !metadata.is_dir() {
            return Err("La ruta no corresponde a una carpeta regular".to_string());
        }
        let resolved_path = final_path_for_handle(&file, path)?;
        let identity = file_identity(&file)?;
        Ok(AuthorizedFolder {
            _file: file,
            resolved_path,
            identity,
        })
    }
}

#[cfg(not(windows))]
fn reject_final_traversal_link(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "No se pudo verificar la ruta seleccionada".to_string())?;
    if metadata_is_traversal_link(path, &metadata) {
        Err("La ruta atraviesa un enlace no permitido".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn final_path_for_handle(_file: &File, requested_path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(requested_path)
        .map_err(|_| "No se pudo resolver la ruta seleccionada".to_string())
}

#[cfg(windows)]
fn final_path_for_handle(file: &File, _requested_path: &Path) -> Result<PathBuf, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
    let required =
        unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), std::ptr::null_mut(), 0, flags) };
    if required == 0 {
        return Err("No se pudo resolver el archivo abierto".to_string());
    }
    let mut buffer = vec![0u16; required as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            flags,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err("No se pudo resolver el archivo abierto".to_string());
    }
    let path = String::from_utf16(&buffer[..written as usize])
        .map_err(|_| "La ruta seleccionada no es válida".to_string())?;
    Ok(normalize_windows_final_path(&path))
}

#[cfg(windows)]
fn normalize_windows_final_path(path: &str) -> PathBuf {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(dos) = path.strip_prefix(r"\\?\") {
        PathBuf::from(dos)
    } else {
        PathBuf::from(path)
    }
}

#[cfg(windows)]
fn absolute_path_without_traversal(path: &Path) -> Result<PathBuf, String> {
    use std::path::Component;

    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("La ruta seleccionada contiene un recorrido no permitido".to_string());
    }
    Ok(path.to_path_buf())
}

fn path_is_within(path: &Path, authority: &Path) -> bool {
    #[cfg(windows)]
    {
        let path = path.to_string_lossy();
        let authority = authority.to_string_lossy();
        if path.eq_ignore_ascii_case(&authority) {
            return true;
        }
        let authority = authority.trim_end_matches(['\\', '/']);
        path.get(..authority.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(authority))
            && path
                .as_bytes()
                .get(authority.len())
                .is_some_and(|separator| matches!(separator, b'\\' | b'/'))
    }
    #[cfg(not(windows))]
    {
        path == authority || path.starts_with(authority)
    }
}

fn identities_match(approved: &Option<FileIdentity>, current: &Option<FileIdentity>) -> bool {
    approved == current
}

fn folder_grant_is_current(path: &Path, identity: &Option<FileIdentity>) -> bool {
    open_secure_folder(path).is_ok_and(|folder| identities_match(identity, &folder.identity))
}

fn normalize_save_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "La ruta de guardado no es válida".to_string())?;
    if path.exists() {
        let canonical = std::fs::canonicalize(path)
            .map_err(|_| "No se pudo verificar la ruta de guardado".to_string())?;
        let metadata = std::fs::symlink_metadata(&canonical)
            .map_err(|_| "No se pudo verificar la ruta de guardado".to_string())?;
        if !metadata.is_file() || metadata_is_traversal_link(&canonical, &metadata) {
            return Err("La ruta de guardado no corresponde a un archivo regular".to_string());
        }
        return Ok(canonical);
    }
    let parent = path
        .parent()
        .ok_or_else(|| "La ruta de guardado no es válida".to_string())?;
    let canonical_parent = canonical_existing_folder(parent)?;
    Ok(canonical_parent.join(file_name))
}

fn extract_session_authorization_paths(value: &serde_json::Value) -> SessionAuthorizationPaths {
    let mut paths = SessionAuthorizationPaths::default();
    if let Some(path) = value
        .get("templatePath")
        .and_then(serde_json::Value::as_str)
    {
        paths.files.push(PathBuf::from(path));
    }
    if let Some(photo_paths) = value
        .get("photoPaths")
        .and_then(serde_json::Value::as_object)
    {
        paths.files.extend(
            photo_paths
                .values()
                .filter_map(serde_json::Value::as_str)
                .take(MAX_FOLDER_IMAGES)
                .map(PathBuf::from),
        );
    }
    paths.watched_folder = value
        .get("watchedFolderPath")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from);
    paths
}

fn normalized_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
}

fn is_image_path(path: &Path) -> bool {
    normalized_extension(path).is_some_and(|extension| IMAGE_EXTS.contains(&extension.as_str()))
}

fn is_data_path(path: &Path) -> bool {
    normalized_extension(path).is_some_and(|extension| DATA_EXTS.contains(&extension.as_str()))
}

#[cfg(any(windows, test))]
fn reparse_tag_is_traversal(tag: u32) -> bool {
    const IO_REPARSE_TAG_NAME_SURROGATE: u32 = 0x2000_0000;
    tag & IO_REPARSE_TAG_NAME_SURROGATE != 0
}

fn metadata_is_traversal_link(path: &Path, metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
            return false;
        }
        windows_reparse_tag(path).is_none_or(reparse_tag_is_traversal)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

#[cfg(windows)]
fn windows_reparse_tag(path: &Path) -> Option<u32> {
    let file = open_windows_nofollow(path).ok()?;
    windows_reparse_tag_from_handle(&file)
}

#[cfg(windows)]
fn open_windows_nofollow(path: &Path) -> std::io::Result<File> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

#[cfg(windows)]
fn windows_reparse_tag_from_handle(file: &File) -> Option<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_TAG_INFO,
    };

    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            std::ptr::from_mut(&mut info).cast(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    (succeeded != 0).then_some(info.ReparseTag)
}

fn collect_images_bounded(
    root: AuthorizedFolder,
    max_images: usize,
    max_directories: usize,
) -> Vec<String> {
    let root_path = root.resolved_path.clone();
    let mut images = Vec::new();
    let mut pending = VecDeque::from([root]);
    let mut visited = HashSet::from([root_path.clone()]);
    let mut visited_directories = 0usize;

    while let Some(directory) = pending.pop_front() {
        if visited_directories >= max_directories || images.len() >= max_images {
            break;
        }
        if !folder_grant_is_current(&directory.resolved_path, &directory.identity) {
            continue;
        }
        visited_directories += 1;
        let Ok(entries) = std::fs::read_dir(&directory.resolved_path) else {
            continue;
        };
        for entry in entries.flatten() {
            if images.len() >= max_images {
                break;
            }
            let path = entry.path();
            if let Ok(folder) = open_secure_folder(&path) {
                if !path_is_within(&folder.resolved_path, &root_path)
                    || !folder_grant_is_current(&directory.resolved_path, &directory.identity)
                {
                    continue;
                }
                if visited.insert(folder.resolved_path.clone())
                    && visited_directories.saturating_add(pending.len()) < max_directories
                {
                    pending.push_back(folder);
                }
            } else if is_image_path(&path) {
                let Ok(file) = open_secure_file(&path) else {
                    continue;
                };
                if path_is_within(&file.resolved_path, &root_path)
                    && folder_grant_is_current(&directory.resolved_path, &directory.identity)
                {
                    if let Some(path) = path_to_string(file.resolved_path) {
                        images.push(path);
                    }
                }
            }
        }
    }
    images.sort();
    images
}

fn supported_image_format(format: image::ImageFormat) -> bool {
    matches!(
        format,
        image::ImageFormat::Jpeg
            | image::ImageFormat::Png
            | image::ImageFormat::Bmp
            | image::ImageFormat::WebP
            | image::ImageFormat::Gif
    )
}

fn mime_for_image_format(format: image::ImageFormat) -> &'static str {
    match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Gif => "image/gif",
        image::ImageFormat::Bmp => "image/bmp",
        image::ImageFormat::WebP => "image/webp",
        _ => "image/jpeg",
    }
}

fn name_for_image_format(format: image::ImageFormat) -> &'static str {
    match format {
        image::ImageFormat::Jpeg => "jpeg",
        image::ImageFormat::Png => "png",
        image::ImageFormat::Bmp => "bmp",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Gif => "gif",
        _ => "unknown",
    }
}

fn image_dimensions(data: &[u8], format: image::ImageFormat) -> Result<(u32, u32), String> {
    use image::ImageReader;
    use std::io::Cursor;
    ImageReader::with_format(Cursor::new(data), format)
        .into_dimensions()
        .map_err(|_| "El archivo de imagen está dañado o incompleto".to_string())
}

fn checked_pixel_count(width: u32, height: u32) -> Result<u64, String> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "Dimensiones de imagen inválidas".to_string())?;
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIM
        || height > MAX_IMAGE_DIM
        || pixels > MAX_IMAGE_PIXELS
    {
        return Err(format!(
            "Imagen muy grande o inválida ({}x{}, máximo {} megapíxeles)",
            width,
            height,
            MAX_IMAGE_PIXELS / 1_000_000
        ));
    }
    Ok(pixels)
}

fn source_fingerprint(file: &File, metadata: &Metadata) -> Result<SourceFingerprint, String> {
    let modified = metadata
        .modified()
        .map_err(|_| "No se pudo leer la fecha de modificación de la imagen".to_string())?;
    Ok(SourceFingerprint {
        source_bytes: metadata.len(),
        modified,
        file_identity: file_identity(file)?,
    })
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<Option<FileIdentity>, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    if succeeded == 0 {
        return Err("No se pudo leer la identidad del archivo".to_string());
    }
    Ok(Some(FileIdentity {
        volume: u64::from(info.dwVolumeSerialNumber),
        index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    }))
}

#[cfg(not(windows))]
fn file_identity(_file: &File) -> Result<Option<FileIdentity>, String> {
    Ok(None)
}

fn source_version(fingerprint: &SourceFingerprint) -> String {
    let modified = fingerprint.modified;
    let (sign, duration) = match modified.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => ("", duration),
        Err(error) => ("-", error.duration()),
    };
    let identity = fingerprint
        .file_identity
        .as_ref()
        .map(|identity| format!(":{:016x}:{:016x}", identity.volume, identity.index))
        .unwrap_or_default();
    format!(
        "{}:{sign}{}.{:09}{identity}",
        fingerprint.source_bytes,
        duration.as_secs(),
        duration.subsec_nanos()
    )
}

fn inspect_image_file(opened: AuthorizedFile) -> ImageInfo {
    if !is_image_path(&opened.resolved_path) {
        return image_info_error("Tipo de archivo no permitido");
    }

    // Dimensions and metadata come from one handle; image pixels are never decoded here.
    let AuthorizedFile {
        file,
        metadata,
        fingerprint,
        ..
    } = opened;
    if metadata.len() > MAX_FILE_BYTES {
        return image_info_error(format!(
            "Archivo muy grande (máximo {} MB)",
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }
    let fingerprint = match fingerprint {
        Some(fingerprint) => fingerprint,
        None => return image_info_error("No se pudieron leer los metadatos de la imagen"),
    };
    let version = source_version(&fingerprint);
    let reader = match image::ImageReader::new(BufReader::new(file)).with_guessed_format() {
        Ok(reader) => reader,
        Err(_) => return image_info_error("No se pudo inspeccionar el archivo de imagen"),
    };
    let Some(format) = reader.format() else {
        return image_info_error("El contenido del archivo no es una imagen válida");
    };
    if !supported_image_format(format) {
        return image_info_error("Formato de imagen no permitido");
    }
    let (width, height) = match reader.into_dimensions() {
        Ok(dimensions) => dimensions,
        Err(_) => return image_info_error("El archivo de imagen está dañado o incompleto"),
    };
    if let Err(error) = checked_pixel_count(width, height) {
        return image_info_error(error);
    }

    ImageInfo {
        ok: true,
        width: Some(width),
        height: Some(height),
        format: Some(name_for_image_format(format).to_string()),
        source_bytes: Some(metadata.len()),
        source_version: Some(version),
        error: None,
    }
}

fn inspect_authorized_image_paths(
    file_paths: &[String],
    authority: &FilesystemAuthority,
) -> Vec<ImageInfo> {
    let accepted = file_paths.len().min(MAX_BATCH_FILES);
    let mut aggregate_bytes = 0u64;
    let mut ceiling_reached = false;
    let mut results = Vec::with_capacity(file_paths.len());
    for path in &file_paths[..accepted] {
        if ceiling_reached {
            results.push(image_info_error(
                "La inspección supera el límite total de 20 GB",
            ));
            continue;
        }
        let opened = match authority.open_authorized_file(Path::new(path)) {
            Ok(opened) => opened,
            Err(error) => {
                results.push(image_info_error(error));
                continue;
            }
        };
        if reserve_inspection_source_bytes(&mut aggregate_bytes, opened.metadata.len()).is_err() {
            ceiling_reached = true;
            results.push(image_info_error(
                "La inspección supera el límite total de 20 GB",
            ));
            continue;
        }
        results.push(inspect_image_file(opened));
    }
    results.extend((accepted..file_paths.len()).map(|_| {
        image_info_error(format!(
            "El lote admite como máximo {MAX_BATCH_FILES} archivos"
        ))
    }));
    results
}

fn with_read_authority_snapshot<T>(
    authority: &Mutex<FilesystemAuthority>,
    inspect: impl FnOnce(&FilesystemAuthority) -> T,
) -> Result<T, String> {
    let snapshot = authority
        .lock()
        .map_err(|_| "No se pudo verificar la autorización del archivo".to_string())?
        .read_snapshot();
    Ok(inspect(&snapshot))
}

fn reserve_inspection_source_bytes(total: &mut u64, amount: u64) -> Result<(), ()> {
    let next = total.checked_add(amount).ok_or(())?;
    if next > MAX_INSPECTION_SOURCE_BYTES {
        return Err(());
    }
    *total = next;
    Ok(())
}

fn encode_image_dataurl(
    data: &[u8],
    max_dim: u32,
    batch_budget: Option<&BatchBudget>,
    decode_budget: &DecodeBudget,
) -> Result<(String, u64), String> {
    let format = image::guess_format(data)
        .map_err(|_| "El contenido del archivo no es una imagen válida".to_string())?;
    if !supported_image_format(format) {
        return Err("Formato de imagen no permitido".to_string());
    }
    let (width, height) = image_dimensions(data, format)?;
    let pixels = checked_pixel_count(width, height)?;
    if let Some(budget) = batch_budget {
        budget.reserve_pixels(pixels)?;
    }
    let decoded_bytes = pixels
        .checked_mul(DECODED_BYTES_PER_PIXEL)
        .ok_or_else(|| "Dimensiones de imagen inválidas".to_string())?;
    let _decode_permit = decode_budget.acquire(decoded_bytes)?;

    // A complete decode rejects truncated/corrupt files before any bytes reach the renderer.
    let image = image::load_from_memory_with_format(data, format)
        .map_err(|_| "El archivo de imagen está dañado o incompleto".to_string())?;
    if width <= max_dim && height <= max_dim {
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        return Ok((
            format!("data:{};base64,{}", mime_for_image_format(format), encoded),
            pixels,
        ));
    }

    let resized = image.resize(max_dim, max_dim, image::imageops::FilterType::CatmullRom);
    let output_format = if resized.color().has_alpha() {
        image::ImageFormat::Png
    } else {
        image::ImageFormat::Jpeg
    };
    let mut output = Vec::new();
    resized
        .write_to(&mut std::io::Cursor::new(&mut output), output_format)
        .map_err(|_| "No se pudo procesar la imagen".to_string())?;
    if output.is_empty() {
        return Err("No se pudo procesar la imagen".to_string());
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(output);
    Ok((
        format!(
            "data:{};base64,{}",
            mime_for_image_format(output_format),
            encoded
        ),
        pixels,
    ))
}

fn encode_data_file(data: &[u8], extension: &str) -> Result<String, String> {
    let (mime, encoded_data) = match extension {
        "csv" => {
            if data.is_empty() || data.contains(&0) {
                return Err("El archivo CSV está vacío o contiene datos binarios".to_string());
            }
            let utf8 = match std::str::from_utf8(data) {
                Ok(_) => std::borrow::Cow::Borrowed(data),
                Err(_) => {
                    let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(data);
                    std::borrow::Cow::Owned(decoded.into_owned().into_bytes())
                }
            };
            ("text/csv", utf8)
        }
        "xlsx" if data.starts_with(b"PK\x03\x04") => (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            std::borrow::Cow::Borrowed(data),
        ),
        "xls" if data.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) => {
            ("application/vnd.ms-excel", std::borrow::Cow::Borrowed(data))
        }
        "xlsx" | "xls" => return Err("El archivo de hoja de cálculo no es válido".to_string()),
        _ => return Err("Tipo de archivo no permitido".to_string()),
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(encoded_data.as_ref());
    Ok(format!("data:{};base64,{}", mime, encoded))
}

fn read_single_file(
    opened: AuthorizedFile,
    cache: &Mutex<BoundedCache>,
    max_dim: u32,
    allow_data: bool,
    batch_budget: Option<&BatchBudget>,
    decode_budget: &DecodeBudget,
) -> FileResult {
    let AuthorizedFile {
        mut file,
        resolved_path,
        metadata,
        fingerprint,
    } = opened;
    let extension = normalized_extension(&resolved_path).unwrap_or_default();
    let is_image = is_image_path(&resolved_path);
    let is_data = allow_data && is_data_path(&resolved_path);
    if !is_image && !is_data {
        return file_error("Tipo de archivo no permitido");
    }

    let file_limit = if is_image {
        MAX_FILE_BYTES
    } else {
        MAX_DATA_FILE_BYTES
    };
    if metadata.len() > file_limit {
        return file_error(format!(
            "Archivo muy grande (máximo {} MB)",
            file_limit / (1024 * 1024)
        ));
    }
    let cache_key = CacheKey {
        path: resolved_path.to_string_lossy().into_owned(),
        max_dim,
    };

    if let Ok(mut cache) = cache.lock() {
        if let Some((data_url, source_bytes, pixels)) = cache.get(&cache_key, fingerprint.as_ref())
        {
            if let Some(budget) = batch_budget {
                if let Err(error) = budget.reserve_bytes(source_bytes) {
                    return file_error(error);
                }
                if let Err(error) = budget.reserve_pixels(pixels) {
                    return file_error(error);
                }
            }
            return FileResult {
                ok: true,
                data_url: Some(data_url),
                error: None,
            };
        }
    }

    if let Some(budget) = batch_budget {
        if let Err(error) = budget.reserve_bytes(metadata.len()) {
            return file_error(error);
        }
    }
    let mut data = Vec::with_capacity(metadata.len().min(file_limit) as usize);
    if let Err(error) = (&mut file).take(file_limit + 1).read_to_end(&mut data) {
        return file_error(error.to_string());
    }
    if data.len() as u64 > file_limit {
        return file_error(format!(
            "Archivo muy grande (máximo {} MB)",
            file_limit / (1024 * 1024)
        ));
    }
    if let Some(extra) = (data.len() as u64).checked_sub(metadata.len()) {
        if let Some(budget) = batch_budget {
            if let Err(error) = budget.reserve_bytes(extra) {
                return file_error(error);
            }
        }
    }

    let (data_url, pixels) = if is_image {
        match encode_image_dataurl(&data, max_dim, batch_budget, decode_budget) {
            Ok(result) => result,
            Err(error) => return file_error(error),
        }
    } else {
        match encode_data_file(&data, &extension) {
            Ok(data_url) => (data_url, 0),
            Err(error) => return file_error(error),
        }
    };
    let stable_fingerprint = file
        .metadata()
        .ok()
        .and_then(|metadata| source_fingerprint(&file, &metadata).ok())
        .filter(|after| fingerprint.as_ref() == Some(after))
        .filter(|after| after.source_bytes == data.len() as u64);
    if let (Some(fingerprint), Ok(mut cache)) = (stable_fingerprint, cache.lock()) {
        cache.insert(
            cache_key,
            data_url.clone(),
            fingerprint,
            data.len() as u64,
            pixels,
        );
    }
    FileResult {
        ok: true,
        data_url: Some(data_url),
        error: None,
    }
}

// -- HTTP commands -------------------------------------------------------------

fn validate_reniec_input(dni: &str, token: &str) -> Result<(String, String), String> {
    let dni = dni.trim();
    if dni.len() != 8 || !dni.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("El DNI debe contener exactamente 8 dígitos".to_string());
    }
    let token = validate_reniec_token(token)?;
    Ok((dni.to_string(), token))
}

fn validate_reniec_token(token: &str) -> Result<String, String> {
    let token = token.trim();
    if token.is_empty() || token.len() > 512 || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("El token RENIEC no es válido".to_string());
    }
    Ok(token.to_string())
}

#[tauri::command]
async fn reniec_query(
    dni: String,
    token: String,
    state: tauri::State<'_, AppState>,
) -> Result<ReniecResult, String> {
    let client = state.http_client.clone();
    Ok(reniec_query_inner(dni, token, client).await)
}

async fn reniec_query_inner(dni: String, token: String, client: reqwest::Client) -> ReniecResult {
    let (dni, token) = match validate_reniec_input(&dni, &token) {
        Ok(values) => values,
        Err(error) => {
            return ReniecResult {
                ok: false,
                body: None,
                error: Some(error),
            }
        }
    };
    let response = match client
        .get(format!("https://dniruc.apisperu.com/api/v1/dni/{dni}"))
        .query(&[("token", token)])
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return ReniecResult {
                ok: false,
                body: None,
                error: Some(sanitized_reqwest_error(error)),
            }
        }
    };

    let status = response.status();
    if !status.is_success() {
        let code = status.as_u16();
        let message = match code {
            401 | 403 => "Token RENIEC inválido o sin permisos".to_string(),
            404 => "DNI no encontrado".to_string(),
            429 => "Límite de consultas superado; espera unos segundos".to_string(),
            500..=599 => format!("Error del servidor RENIEC ({code})"),
            _ => format!("Respuesta HTTP inesperada ({code})"),
        };
        return ReniecResult {
            ok: false,
            body: None,
            error: Some(message),
        };
    }

    match read_bounded_response(response, MAX_HTTP_BODY_BYTES).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(body) => ReniecResult {
                ok: true,
                body: Some(body),
                error: None,
            },
            Err(error) => ReniecResult {
                ok: false,
                body: None,
                error: Some(format!("Respuesta JSON inválida: {error}")),
            },
        },
        Err(error) => ReniecResult {
            ok: false,
            body: None,
            error: Some(error.message),
        },
    }
}

async fn check_for_updates_inner(
    client: &reqwest::Client,
    current: &str,
) -> Result<Option<UpdateInfo>, ApiError> {
    let response = client
        .get(UPDATE_RELEASES_URL)
        .header("User-Agent", "FotoCarnet-Tauri")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| api_error("network", sanitized_reqwest_error(error)))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let code = match status {
            403 | 429 => "rate_limited",
            404 => "not_found",
            500..=599 => "server_error",
            _ => "http_error",
        };
        return Err(api_error(code, format!("GitHub respondió HTTP {status}")));
    }
    let body = read_bounded_response(response, MAX_HTTP_BODY_BYTES).await?;
    let releases: Vec<GitHubRelease> = serde_json::from_slice(&body)
        .map_err(|error| api_error("invalid_response", error.to_string()))?;
    select_update(&releases, current)
}

fn select_update(
    releases: &[GitHubRelease],
    current: &str,
) -> Result<Option<UpdateInfo>, ApiError> {
    let current = parse_version(current).ok_or_else(|| {
        api_error(
            "invalid_current_version",
            "La versión instalada no es válida",
        )
    })?;
    let accepts_prereleases = !current.pre.is_empty();
    let mut candidates = releases
        .iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            let version = parse_version(&release.tag_name)?;
            let is_prerelease = release.prerelease || !version.pre.is_empty();
            if version <= current || (!accepts_prereleases && is_prerelease) {
                return None;
            }
            let url = validate_external_url(&release.html_url).ok()?;
            if url.scheme() != "https" || url.host_str() != Some("github.com") {
                return None;
            }
            Some((version, url))
        })
        .collect::<Vec<_>>();
    candidates.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    Ok(candidates.pop().map(|(version, url)| UpdateInfo {
        version: version.to_string(),
        url: url.to_string(),
    }))
}

// Compatibility command: existing frontend expects update info or null.
#[tauri::command]
async fn check_for_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<UpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    let client = state.http_client.clone();
    let update = match check_for_updates_inner(&client, &current).await {
        Ok(update) => update,
        Err(error) => {
            eprintln!("[updates:{}] {}", error.code, error.message);
            None
        }
    };
    Ok(update)
}

// Additive API for callers that need to distinguish no update from network/API failure.
#[tauri::command]
async fn check_for_updates_detailed(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<UpdateCheckResult, String> {
    let current = app.package_info().version.to_string();
    let client = state.http_client.clone();
    let result = match check_for_updates_inner(&client, &current).await {
        Ok(update) => UpdateCheckResult {
            ok: true,
            update,
            error: None,
        },
        Err(error) => UpdateCheckResult {
            ok: false,
            update: None,
            error: Some(error),
        },
    };
    Ok(result)
}

// -- File commands -------------------------------------------------------------

#[tauri::command]
async fn read_file_as_dataurl(
    file_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<FileResult, String> {
    let authority = Arc::clone(&state.filesystem_authority);
    let cache = Arc::clone(&state.file_cache);
    let pool = Arc::clone(&state.decode_pool);
    let decode_budget = Arc::clone(&state.decode_budget);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let opened = match authority
            .lock()
            .map_err(|_| "No se pudo verificar la autorización del archivo".to_string())
            .and_then(|authority| authority.open_authorized_file(Path::new(&file_path)))
        {
            Ok(opened) => opened,
            Err(error) => return file_error(error),
        };
        pool.install(|| read_single_file(opened, &cache, MAX_DIM, true, None, &decode_budget))
    })
    .await
    .unwrap_or_else(|_| file_error("No se pudo procesar el archivo")))
}

#[tauri::command]
async fn read_as_thumbnail(
    file_path: String,
    max_dim: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<FileResult, String> {
    let max_dim = max_dim.unwrap_or(200).clamp(32, 600);
    let authority = Arc::clone(&state.filesystem_authority);
    let cache = Arc::clone(&state.thumb_cache);
    let pool = Arc::clone(&state.decode_pool);
    let decode_budget = Arc::clone(&state.decode_budget);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let opened = match authority
            .lock()
            .map_err(|_| "No se pudo verificar la autorización del archivo".to_string())
            .and_then(|authority| authority.open_authorized_file(Path::new(&file_path)))
        {
            Ok(opened) => opened,
            Err(error) => return file_error(error),
        };
        pool.install(|| read_single_file(opened, &cache, max_dim, false, None, &decode_budget))
    })
    .await
    .unwrap_or_else(|_| file_error("No se pudo procesar la miniatura")))
}

#[tauri::command]
async fn read_files_batch(
    file_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<FileResult>, String> {
    let requested_count = file_paths.len();
    let authority = Arc::clone(&state.filesystem_authority);
    let cache = Arc::clone(&state.file_cache);
    let pool = Arc::clone(&state.decode_pool);
    let decode_budget = Arc::clone(&state.decode_budget);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let accepted = file_paths.len().min(MAX_BATCH_FILES);
        let budget = BatchBudget::new();
        let mut results = pool.install(|| {
            file_paths[..accepted]
                .par_iter()
                .map(|path| {
                    let opened = match authority
                        .lock()
                        .map_err(|_| "No se pudo verificar la autorización del archivo".to_string())
                        .and_then(|authority| authority.open_authorized_file(Path::new(path)))
                    {
                        Ok(opened) => opened,
                        Err(error) => return file_error(error),
                    };
                    read_single_file(opened, &cache, MAX_DIM, true, Some(&budget), &decode_budget)
                })
                .collect::<Vec<_>>()
        });
        results.extend((accepted..file_paths.len()).map(|_| {
            file_error(format!(
                "El lote admite como máximo {MAX_BATCH_FILES} archivos"
            ))
        }));
        results
    })
    .await
    .unwrap_or_else(|_| {
        (0..requested_count)
            .map(|_| file_error("No se pudo procesar el lote"))
            .collect()
    }))
}

#[tauri::command]
async fn inspect_image_files(
    file_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ImageInfo>, String> {
    let requested_count = file_paths.len();
    let authority = Arc::clone(&state.filesystem_authority);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        with_read_authority_snapshot(&authority, |snapshot| {
            inspect_authorized_image_paths(&file_paths, snapshot)
        })
        .unwrap_or_else(|error| {
            (0..file_paths.len())
                .map(|_| image_info_error(error.clone()))
                .collect()
        })
    })
    .await
    .unwrap_or_else(|_| {
        (0..requested_count)
            .map(|_| image_info_error("No se pudo inspeccionar el lote"))
            .collect()
    }))
}

#[tauri::command]
fn clear_backend_caches(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .filesystem_authority
        .lock()
        .map_err(|_| "No se pudieron revocar las rutas autorizadas".to_string())?
        .clear_all();
    let mut watcher = state
        .watcher
        .lock()
        .map_err(|_| "No se pudo detener la vigilancia de carpetas".to_string())?;
    watcher.debouncer = None;
    watcher.watched_path = None;
    drop(watcher);
    state
        .file_cache
        .lock()
        .map_err(|error| error.to_string())?
        .clear();
    state
        .thumb_cache
        .lock()
        .map_err(|error| error.to_string())?
        .clear();
    Ok(())
}

// -- Folder commands -----------------------------------------------------------

#[tauri::command]
fn start_watching_folder(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let watch_folder = state
        .filesystem_authority
        .lock()
        .map_err(|_| "No se pudo verificar la autorización de la carpeta".to_string())?
        .open_authorized_folder(Path::new(&path))?;
    let watch_path = watch_folder.resolved_path.clone();

    {
        let mut slot = state.watcher.lock().map_err(|error| error.to_string())?;
        slot.debouncer = None;
        slot.watched_path = None;
    }

    let app_handle = app.clone();
    let authorized_root = watch_path.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(800),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                use notify::EventKind;
                let mut new_paths = Vec::new();
                for event in events {
                    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                        continue;
                    }
                    for path in &event.paths {
                        if new_paths.len() >= MAX_BATCH_FILES {
                            break;
                        }
                        let is_traversal = std::fs::symlink_metadata(path)
                            .is_ok_and(|metadata| metadata_is_traversal_link(path, &metadata));
                        if is_traversal {
                            continue;
                        }
                        let Ok(canonical) = canonical_existing_file(path) else {
                            continue;
                        };
                        if canonical.starts_with(&authorized_root) && is_image_path(&canonical) {
                            if let Some(path) = path_to_string(canonical) {
                                new_paths.push(path);
                            }
                        }
                    }
                }
                if !new_paths.is_empty() {
                    new_paths.sort();
                    new_paths.dedup();
                    let _ = app_handle.emit("photo-folder-changed", &new_paths);
                }
            }
            Err(errors) => eprintln!("[watcher] errores: {errors:?}"),
        },
    )
    .map_err(|error| error.to_string())?;

    debouncer
        .watcher()
        .watch(&watch_path, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;
    let mut slot = state.watcher.lock().map_err(|error| error.to_string())?;
    slot.debouncer = Some(debouncer);
    slot.watched_path = path_to_string(watch_path);
    Ok(())
}

#[tauri::command]
fn stop_watching_folder(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.watcher.lock().map_err(|error| error.to_string())?;
    slot.debouncer = None;
    slot.watched_path = None;
    Ok(())
}

#[tauri::command]
async fn list_folder_images(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let authority = Arc::clone(&state.filesystem_authority);
    tauri::async_runtime::spawn_blocking(move || {
        let folder = authority
            .lock()
            .map_err(|_| "No se pudo verificar la autorización de la carpeta".to_string())?
            .open_authorized_folder(Path::new(&path))?;
        Ok(collect_images_bounded(
            folder,
            MAX_FOLDER_IMAGES,
            MAX_FOLDER_DIRECTORIES,
        ))
    })
    .await
    .map_err(|_| "No se pudo listar la carpeta".to_string())?
}

#[tauri::command]
fn pick_folder(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let selected = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())?;
    state
        .filesystem_authority
        .lock()
        .ok()?
        .register_picker_folder(&selected)
        .ok()
        .and_then(path_to_string)
}

// -- Dialog and output commands ------------------------------------------------

#[tauri::command]
fn pick_template_file(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let selected = app
        .dialog()
        .file()
        .add_filter("Imagen plantilla", IMAGE_EXTS)
        .blocking_pick_file()
        .and_then(|path| path.into_path().ok())?;
    state
        .filesystem_authority
        .lock()
        .ok()?
        .register_picker_file(&selected)
        .ok()
        .and_then(path_to_string)
}

#[tauri::command]
fn pick_photo_files(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let selected = app
        .dialog()
        .file()
        .add_filter("Fotos", IMAGE_EXTS)
        .blocking_pick_files()
        .unwrap_or_default();
    let Ok(mut authority) = state.filesystem_authority.lock() else {
        return Vec::new();
    };
    selected
        .into_iter()
        .take(MAX_BATCH_FILES)
        .filter_map(|path| path.into_path().ok())
        .filter_map(|path| authority.register_picker_file(&path).ok())
        .filter_map(path_to_string)
        .collect()
}

#[tauri::command]
async fn pick_photos_from_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let authority = Arc::clone(&state.filesystem_authority);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let directory = app
            .dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|path| path.into_path().ok());
        let Some(directory) = directory else {
            return Vec::new();
        };
        let Ok(folder) = authority.lock().map_err(|_| ()).and_then(|mut authority| {
            authority
                .register_picker_folder(&directory)
                .map_err(|_| ())?;
            authority.open_authorized_folder(&directory).map_err(|_| ())
        }) else {
            return Vec::new();
        };
        collect_images_bounded(folder, MAX_BATCH_FILES, MAX_FOLDER_DIRECTORIES)
    })
    .await
    .unwrap_or_default())
}

#[tauri::command]
fn pick_data_file(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let selected = app
        .dialog()
        .file()
        .add_filter("Datos", DATA_EXTS)
        .blocking_pick_file()
        .and_then(|path| path.into_path().ok())?;
    state
        .filesystem_authority
        .lock()
        .ok()?
        .register_picker_file(&selected)
        .ok()
        .and_then(path_to_string)
}

fn safe_extension(extension: &str) -> Option<String> {
    let normalized = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 10
        || !normalized.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(normalized)
}

#[tauri::command]
fn pick_save_path(
    default_name: String,
    filter_name: String,
    extension: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let extension = safe_extension(&extension)?;
    let path = app
        .dialog()
        .file()
        .add_filter(&filter_name, &[extension.as_str()])
        .set_file_name(&default_name)
        .blocking_save_file()
        .and_then(|path| path.into_path().ok())
        .and_then(path_to_string)?;
    let suffix = format!(".{extension}");
    let path = if path.to_ascii_lowercase().ends_with(&suffix) {
        PathBuf::from(path)
    } else {
        PathBuf::from(format!("{path}{suffix}"))
    };
    state
        .filesystem_authority
        .lock()
        .ok()?
        .register_save_path(&path)
        .ok()
        .and_then(path_to_string)
}

fn cleanup_old_print_previews(temp_directory: &Path) {
    let Ok(entries) = std::fs::read_dir(temp_directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(PRINT_FILE_PREFIX) || !name.ends_with(".html") {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata_is_traversal_link(&path, &metadata) {
            continue;
        }
        let is_stale = metadata
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= PRINT_FILE_MAX_AGE);
        if is_stale {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tauri::command]
fn open_print_preview(html: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if html.len() > MAX_PRINT_HTML_BYTES {
        return Err("La vista de impresión supera el tamaño permitido".to_string());
    }

    let temp_directory = std::env::temp_dir();
    cleanup_old_print_previews(&temp_directory);
    let mut file = tempfile::Builder::new()
        .prefix(PRINT_FILE_PREFIX)
        .suffix(".html")
        .tempfile_in(&temp_directory)
        .map_err(|error| format!("No se pudo crear el archivo temporal: {error}"))?;
    file.write_all(html.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|error| format!("No se pudo escribir el archivo temporal: {error}"))?;
    let temp_path = file.into_temp_path();
    let path = temp_path
        .keep()
        .map_err(|error| format!("No se pudo conservar el archivo temporal: {error}"))?;
    let file_url = reqwest::Url::from_file_path(&path)
        .map_err(|_| "No se pudo crear el URL de impresión".to_string())?;
    if let Err(error) = app.opener().open_url(file_url.as_str(), None::<&str>) {
        let _ = std::fs::remove_file(path);
        return Err(format!("No se pudo abrir el navegador: {error}"));
    }
    Ok(())
}

fn validate_external_url(value: &str) -> Result<reqwest::Url, String> {
    if value.len() > 2_048 || value.chars().any(char::is_control) {
        return Err("URL externo no válido".to_string());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "URL externo no válido".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Solo se permiten URLs HTTP(S) sin credenciales".to_string());
    }
    Ok(url)
}

#[tauri::command]
fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = validate_external_url(url.trim())?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| format!("No se pudo abrir el URL: {error}"))
}

#[tauri::command]
fn save_base64_to_file(
    path: String,
    base64_data: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let approved_path = state
        .filesystem_authority
        .lock()
        .map_err(|_| "No se pudo verificar la autorización de guardado".to_string())?
        .consume_save_path(Path::new(&path))?;
    if base64_data.len() > MAX_SAVE_BYTES.saturating_mul(4) / 3 + 1_024 {
        return Err("Los datos superan el tamaño permitido".to_string());
    }
    let encoded = if base64_data.starts_with("data:") {
        let (header, body) = base64_data
            .split_once(',')
            .ok_or_else(|| "Data URI no válido".to_string())?;
        if !header.ends_with(";base64") {
            return Err("Data URI no válido".to_string());
        }
        body
    } else {
        base64_data.as_str()
    };
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| error.to_string())?;
    if data.len() > MAX_SAVE_BYTES {
        return Err("Los datos superan el tamaño permitido".to_string());
    }
    if std::fs::symlink_metadata(&approved_path).is_ok_and(|metadata| {
        metadata_is_traversal_link(&approved_path, &metadata) || metadata.is_dir()
    }) {
        return Err("La ruta de guardado dejó de ser segura".to_string());
    }
    std::fs::write(approved_path, data).map_err(|error| error.to_string())
}

// -- App entry -----------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    cleanup_old_print_previews(&std::env::temp_dir());
    let http_client = build_http_client().expect("no se pudo crear el cliente HTTP");
    let decode_pool = rayon::ThreadPoolBuilder::new()
        .num_threads(MAX_DECODE_CONCURRENCY)
        .thread_name(|index| format!("image-decode-{index}"))
        .build()
        .expect("no se pudo crear el pool de imágenes");

    tauri::Builder::default()
        .manage(AppState {
            file_cache: Arc::new(Mutex::new(BoundedCache::new(256, FILE_CACHE_BYTES))),
            thumb_cache: Arc::new(Mutex::new(BoundedCache::new(512, THUMB_CACHE_BYTES))),
            watcher: Mutex::new(WatcherSlot::default()),
            filesystem_authority: Arc::new(Mutex::new(FilesystemAuthority::default())),
            http_client,
            decode_pool: Arc::new(decode_pool),
            decode_budget: Arc::new(DecodeBudget::new()),
            secure_storage: Arc::new(tokio::sync::Mutex::new(())),
        })
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "No se encontró la ventana principal".to_string())?;
            let app_handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) =
                    event
                {
                    if let Ok(mut authority) =
                        app_handle.state::<AppState>().filesystem_authority.lock()
                    {
                        authority.register_native_drop(paths);
                    }
                }
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            reniec_query,
            get_reniec_token,
            set_reniec_token,
            clear_reniec_token,
            save_secure_session,
            load_secure_session,
            clear_secure_session,
            read_file_as_dataurl,
            read_as_thumbnail,
            read_files_batch,
            inspect_image_files,
            clear_backend_caches,
            check_for_updates,
            check_for_updates_detailed,
            pick_template_file,
            pick_photo_files,
            pick_photos_from_folder,
            pick_data_file,
            pick_save_path,
            save_base64_to_file,
            open_print_preview,
            open_external_url,
            start_watching_folder,
            stop_watching_folder,
            list_folder_images,
            pick_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar FotoCarnet");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_png(path: &Path, width: u32, height: u32) {
        image::DynamicImage::new_rgb8(width, height)
            .save_with_format(path, image::ImageFormat::Png)
            .unwrap();
    }

    #[test]
    fn semantic_versions_include_prerelease_ordering() {
        assert!(parse_version("v1.2.0").unwrap() > parse_version("1.2.0-rc.1").unwrap());
        assert!(parse_version("1.2.0-beta.2").unwrap() > parse_version("1.2.0-beta.1").unwrap());
        assert!(parse_version("2").is_none());
        assert!(parse_version("1.2").is_none());
        assert!(parse_version("1.bad.0").is_none());
    }

    #[test]
    fn update_selection_respects_stable_and_prerelease_channels() {
        let releases = [
            GitHubRelease {
                tag_name: "v2.0.0-beta.1".to_string(),
                html_url: "https://github.com/example/beta".to_string(),
                draft: false,
                prerelease: true,
            },
            GitHubRelease {
                tag_name: "v1.5.0".to_string(),
                html_url: "https://github.com/example/stable".to_string(),
                draft: false,
                prerelease: false,
            },
            GitHubRelease {
                tag_name: "v9.0.0".to_string(),
                html_url: "https://github.com/example/draft".to_string(),
                draft: true,
                prerelease: false,
            },
        ];

        let stable = select_update(&releases, "1.0.0").unwrap().unwrap();
        assert_eq!(stable.version, "1.5.0");
        let prerelease = select_update(&releases, "1.0.0-beta.1").unwrap().unwrap();
        assert_eq!(prerelease.version, "2.0.0-beta.1");
        assert!(select_update(&releases, "2.0.0").unwrap().is_none());
    }

    #[test]
    fn reniec_input_rejects_invalid_dni_and_token() {
        assert!(validate_reniec_input("12345678", "token-123").is_ok());
        assert!(validate_reniec_input("1234", "token").is_err());
        assert!(validate_reniec_input("1234567x", "token").is_err());
        assert!(validate_reniec_input("12345678", "").is_err());
        assert!(validate_reniec_input("12345678", "bad token").is_err());
    }

    #[test]
    fn secure_session_encryption_round_trip() {
        let key = [7u8; 32];
        let payload = br#"{"v":2,"records":[{"dni":"12345678"}]}"#;
        let encrypted = encrypt_session_payload(payload, &key).unwrap();

        assert_ne!(encrypted, payload);
        assert_eq!(decrypt_session_payload(&encrypted, &key).unwrap(), payload);
    }

    #[test]
    fn secure_session_rejects_tampering() {
        let key = [11u8; 32];
        let mut encrypted = encrypt_session_payload(br#"{"v":2}"#, &key).unwrap();
        let last = encrypted.len() - 1;
        encrypted[last] ^= 0x01;

        assert_eq!(
            decrypt_session_payload(&encrypted, &key),
            Err(ERR_SESSION_LOAD.to_string())
        );
    }

    #[test]
    fn secure_session_payload_limit_is_strict() {
        let key = [3u8; 32];
        let at_limit = vec![b'x'; MAX_SECURE_SESSION_BYTES];
        let over_limit = vec![b'x'; MAX_SECURE_SESSION_BYTES + 1];

        assert!(encrypt_session_payload(&at_limit, &key).is_ok());
        assert_eq!(
            encrypt_session_payload(&over_limit, &key),
            Err(ERR_SESSION_TOO_LARGE.to_string())
        );
    }

    #[test]
    fn external_url_validation_blocks_dangerous_schemes_and_credentials() {
        assert!(validate_external_url("https://github.com/example").is_ok());
        assert!(validate_external_url("http://localhost:8080/path").is_ok());
        assert!(validate_external_url("file:///C:/secret.txt").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("https://user:pass@example.com").is_err());
    }

    #[test]
    fn atomic_budget_never_exceeds_limit() {
        let counter = AtomicU64::new(0);
        assert_eq!(reserve_atomic(&counter, 6, 10), Ok(()));
        assert_eq!(reserve_atomic(&counter, 5, 10), Err(()));
        assert_eq!(counter.load(Ordering::Relaxed), 6);
        assert_eq!(reserve_atomic(&counter, 4, 10), Ok(()));
    }

    #[test]
    fn image_memory_limits_are_globally_bounded() {
        assert_eq!(MAX_IMAGE_PIXELS, 32_000_000);
        assert_eq!(MAX_BATCH_PIXELS, 96_000_000);
        assert_eq!(MAX_DECODE_CONCURRENCY, 2);
        assert_eq!(FILE_CACHE_BYTES + THUMB_CACHE_BYTES, 96 * 1024 * 1024);

        let batch = BatchBudget::new();
        assert!(batch.reserve_pixels(32_000_000).is_ok());
        assert!(batch.reserve_pixels(64_000_000).is_ok());
        assert!(batch.reserve_pixels(1).is_err());

        let decode = DecodeBudget::new();
        let first = decode.try_acquire(MAX_DECODED_BYTES - 1).unwrap();
        assert!(decode.try_acquire(2).is_none());
        drop(first);
        assert!(decode.try_acquire(MAX_DECODED_BYTES).is_some());

        let concurrency = DecodeBudget::new();
        let first = concurrency.try_acquire(1).unwrap();
        let second = concurrency.try_acquire(1).unwrap();
        assert!(concurrency.try_acquire(1).is_none());
        drop((first, second));
    }

    #[test]
    fn bounded_cache_evicts_and_keys_thumbnails_by_size() {
        let mut cache = BoundedCache::new(2, 1_000);
        let fingerprint = SourceFingerprint {
            source_bytes: 3,
            modified: SystemTime::UNIX_EPOCH,
            file_identity: None,
        };
        let key_100 = CacheKey {
            path: "photo.jpg".to_string(),
            max_dim: 100,
        };
        let key_200 = CacheKey {
            path: "photo.jpg".to_string(),
            max_dim: 200,
        };
        cache.insert(
            key_100.clone(),
            "one".to_string(),
            fingerprint.clone(),
            3,
            1,
        );
        cache.insert(
            key_200.clone(),
            "two".to_string(),
            fingerprint.clone(),
            3,
            1,
        );
        assert_eq!(cache.get(&key_100, Some(&fingerprint)).unwrap().0, "one");
        cache.insert(
            CacheKey {
                path: "other.jpg".to_string(),
                max_dim: 100,
            },
            "three".to_string(),
            fingerprint.clone(),
            5,
            1,
        );
        assert!(cache.get(&key_200, Some(&fingerprint)).is_none());
        assert!(cache.get(&key_100, Some(&fingerprint)).is_some());
    }

    #[test]
    fn cache_freshness_includes_source_byte_length_and_requires_metadata() {
        let mut cache = BoundedCache::new(2, 1_000);
        let key = CacheKey {
            path: "photo.jpg".to_string(),
            max_dim: 200,
        };
        let original = SourceFingerprint {
            source_bytes: 3,
            modified: SystemTime::UNIX_EPOCH,
            file_identity: None,
        };
        let resized = SourceFingerprint {
            source_bytes: 4,
            ..original.clone()
        };
        cache.insert(key.clone(), "cached".to_string(), original.clone(), 3, 1);

        assert!(cache.get(&key, None).is_none());
        assert!(cache.get(&key, Some(&resized)).is_none());
    }

    #[test]
    fn malformed_image_content_is_rejected() {
        assert!(
            encode_image_dataurl(b"not actually a jpeg", 200, None, &DecodeBudget::new()).is_err()
        );
    }

    #[test]
    fn per_image_dimension_and_pixel_limits_are_enforced() {
        assert_eq!(checked_pixel_count(8_000, 4_000), Ok(32_000_000));
        assert!(checked_pixel_count(8_001, 4_000).is_err());
        assert!(checked_pixel_count(MAX_IMAGE_DIM + 1, 1).is_err());
        assert!(checked_pixel_count(0, 100).is_err());
    }

    #[test]
    fn valid_image_is_decoded_and_uses_detected_mime() {
        let image = image::DynamicImage::new_rgb8(2, 3);
        let mut bytes = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        let (data_url, pixels) =
            encode_image_dataurl(&bytes, 200, None, &DecodeBudget::new()).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));
        assert_eq!(pixels, 6);
    }

    #[test]
    fn image_inspection_results_stay_aligned_with_successes_and_errors() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.png");
        let invalid = directory.path().join("invalid.jpg");
        let last = directory.path().join("last.png");
        write_test_png(&first, 2, 3);
        std::fs::write(&invalid, b"not an image").unwrap();
        write_test_png(&last, 5, 7);

        let mut authority = FilesystemAuthority::default();
        authority.register_picker_file(&first).unwrap();
        authority.register_picker_file(&invalid).unwrap();
        authority.register_picker_file(&last).unwrap();
        let paths = [first, invalid, last]
            .map(|path| path.to_string_lossy().into_owned())
            .to_vec();
        let results = inspect_authorized_image_paths(&paths, &authority);

        assert_eq!(results.len(), paths.len());
        assert_eq!((results[0].width, results[0].height), (Some(2), Some(3)));
        assert!(!results[1].ok);
        assert!(results[1].error.is_some());
        assert_eq!((results[2].width, results[2].height), (Some(5), Some(7)));
    }

    #[test]
    fn image_inspection_releases_authority_mutex_before_file_io() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("photo.png");
        write_test_png(&path, 2, 3);
        let paths = vec![path.to_string_lossy().into_owned()];
        let authority = Mutex::new(FilesystemAuthority::default());
        authority
            .lock()
            .unwrap()
            .register_picker_file(&path)
            .unwrap();

        let results = with_read_authority_snapshot(&authority, |snapshot| {
            authority.try_lock().unwrap().clear_all();
            inspect_authorized_image_paths(&paths, snapshot)
        })
        .unwrap();

        assert!(results[0].ok);
        assert!(authority
            .lock()
            .unwrap()
            .open_authorized_file(&path)
            .is_err());
    }

    #[test]
    fn inspection_source_byte_ceiling_is_strict() {
        let mut total = 0;
        assert_eq!(
            reserve_inspection_source_bytes(&mut total, MAX_INSPECTION_SOURCE_BYTES),
            Ok(())
        );
        assert_eq!(reserve_inspection_source_bytes(&mut total, 1), Err(()));
        assert_eq!(total, MAX_INSPECTION_SOURCE_BYTES);
    }

    #[test]
    fn image_inspection_denies_an_unauthorized_sibling() {
        let directory = tempfile::tempdir().unwrap();
        let approved = directory.path().join("approved");
        let sibling = directory.path().join("sibling");
        std::fs::create_dir(&approved).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        let inside = approved.join("inside.png");
        let outside = sibling.join("outside.png");
        write_test_png(&inside, 2, 2);
        write_test_png(&outside, 2, 2);

        let mut authority = FilesystemAuthority::default();
        authority.register_picker_folder(&approved).unwrap();
        let paths = [inside, outside]
            .map(|path| path.to_string_lossy().into_owned())
            .to_vec();
        let results = inspect_authorized_image_paths(&paths, &authority);

        assert!(results[0].ok);
        assert_eq!(
            results[1].error.as_deref(),
            Some("La ruta no fue autorizada por el usuario")
        );
    }

    #[test]
    fn image_inspection_reports_dimensions_and_source_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metadata.png");
        write_test_png(&path, 7, 11);
        let metadata = std::fs::metadata(&path).unwrap();

        let opened = open_secure_file(&path).unwrap();
        let expected_version = source_version(opened.fingerprint.as_ref().unwrap());
        let result = inspect_image_file(opened);

        assert!(result.ok);
        assert_eq!((result.width, result.height), (Some(7), Some(11)));
        assert_eq!(result.format.as_deref(), Some("png"));
        assert_eq!(result.source_bytes, Some(metadata.len()));
        assert_eq!(
            result.source_version.as_deref(),
            Some(expected_version.as_str())
        );
    }

    #[test]
    fn authorized_read_uses_the_validated_open_handle_after_path_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("photo.jpg");
        let moved = directory.path().join("original.jpg");
        std::fs::write(&path, b"approved bytes").unwrap();
        let mut authority = FilesystemAuthority::default();
        authority.register_picker_file(&path).unwrap();

        let mut opened = authority.open_authorized_file(&path).unwrap();
        std::fs::rename(&path, &moved).unwrap();
        std::fs::write(&path, b"replacement bytes").unwrap();
        let mut bytes = Vec::new();
        opened.file.read_to_end(&mut bytes).unwrap();

        assert_eq!(bytes, b"approved bytes");
    }

    #[cfg(windows)]
    #[test]
    fn windows_exact_file_grant_does_not_transfer_to_a_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("photo.jpg");
        let moved = directory.path().join("original.jpg");
        std::fs::write(&path, b"approved").unwrap();
        let mut authority = FilesystemAuthority::default();
        authority.register_picker_file(&path).unwrap();

        std::fs::rename(&path, moved).unwrap();
        std::fs::write(&path, b"replacement").unwrap();

        assert!(authority.open_authorized_file(&path).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_folder_grant_does_not_transfer_to_a_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let approved = directory.path().join("approved");
        let moved = directory.path().join("original");
        std::fs::create_dir(&approved).unwrap();
        let mut authority = FilesystemAuthority::default();
        authority.register_picker_folder(&approved).unwrap();

        std::fs::rename(&approved, moved).unwrap();
        std::fs::create_dir(&approved).unwrap();
        let replacement = approved.join("replacement.jpg");
        std::fs::write(&replacement, b"replacement").unwrap();

        assert!(authority.open_authorized_file(&replacement).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_source_version_contains_handle_file_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("identity.png");
        write_test_png(&path, 1, 1);
        let opened = open_secure_file(&path).unwrap();
        let fingerprint = opened.fingerprint.unwrap();
        let identity = fingerprint.file_identity.as_ref().unwrap();
        let version = source_version(&fingerprint);

        assert!(version.ends_with(&format!(
            ":{:016x}:{:016x}",
            identity.volume, identity.index
        )));
    }

    #[cfg(windows)]
    #[test]
    fn windows_authorized_open_rejects_parent_traversal_components() {
        let directory = tempfile::tempdir().unwrap();
        let nested = directory.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let path = directory.path().join("photo.jpg");
        std::fs::write(&path, b"photo").unwrap();
        let traversing = nested.join("..").join("photo.jpg");

        assert!(open_secure_file(&traversing).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_authorized_open_allows_preexisting_reparse_ancestor() {
        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real-workspace");
        let alias = directory.path().join("runner-workspace");
        std::fs::create_dir(&real).unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&alias)
            .arg(&real)
            .output()
            .unwrap();
        if !output.status.success() {
            return;
        }

        let real_photo = real.join("photo.jpg");
        let aliased_photo = alias.join("photo.jpg");
        std::fs::write(&real_photo, b"photo").unwrap();
        let mut authority = FilesystemAuthority::default();

        authority.register_picker_file(&aliased_photo).unwrap();
        assert!(authority.open_authorized_file(&aliased_photo).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_folder_walk_rejects_junction_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let approved = directory.path().join("approved");
        let outside = directory.path().join("outside");
        let junction = approved.join("linked");
        std::fs::create_dir(&approved).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("private.jpg"), b"private").unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(output.status.success());

        assert!(open_secure_folder(&junction).is_err());
        let images = collect_images_bounded(open_secure_folder(&approved).unwrap(), 10, 10);
        assert!(images.is_empty());
    }

    #[test]
    fn image_info_serialization_has_no_image_data_payload() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("lazy.png");
        write_test_png(&path, 3, 4);

        let value =
            serde_json::to_value(inspect_image_file(open_secure_file(&path).unwrap())).unwrap();

        assert_eq!(value["sourceBytes"], std::fs::metadata(path).unwrap().len());
        assert!(value.get("sourceVersion").is_some());
        assert!(value.get("data").is_none());
        assert!(value.get("dataUrl").is_none());
    }

    #[test]
    fn data_file_signatures_are_checked() {
        assert!(encode_data_file(b"name,value\nA,1", "csv").is_ok());
        assert!(encode_data_file(b"\0binary", "csv").is_err());
        assert!(encode_data_file(b"not a zip", "xlsx").is_err());
        assert!(encode_data_file(b"PK\x03\x04zip", "xlsx").is_ok());
    }

    #[test]
    fn windows_1252_csv_is_transcoded_but_spreadsheets_remain_binary() {
        let csv = encode_data_file(b"nombre\r\nJos\xE9 Mu\xF1oz\r\n", "csv").unwrap();
        let csv_bytes = base64::engine::general_purpose::STANDARD
            .decode(csv.split_once(',').unwrap().1)
            .unwrap();
        assert_eq!(
            String::from_utf8(csv_bytes).unwrap(),
            "nombre\r\nJosé Muñoz\r\n"
        );

        let xlsx = b"PK\x03\x04\xE9binary";
        let data_url = encode_data_file(xlsx, "xlsx").unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data_url.split_once(',').unwrap().1)
            .unwrap();
        assert_eq!(decoded, xlsx);

        let xls = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1\xE9binary";
        let data_url = encode_data_file(xls, "xls").unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data_url.split_once(',').unwrap().1)
            .unwrap();
        assert_eq!(decoded, xls);
    }

    #[test]
    fn reparse_tag_classifier_allows_cloud_placeholders_only() {
        const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;
        const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
        const IO_REPARSE_TAG_CLOUD: u32 = 0x9000_001A;
        assert!(reparse_tag_is_traversal(IO_REPARSE_TAG_SYMLINK));
        assert!(reparse_tag_is_traversal(IO_REPARSE_TAG_MOUNT_POINT));
        assert!(!reparse_tag_is_traversal(IO_REPARSE_TAG_CLOUD));
    }

    #[test]
    fn reqwest_errors_never_expose_request_urls() {
        let secret = "token-super-secreto";
        let error = reqwest::Client::new()
            .get(format!("https://example.com/?token={secret}"))
            .header("invalid\nheader", "value")
            .build()
            .unwrap_err();
        let message = sanitized_reqwest_error(error);
        assert!(!message.contains(secret));
        assert!(!message.contains("example.com"));
    }

    #[test]
    fn folder_walk_obeys_image_and_directory_limits() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("nested")).unwrap();
        std::fs::write(directory.path().join("a.jpg"), b"x").unwrap();
        std::fs::write(directory.path().join("b.txt"), b"x").unwrap();
        std::fs::write(directory.path().join("nested").join("c.png"), b"x").unwrap();

        let one = collect_images_bounded(open_secure_folder(directory.path()).unwrap(), 1, 10);
        assert_eq!(one.len(), 1);
        let all = collect_images_bounded(open_secure_folder(directory.path()).unwrap(), 10, 10);
        assert_eq!(all.len(), 2);
        let root_only =
            collect_images_bounded(open_secure_folder(directory.path()).unwrap(), 10, 1);
        assert_eq!(root_only.len(), 1);
    }

    #[test]
    fn filesystem_authority_denies_siblings() {
        let directory = tempfile::tempdir().unwrap();
        let approved = directory.path().join("approved");
        let sibling = directory.path().join("sibling");
        std::fs::create_dir(&approved).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        let approved_photo = approved.join("inside.jpg");
        let sibling_photo = sibling.join("outside.jpg");
        std::fs::write(&approved_photo, b"inside").unwrap();
        std::fs::write(&sibling_photo, b"outside").unwrap();

        let mut authority = FilesystemAuthority::default();
        authority.register_picker_folder(&approved).unwrap();
        assert!(authority.open_authorized_file(&approved_photo).is_ok());
        assert!(authority.open_authorized_file(&sibling_photo).is_err());
        assert!(authority.open_authorized_folder(&sibling).is_err());
    }

    #[test]
    fn native_drop_authorizes_only_supported_files() {
        let directory = tempfile::tempdir().unwrap();
        let photo = directory.path().join("photo.jpg");
        let csv = directory.path().join("records.csv");
        let unsupported = directory.path().join("notes.txt");
        std::fs::write(&photo, b"photo").unwrap();
        std::fs::write(&csv, b"dni,nombre").unwrap();
        std::fs::write(&unsupported, b"private").unwrap();

        let mut authority = FilesystemAuthority::default();
        authority.register_native_drop(&[photo.clone(), csv.clone(), unsupported.clone()]);

        assert!(authority.open_authorized_file(&photo).is_ok());
        assert!(authority.open_authorized_file(&csv).is_ok());
        assert!(authority.open_authorized_file(&unsupported).is_err());
    }

    #[test]
    fn native_drop_filters_unsupported_entries_before_batch_limit() {
        let directory = tempfile::tempdir().unwrap();
        let unsupported = directory.path().join("notes.txt");
        let image_directory = directory.path().join("album.jpg");
        let photo = directory.path().join("photo.jpg");
        let csv = directory.path().join("records.csv");
        std::fs::write(&unsupported, b"private").unwrap();
        std::fs::create_dir(&image_directory).unwrap();
        std::fs::write(&photo, b"photo").unwrap();
        std::fs::write(&csv, b"dni,nombre").unwrap();
        let mut paths = vec![unsupported.clone(); MAX_BATCH_FILES];
        paths.extend([image_directory.clone(), photo.clone(), csv.clone()]);

        let mut authority = FilesystemAuthority::default();
        authority.register_native_drop(&paths);

        assert!(authority.open_authorized_file(&photo).is_ok());
        assert!(authority.open_authorized_file(&csv).is_ok());
        assert!(authority.open_authorized_file(&unsupported).is_err());
        assert!(authority.open_authorized_file(&image_directory).is_err());
    }

    #[test]
    fn save_approval_is_exact_and_one_use() {
        let directory = tempfile::tempdir().unwrap();
        let approved = directory.path().join("approved.pdf");
        let sibling = directory.path().join("sibling.pdf");
        let mut authority = FilesystemAuthority::default();
        let normalized = authority.register_save_path(&approved).unwrap();

        assert!(authority.consume_save_path(&sibling).is_err());
        assert_eq!(authority.consume_save_path(&approved).unwrap(), normalized);
        assert!(authority.consume_save_path(&approved).is_err());
    }

    #[test]
    fn session_authorization_extracts_only_authenticated_path_fields() {
        let directory = tempfile::tempdir().unwrap();
        let template = directory.path().join("template.png");
        let photo = directory.path().join("photo.jpg");
        let ignored = directory.path().join("ignored.jpg");
        let watched = directory.path().join("watched");
        std::fs::write(&template, b"template").unwrap();
        std::fs::write(&photo, b"photo").unwrap();
        std::fs::write(&ignored, b"ignored").unwrap();
        std::fs::create_dir(&watched).unwrap();

        let value = serde_json::json!({
            "templatePath": template,
            "photoPaths": { "12345678": photo },
            "watchedFolderPath": watched,
            "otherPath": ignored,
            "nested": { "templatePath": ignored }
        });
        let paths = extract_session_authorization_paths(&value);
        assert_eq!(paths.files.len(), 2);
        assert_eq!(paths.watched_folder.as_deref(), Some(watched.as_path()));

        let mut authority = FilesystemAuthority::default();
        authority.replace_session_authorizations(&paths);
        assert!(authority.open_authorized_file(&template).is_ok());
        assert!(authority.open_authorized_file(&photo).is_ok());
        assert!(authority.open_authorized_file(&ignored).is_err());
        assert!(authority.open_authorized_folder(&watched).is_ok());
    }

    #[test]
    fn save_extension_is_normalized_and_sanitized() {
        assert_eq!(safe_extension(".PDF"), Some("pdf".to_string()));
        assert_eq!(safe_extension("tar.gz"), None);
        assert_eq!(safe_extension("../exe"), None);
    }
}
