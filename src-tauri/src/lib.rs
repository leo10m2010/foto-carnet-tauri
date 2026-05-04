use base64::Engine;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, SystemTime};
use tauri::Emitter;

// ── App state ─────────────────────────────────────────────────────────────────

struct CacheEntry {
    data_url: String,
    /// Last-modified time at the moment of caching — used for invalidation.
    mtime: SystemTime,
}

/// Slot holding the active folder watcher (kept alive while watching).
/// Dropping the debouncer stops the OS-level watcher.
#[derive(Default)]
struct WatcherSlot {
    debouncer: Option<Debouncer<RecommendedWatcher, FileIdMap>>,
    watched_path: Option<String>,
}

/// Shared state across Tauri commands.
struct AppState {
    /// Full-res photo cache: path → CacheEntry. RwLock allows concurrent reads.
    file_cache: RwLock<HashMap<String, CacheEntry>>,
    /// Thumbnail cache (separate so full-res and thumb don't evict each other).
    thumb_cache: RwLock<HashMap<String, CacheEntry>>,
    /// Active folder watcher (only one at a time).
    watcher: Mutex<WatcherSlot>,
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct ReniecResult {
    ok: bool,
    body: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct FileResult {
    ok: bool,
    #[serde(rename = "dataUrl")]
    data_url: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct UpdateInfo {
    version: String,
    url: String,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn is_newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.split('.').filter_map(|n| n.parse().ok()).collect()
    };
    let pa = parse(a);
    let pb = parse(b);
    for i in 0..3 {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        if va > vb { return true; }
        if va < vb { return false; }
    }
    false
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())
}

fn path_to_string(p: std::path::PathBuf) -> Option<String> {
    p.to_str().map(|s| s.to_string())
}

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "bmp", "webp", "gif"];

/// Maximum dimension for full-res photos sent over IPC (enough for any carnet print quality).
const MAX_DIM: u32 = 1600;

/// Reject files larger than this before even reading — prevents memory exhaustion
/// from an accidental 500 MB file landing in the photos folder.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024; // 50 MB

/// Reject images whose declared dimensions would blow up RAM during decode.
/// A 12000×12000 RGBA image is ~576 MB uncompressed — above this we refuse.
const MAX_IMAGE_DIM: u32 = 12000;

fn is_image_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png"  => "image/png",
        "gif"  => "image/gif",
        "bmp"  => "image/bmp",
        "webp" => "image/webp",
        _      => "image/jpeg",
    }
}

/// Encode raw image bytes as a base64 data URL, resizing if larger than `max_dim`.
fn encode_as_dataurl(data: &[u8], ext: &str, max_dim: u32) -> String {
    use image::ImageFormat;

    let fmt = match ext {
        "png"        => Some(ImageFormat::Png),
        "gif"        => Some(ImageFormat::Gif),
        "bmp"        => Some(ImageFormat::Bmp),
        "webp"       => Some(ImageFormat::WebP),
        "jpg"|"jpeg" => Some(ImageFormat::Jpeg),
        _            => None,
    };

    if let Some(fmt) = fmt {
        if let Ok(img) = image::load_from_memory_with_format(data, fmt) {
            if img.width() > max_dim || img.height() > max_dim {
                let resized = img.resize(max_dim, max_dim, image::imageops::FilterType::CatmullRom);
                let mut buf: Vec<u8> = Vec::new();
                let out_fmt = if ext == "png" { ImageFormat::Png } else { ImageFormat::Jpeg };
                let mime    = if ext == "png" { "image/png" }      else { "image/jpeg" };
                if resized.write_to(&mut std::io::Cursor::new(&mut buf), out_fmt).is_ok() && !buf.is_empty() {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
                    return format!("data:{};base64,{}", mime, b64);
                }
            }
        }
    }

    // No resize needed (or decode failed) — encode original bytes as-is.
    let b64 = base64::engine::general_purpose::STANDARD.encode(data);
    format!("data:{};base64,{}", mime_for_ext(ext), b64)
}

/// Get file modification time (returns UNIX_EPOCH on error).
fn get_mtime(path: &str) -> SystemTime {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Read image dimensions from the header only (cheap — does not decode pixels).
/// Returns None for unknown formats or malformed headers.
fn image_dims_from_bytes(data: &[u8], ext: &str) -> Option<(u32, u32)> {
    use image::{ImageFormat, ImageReader};
    use std::io::Cursor;
    let fmt = match ext {
        "png"        => ImageFormat::Png,
        "gif"        => ImageFormat::Gif,
        "bmp"        => ImageFormat::Bmp,
        "webp"       => ImageFormat::WebP,
        "jpg"|"jpeg" => ImageFormat::Jpeg,
        _            => return None,
    };
    ImageReader::with_format(Cursor::new(data), fmt).into_dimensions().ok()
}

/// Check if a cache entry is still valid (mtime unchanged).
fn cache_entry_valid(entry: &CacheEntry, path: &str) -> bool {
    get_mtime(path) == entry.mtime
}

/// Core file-read logic shared by the single and batch commands.
/// Checks the cache first (invalidates on mtime change), reads+resizes on miss.
fn read_single_file(file_path: &str, cache: &RwLock<HashMap<String, CacheEntry>>, max_dim: u32) -> FileResult {
    // Check cache under a read lock; if poisoned, recover and continue (cache is best-effort).
    if let Ok(c) = cache.read() {
        if let Some(entry) = c.get(file_path) {
            if cache_entry_valid(entry, file_path) {
                return FileResult { ok: true, data_url: Some(entry.data_url.clone()), error: None };
            }
            // mtime changed → fall through to re-read
        }
    }

    let ext = std::path::Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();

    // Reject oversized files up-front (OS-level size check, no I/O of bytes).
    if let Ok(meta) = std::fs::metadata(file_path) {
        if meta.len() > MAX_FILE_BYTES {
            return FileResult {
                ok: false,
                data_url: None,
                error: Some(format!(
                    "Archivo muy grande ({} MB, máximo {} MB)",
                    meta.len() / (1024 * 1024),
                    MAX_FILE_BYTES / (1024 * 1024)
                )),
            };
        }
    }

    match std::fs::read(file_path) {
        Ok(data) => {
            // Validate dimensions via a header-only read before full decode.
            if let Some((w, h)) = image_dims_from_bytes(&data, &ext) {
                if w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM {
                    return FileResult {
                        ok: false,
                        data_url: None,
                        error: Some(format!(
                            "Imagen muy grande ({}×{}, máximo {}×{})",
                            w, h, MAX_IMAGE_DIM, MAX_IMAGE_DIM
                        )),
                    };
                }
            }
            let data_url = encode_as_dataurl(&data, &ext, max_dim);
            let mtime = get_mtime(file_path);
            // Best-effort cache insert — if poisoned, return the result anyway.
            if let Ok(mut w) = cache.write() {
                w.insert(
                    file_path.to_string(),
                    CacheEntry { data_url: data_url.clone(), mtime },
                );
            }
            FileResult { ok: true, data_url: Some(data_url), error: None }
        }
        Err(e) => FileResult { ok: false, data_url: None, error: Some(e.to_string()) },
    }
}

/// Improvement 2: recursively walk a directory collecting image paths.
fn collect_images_recursive(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return; };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            collect_images_recursive(&path, out);
        } else if is_image_path(&path) {
            if let Some(s) = path_to_string(path) {
                out.push(s);
            }
        }
    }
}

// ── HTTP commands ─────────────────────────────────────────────────────────────

/// Proxy RENIEC/apisperu query (CORS blocked in renderer → go through Rust).
#[tauri::command]
async fn reniec_query(dni: String, token: String) -> ReniecResult {
    let url = format!(
        "https://dniruc.apisperu.com/api/v1/dni/{}?token={}",
        dni.trim(),
        token.trim()
    );
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return ReniecResult { ok: false, body: None, error: Some(e) },
    };
    let res = match client.get(&url).header("Accept", "application/json").send().await {
        Ok(r)  => r,
        Err(e) => return ReniecResult { ok: false, body: None, error: Some(e.to_string()) },
    };

    let status = res.status();
    // Map non-success HTTP codes to actionable messages before touching the body.
    if !status.is_success() {
        let code = status.as_u16();
        let msg = match code {
            401 | 403 => "Token RENIEC inválido o sin permisos".to_string(),
            404       => "DNI no encontrado".to_string(),
            429       => "Límite de consultas superado — espera unos segundos".to_string(),
            500..=599 => format!("Error del servidor RENIEC ({})", code),
            _         => format!("Respuesta HTTP inesperada ({})", code),
        };
        return ReniecResult { ok: false, body: None, error: Some(msg) };
    }

    match res.json::<serde_json::Value>().await {
        Ok(body) => ReniecResult { ok: true, body: Some(body), error: None },
        Err(e)   => ReniecResult { ok: false, body: None, error: Some(e.to_string()) },
    }
}

const UPDATE_RELEASES_URL: &str = "https://api.github.com/repos/leo10m2010/foto-carnet-tauri/releases/latest";

/// Check GitHub releases for a newer version.
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Option<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let client = http_client().ok()?;
    let res = client
        .get(UPDATE_RELEASES_URL)
        .header("User-Agent", "FotoCarnet-Tauri")
        .header("Accept", "application/vnd.github+json")
        .send().await.ok()?;
    // GitHub returns 404 for private/missing repos and 403 when rate-limited.
    // Parsing the JSON body of an error response would yield misleading info.
    if !res.status().is_success() { return None; }
    let release: serde_json::Value = res.json().await.ok()?;
    let latest = release["tag_name"].as_str()?.trim_start_matches('v').to_string();
    let url    = release["html_url"].as_str()?.to_string();
    if is_newer(&latest, &current) { Some(UpdateInfo { version: latest, url }) } else { None }
}

// ── File commands ─────────────────────────────────────────────────────────────

/// Read a single file as a base64 data URL (cached + mtime-invalidated).
#[tauri::command]
fn read_file_as_dataurl(file_path: String, state: tauri::State<AppState>) -> FileResult {
    read_single_file(&file_path, &state.file_cache, MAX_DIM)
}

/// Improvement 1 (thumbnails): read a file resized to `max_dim` px (default 200).
/// Cached separately from full-res. Useful for filmstrip or session-restore previews.
#[tauri::command]
fn read_as_thumbnail(file_path: String, max_dim: Option<u32>, state: tauri::State<AppState>) -> FileResult {
    let dim = max_dim.unwrap_or(200).clamp(32, 600);
    read_single_file(&file_path, &state.thumb_cache, dim)
}

/// Improvement 3 (parallel): read a batch of files in parallel using rayon.
/// Dramatically faster than calling read_file_as_dataurl N times sequentially.
#[tauri::command]
fn read_files_batch(file_paths: Vec<String>, state: tauri::State<AppState>) -> Vec<FileResult> {
    let cache = state.inner();
    file_paths.par_iter()
        .map(|path| read_single_file(path, &cache.file_cache, MAX_DIM))
        .collect()
}

// ── Folder watcher commands ───────────────────────────────────────────────────

/// Start watching a folder for new image files. Drops any previous watcher.
/// Emits `photo-folder-changed` to the frontend with a list of new paths
/// after a debounce window of ~800ms.
#[tauri::command]
fn start_watching_folder(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let watch_path = std::path::PathBuf::from(&path);
    if !watch_path.is_dir() {
        return Err(format!("No es una carpeta válida: {}", path));
    }

    // Drop any existing watcher first so the OS handle is released before we
    // register a new one (otherwise on Windows we can hit a transient EBUSY).
    {
        let mut slot = state.watcher.lock().map_err(|e| e.to_string())?;
        slot.debouncer = None;
        slot.watched_path = None;
    }

    let app_handle = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(800),
        None,
        move |res: DebounceEventResult| match res {
            Ok(events) => {
                use notify::EventKind;
                let mut new_paths: Vec<String> = Vec::new();
                for ev in events {
                    if !matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                        continue;
                    }
                    for p in &ev.paths {
                        if is_image_path(p) {
                            if let Some(s) = p.to_str() {
                                new_paths.push(s.to_string());
                            }
                        }
                    }
                }
                if new_paths.is_empty() {
                    return;
                }
                new_paths.sort();
                new_paths.dedup();
                let _ = app_handle.emit("photo-folder-changed", &new_paths);
            }
            Err(errors) => {
                eprintln!("[watcher] errores: {:?}", errors);
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&watch_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let mut slot = state.watcher.lock().map_err(|e| e.to_string())?;
    slot.debouncer = Some(debouncer);
    slot.watched_path = Some(path);
    Ok(())
}

/// Stop the active folder watcher.
#[tauri::command]
fn stop_watching_folder(state: tauri::State<AppState>) -> Result<(), String> {
    let mut slot = state.watcher.lock().map_err(|e| e.to_string())?;
    slot.debouncer = None;
    slot.watched_path = None;
    Ok(())
}

/// Recursively list all image paths inside `path`. Used for the initial scan
/// when binding a folder, before incremental events take over.
#[tauri::command]
fn list_folder_images(path: String) -> Vec<String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return vec![];
    }
    let mut out = Vec::new();
    collect_images_recursive(dir, &mut out);
    out.sort();
    out
}

/// Open a native folder picker. Returns the chosen path or None.
#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok())
        .and_then(path_to_string)
}

// ── Dialog commands ───────────────────────────────────────────────────────────

/// Open a native file picker for the template (single image).
#[tauri::command]
fn pick_template_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file()
        .add_filter("Imagen plantilla", IMAGE_EXTS)
        .blocking_pick_file()
        .and_then(|fp| fp.into_path().ok())
        .and_then(path_to_string)
}

/// Open a native file picker for multiple photo images.
#[tauri::command]
fn pick_photo_files(app: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file()
        .add_filter("Fotos", IMAGE_EXTS)
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|fp| fp.into_path().ok())
        .filter_map(path_to_string)
        .collect()
}

/// Open a native folder picker, then recursively list all image files inside.
#[tauri::command]
fn pick_photos_from_folder(app: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let dir = app.dialog().file()
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok());

    let Some(dir_path) = dir else { return vec![]; };
    let mut results = Vec::new();
    collect_images_recursive(&dir_path, &mut results);
    results.sort(); // consistent alphabetical order
    results
}

/// Open a native file picker for a CSV/Excel data file.
#[tauri::command]
fn pick_data_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file()
        .add_filter("Datos", &["csv", "xlsx", "xls"])
        .blocking_pick_file()
        .and_then(|fp| fp.into_path().ok())
        .and_then(path_to_string)
}

/// Show a native "Save As" dialog and return the chosen path.
/// Guarantees the returned path ends with the correct extension.
#[tauri::command]
fn pick_save_path(
    default_name: String,
    filter_name: String,
    extension: String,
    app: tauri::AppHandle,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file()
        .add_filter(&filter_name, &[extension.as_str()])
        .set_file_name(&default_name)
        .blocking_save_file()
        .and_then(|fp| fp.into_path().ok())
        .and_then(path_to_string)?;

    // Some OS dialogs don't append the extension automatically.
    let ext_dot = format!(".{}", extension.to_lowercase());
    if path.to_lowercase().ends_with(&ext_dot) {
        Some(path)
    } else {
        Some(format!("{}{}", path, ext_dot))
    }
}

/// Write an HTML string to a temp file and open it in the default browser.
/// Used by printAll() because Tauri blocks window.open() by default.
#[tauri::command]
fn open_print_preview(html: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let temp_path = std::env::temp_dir().join("fotocarnet_preview.html");
    std::fs::write(&temp_path, html.as_bytes())
        .map_err(|e| format!("No se pudo escribir archivo temporal: {}", e))?;

    let path_str = temp_path.to_str().unwrap_or("").replace('\\', "/");
    let file_url = if path_str.starts_with('/') {
        format!("file://{}", path_str)
    } else {
        format!("file:///{}", path_str)
    };

    app.opener()
        .open_url(&file_url, None::<&str>)
        .map_err(|e| format!("No se pudo abrir el navegador: {}", e))
}

/// Open an external URL in the user's default browser.
/// Tauri blocks window.open() by default, so the renderer must go through this.
#[tauri::command]
fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("No se pudo abrir el URL: {}", e))
}

/// Improvement (PDF nativo): write base64-encoded data (or a data-URI) to a file on disk.
#[tauri::command]
fn save_base64_to_file(path: String, base64_data: String) -> Result<(), String> {
    // Strip data-URI prefix if present: "data:<mime>;base64,XXXXX"
    let b64 = match base64_data.find(',') {
        Some(pos) => &base64_data[pos + 1..],
        None      => &base64_data,
    };
    let data = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

// ── App entry ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            file_cache:  RwLock::new(HashMap::new()),
            thumb_cache: RwLock::new(HashMap::new()),
            watcher:     Mutex::new(WatcherSlot::default()),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            reniec_query,
            read_file_as_dataurl,
            read_as_thumbnail,
            read_files_batch,
            check_for_updates,
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
