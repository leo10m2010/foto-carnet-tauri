// ===================== FOLDER WATCHER =====================
// Auto-importa fotos nuevas de una carpeta vigilada.
// El backend (Rust) emite 'photo-folder-changed' con paths nuevos
// tras un debounce de ~800 ms.

let _watcherUnsubscribe = null;

function setupFolderWatcher() {
    if (!window.electronAPI?.onWatchedFolderChange) return;

    // Suscripción única al evento — los paths llegan agrupados por debounce.
    _watcherUnsubscribe = window.electronAPI.onWatchedFolderChange(async (paths) => {
        if (!Array.isArray(paths) || !paths.length) return;
        await ingestNewPhotoPaths(paths);
    });
}

async function toggleFolderWatcher() {
    if (state.watchedFolderPath) {
        await stopWatchingFolder();
    } else {
        await pickAndStartWatchingFolder();
    }
}

async function pickAndStartWatchingFolder() {
    if (!window.electronAPI?.pickFolder) {
        showToast('Esta función requiere la versión escritorio (Tauri).', 'warning');
        return;
    }
    const path = await window.electronAPI.pickFolder().catch(() => null);
    if (!path) return;
    await startWatchingFolder(path);
}

async function startWatchingFolder(path) {
    if (!window.electronAPI?.watchFolder) return;

    try {
        await window.electronAPI.watchFolder(path);
    } catch (err) {
        console.warn('[watcher] No se pudo vigilar la carpeta:', err);
        showToast(`No se pudo vigilar: ${err}`, 'error');
        return;
    }

    state.watchedFolderPath = path;
    updateWatcherUI();
    saveSessionDebounced();

    // Escaneo inicial: ingesta cualquier foto ya presente que no esté en records.
    try {
        const existing = await window.electronAPI.listFolderImages(path);
        if (existing?.length) {
            const ingested = await ingestNewPhotoPaths(existing, /*silent*/ true);
            if (ingested > 0) {
                showToast(`Vigilando carpeta — ${ingested} foto${ingested !== 1 ? 's' : ''} importada${ingested !== 1 ? 's' : ''}`, 'success');
            } else {
                showToast(`Vigilando carpeta (sin fotos nuevas)`, 'info');
            }
        } else {
            showToast(`Vigilando carpeta (vacía)`, 'info');
        }
    } catch (_) {
        showToast(`Vigilando carpeta`, 'success');
    }
}

async function stopWatchingFolder() {
    if (window.electronAPI?.unwatchFolder) {
        try { await window.electronAPI.unwatchFolder(); } catch (_) {}
    }
    state.watchedFolderPath = null;
    updateWatcherUI();
    saveSessionDebounced();
    showToast('Vigilancia de carpeta detenida', 'info');
}

function updateWatcherUI() {
    const btn    = document.getElementById('btn-watch-folder');
    const status = document.getElementById('watched-folder-status');
    if (!btn) return;

    if (state.watchedFolderPath) {
        btn.innerHTML = '<i data-lucide="eye-off"></i><span>Detener vigilancia</span>';
        btn.classList.add('btn-watching');
        if (status) {
            const shortPath = _shortenPath(state.watchedFolderPath, 50);
            status.style.display = 'flex';
            status.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 6px #34d399;"></span> <span title="${state.watchedFolderPath}">Vigilando: <strong>${shortPath}</strong></span>`;
        }
    } else {
        btn.innerHTML = '<i data-lucide="eye"></i><span>Vincular carpeta (auto-importar)</span>';
        btn.classList.remove('btn-watching');
        if (status) status.style.display = 'none';
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function _shortenPath(p, max) {
    if (p.length <= max) return p;
    const head = p.slice(0, 3);
    const tail = p.slice(-(max - 4));
    return `${head}…${tail}`;
}

// Ingesta paths nuevos en state.records sin resetear lo existente.
// Devuelve la cantidad de fotos efectivamente añadidas (omite duplicados por dniKey).
async function ingestNewPhotoPaths(paths, silent = false) {
    if (!window.electronAPI?.readFilesBatch) return 0;

    const imageRe = /\.(jpg|jpeg|png|gif|bmp|webp)$/i;
    const candidates = paths.filter(p => imageRe.test(p));
    if (!candidates.length) return 0;

    // Filtra duplicados: si ya existe un record con este dniKey, lo omitimos.
    const existingKeys = new Set(state.records.map(r => r.dniKey));
    const fresh = [];
    for (const fullPath of candidates) {
        const fileName = fullPath.replace(/\\/g, '/').split('/').pop();
        const parsed   = parsePhotoFilename(fileName);
        const dniKey   = parsed.dniKey || normalizeDNI(parsed.dni);
        if (existingKeys.has(dniKey)) continue;
        existingKeys.add(dniKey);
        fresh.push({ fullPath, fileName, parsed, dniKey });
    }
    if (!fresh.length) return 0;

    if (!silent && fresh.length > 3) {
        showToast(`Importando ${fresh.length} foto${fresh.length !== 1 ? 's' : ''} nueva${fresh.length !== 1 ? 's' : ''}…`, 'info');
    }

    let results;
    try {
        results = await window.electronAPI.readFilesBatch(fresh.map(f => f.fullPath));
    } catch (err) {
        console.warn('[watcher] Error leyendo lote:', err);
        return 0;
    }

    state.globalPhotoConfig = state.globalPhotoConfig || readPhotoConfigFromInputs();

    let added = 0;
    for (let i = 0; i < fresh.length; i++) {
        const result = results[i];
        if (!result?.ok) continue;

        const { fullPath, parsed, dniKey } = fresh[i];

        // Convierte dataURL → blob URL para evitar tener data: en RAM al renderizar.
        let objUrl = result.dataUrl;
        try {
            const [header, b64] = result.dataUrl.split(',');
            const mime  = header.match(/:(.*?);/)[1];
            const bytes = atob(b64);
            const arr   = new Uint8Array(bytes.length);
            for (let j = 0; j < bytes.length; j++) arr[j] = bytes.charCodeAt(j);
            objUrl = URL.createObjectURL(new Blob([arr], { type: mime }));
            state.photoObjectUrls.push(objUrl);
        } catch (_) {
            // Fallback: usa la dataURL directamente
        }

        state.photosMap[dniKey]  = objUrl;
        state.photoPaths[dniKey] = fullPath;
        state.photosCount++;

        state.records.push({
            dni: parsed.dni,
            dniKey,
            nombres: parsed.nombres,
            apellidos: parsed.apellidos,
            extra: '',
            hasPhoto: true,
        });
        added++;
    }

    if (!added) return 0;

    state.records.sort((a, b) =>
        (a.dniKey || '').localeCompare(b.dniKey || '') ||
        (a.dni || '').localeCompare(b.dni || '')
    );

    if (Array.isArray(state.csvRows) && state.csvRows.length > 0) {
        try { mergeCSVData(); } catch (_) {}
    }

    // UI: si la sección Fotos aún no está marcada como completada, márcala.
    const zonePhotos = document.getElementById('zone-photos');
    if (zonePhotos && !zonePhotos.classList.contains('has-file')) {
        zonePhotos.classList.add('has-file');
        document.getElementById('badge-photos')?.classList.add('completed');
        const badge = document.getElementById('badge-photos');
        if (badge) badge.textContent = '✓';
    }
    const fileNameEl = document.getElementById('photos-file-name');
    if (fileNameEl) fileNameEl.textContent = `✅ ${state.photosCount} foto${state.photosCount !== 1 ? 's' : ''} cargadas`;

    showDataPreview();
    document.getElementById('data-preview').style.display = 'block';
    updatePhotoInputsForCurrentRecord();
    updateNavigation();
    updateStatusBar();
    renderFilmstrip();
    tryRender();
    saveSessionDebounced();

    if (!silent) {
        showToast(`+${added} foto${added !== 1 ? 's' : ''} auto-importada${added !== 1 ? 's' : ''}`, 'success');
    }

    // Enriquecimiento RENIEC en background (mismo flow que carga manual)
    try { enrichWithRENIEC(); } catch (_) {}

    return added;
}
