use base64::Engine;
use serde::{Deserialize, Serialize};

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────────

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

fn is_image_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
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

// ── File commands ──────────────────────────────────────────────────────────────

/// Read a local file and return it as a base64 data URL.
#[tauri::command]
fn read_file_as_dataurl(file_path: String) -> FileResult {
    match std::fs::read(&file_path) {
        Ok(data) => {
            let ext = std::path::Path::new(&file_path)
                .extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_lowercase();
            let mime = match ext.as_str() {
                "png" => "image/png", "gif" => "image/gif",
                "bmp" => "image/bmp", "webp" => "image/webp",
                _     => "image/jpeg",
            };
            let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
            FileResult { ok: true, data_url: Some(format!("data:{};base64,{}", mime, b64)), error: None }
        }
        Err(e) => FileResult { ok: false, data_url: None, error: Some(e.to_string()) },
    }
}

// ── Dialog commands ────────────────────────────────────────────────────────────

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

/// Open a native folder picker, then list all image files inside.
#[tauri::command]
fn pick_photos_from_folder(app: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let dir = app.dialog().file()
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok());

    let Some(dir_path) = dir else { return vec![]; };

    match std::fs::read_dir(&dir_path) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter(|e| is_image_path(&e.path()))
            .filter_map(|e| path_to_string(e.path()))
            .collect(),
        Err(_) => vec![],
    }
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
