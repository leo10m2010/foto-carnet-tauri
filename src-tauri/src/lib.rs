use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

// ── App state ─────────────────────────────────────────────────────────────────

/// Shared state across Tauri commands.
struct AppState {
    /// Bug-fix 3: cache path → data URL to avoid re-reading disk on session restore.
    file_cache: Mutex<HashMap<String, String>>,
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

/// Max dimension (px) for either side of a photo sent to the renderer.
/// Enough for any carnet print quality; prevents sending 4K+ images over IPC.
const MAX_DIM: u32 = 1600;

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

/// Bug-fix 1: resize oversized images in Rust before base64-encoding them.
/// Avoids sending multi-MB strings over IPC for every photo.
fn encode_as_dataurl(data: &[u8], ext: &str) -> String {
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
            if img.width() > MAX_DIM || img.height() > MAX_DIM {
                let resized = img.resize(MAX_DIM, MAX_DIM, image::imageops::FilterType::CatmullRom);
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

/// Bug-fix 2: recursively walk a directory collecting image paths.
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
        "https://dniruc.apisperu.com/api/v1/dni/{}&token={}",
        dni.trim(),
        token.trim()
    );
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return ReniecResult { ok: false, body: None, error: Some(e) },
    };
    match client.get(&url).header("Accept", "application/json").send().await {
        Ok(res) => match res.json::<serde_json::Value>().await {
            Ok(body) => ReniecResult { ok: true, body: Some(body), error: None },
            Err(e)   => ReniecResult { ok: false, body: None, error: Some(e.to_string()) },
        },
        Err(e) => ReniecResult { ok: false, body: None, error: Some(e.to_string()) },
    }
}

/// Check GitHub releases for a newer version.
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Option<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let client = http_client().ok()?;
    let res = client
        .get("https://api.github.com/repos/leo10m2010/foto-carnet-tauri/releases/latest")
        .header("User-Agent", "FotoCarnet-Tauri")
        .header("Accept", "application/vnd.github+json")
        .send().await.ok()?;
    let release: serde_json::Value = res.json().await.ok()?;
    let latest = release["tag_name"].as_str()?.trim_start_matches('v').to_string();
    let url    = release["html_url"].as_str()?.to_string();
    if is_newer(&latest, &current) { Some(UpdateInfo { version: latest, url }) } else { None }
}

// ── File commands ─────────────────────────────────────────────────────────────

/// Read a local file and return it as a base64 data URL.
/// Results are cached in memory — repeated reads of the same path are instant.
#[tauri::command]
fn read_file_as_dataurl(file_path: String, state: tauri::State<AppState>) -> FileResult {
    // Bug-fix 3: return cached result if available (avoids repeated disk reads on
    // session restore or filmstrip navigation with the same photos).
    {
        let cache = state.file_cache.lock().unwrap();
        if let Some(cached) = cache.get(&file_path) {
            return FileResult { ok: true, data_url: Some(cached.clone()), error: None };
        }
    }

    let ext = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();

    match std::fs::read(&file_path) {
        Ok(data) => {
            let data_url = encode_as_dataurl(&data, &ext);
            state.file_cache.lock().unwrap().insert(file_path, data_url.clone());
            FileResult { ok: true, data_url: Some(data_url), error: None }
        }
        Err(e) => FileResult { ok: false, data_url: None, error: Some(e.to_string()) },
    }
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

// ── App entry ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState { file_cache: Mutex::new(HashMap::new()) })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            reniec_query,
            read_file_as_dataurl,
            check_for_updates,
            pick_template_file,
            pick_photo_files,
            pick_photos_from_folder,
            pick_data_file,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar FotoCarnet");
}
