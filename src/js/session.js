// ===================== SESSION PERSISTENCE =====================

const SESSION_KEY = 'fotocarnet_session_v2';
let _saveSessionTimer = null;

function saveSessionDebounced() {
    clearTimeout(_saveSessionTimer);
    _saveSessionTimer = setTimeout(saveSession, 2000);
}

function buildSessionData(includeDataUrl) {
    return {
        v: 2,
        savedAt: Date.now(),
        templatePath: state.templatePath || null,
        templateDataUrl: includeDataUrl ? (state.templateDataUrl || null) : null,
        templateFileName: state.templateFileName || '',
        templateW: state.templateImage?.width || 0,
        templateH: state.templateImage?.height || 0,
        photoPaths: state.photoPaths || {},
        records: state.records,
        photoOverrides: state.photoOverrides || {},
        globalPhotoConfig: state.globalPhotoConfig || null,
        currentIndex: state.currentIndex || 0,
        csvRows: state.csvRows || [],
        csvFileName: state.csvFileName || '',
        watchedFolderPath: state.watchedFolderPath || null,
        inputValues: readTrackedInputState(),
    };
}

async function saveSession() {
    if (!state.records.length) return;
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(buildSessionData(true)));
    } catch (err) {
        if (err.name === 'QuotaExceededError' || err.code === 22) {
            try {
                localStorage.setItem(SESSION_KEY, JSON.stringify(buildSessionData(false)));
                console.warn('[Sesión] templateDataUrl omitida por cuota; se usará ruta de archivo.');
            } catch (_) {
                console.warn('[Sesión] Error al guardar incluso sin templateDataUrl:', _);
                showToast('No se pudo guardar la sesión: almacenamiento lleno. Exporta antes de cerrar.', 'error');
            }
        } else {
            console.warn('[Sesión] Error al guardar:', err);
            showToast('Error al guardar sesión automática.', 'error');
        }
    }
}

async function restoreSession() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data.v || data.v < 2 || !Array.isArray(data.records) || !data.records.length) return false;

        // Discard sessions older than 30 days
        if (Date.now() - data.savedAt > 30 * 24 * 60 * 60 * 1000) {
            localStorage.removeItem(SESSION_KEY);
            return false;
        }

        // 1. Restore text data immediately (no file I/O)
        state.records        = data.records;
        state.photoOverrides = data.photoOverrides || {};
        state.globalPhotoConfig = data.globalPhotoConfig || null;
        state.currentIndex   = Math.min(data.currentIndex || 0, data.records.length - 1);
        state.templateFileName = data.templateFileName || '';
        state.photoPaths     = data.photoPaths || {};
        state.photosCount    = Object.keys(state.photoPaths).length;

        // Mark photos as "available via path" in photosMap so rendering works lazily
        state.photosMap = {};
        for (const [dniKey, filePath] of Object.entries(state.photoPaths)) {
            state.photosMap[dniKey] = filePath; // lazy: getPhotoImageByKey reads it on demand
        }

        // 2a. Restore CSV rows + mapping UI. Must run BEFORE applyTrackedInputState
        // so map-dni / map-extra have their <option>s populated when tracked values
        // are written back (otherwise select.value = '…' is a no-op).
        state.csvRows     = Array.isArray(data.csvRows) ? data.csvRows : [];
        state.csvFileName = data.csvFileName || '';
        if (state.csvRows.length) {
            const columns  = Object.keys(state.csvRows[0] || {});
            const autoDni   = autoDetectDNIColumn(columns, state.csvRows);
            const autoExtra = autoDetectExtraColumn(columns);
            populateCSVMapping(columns, autoDni, autoExtra);
            document.getElementById('column-mapping').style.display = 'block';
            document.getElementById('zone-data')?.classList.add('has-file');
            document.getElementById('data-file-name').textContent =
                `✅ ${state.csvFileName} (${state.csvRows.length} registros)`;
            document.getElementById('badge-data').textContent = '✓';
        }

        // 2b. Restore field values (positions, sizes, fonts, selected CSV columns…)
        if (data.inputValues) applyTrackedInputState(data.inputValues);

        // 2c. Rebuild csvData from the now-applied column mapping and merge with records
        if (state.csvRows.length) {
            const dniCol = document.getElementById('map-dni')?.value || '';
            state.csvData = dniCol ? buildCSVIndex(dniCol) : {};
            if (state.records.length) mergeCSVData();
        }

        // 3. Reload template image
        let templateOk = false;

        // 3a. Try dataURL saved in session (most reliable — no filesystem access needed)
        if (!templateOk && data.templateDataUrl) {
            await new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                    state.templateImage  = img;
                    state.templatePath   = data.templatePath || null;
                    state.templateDataUrl = data.templateDataUrl;
                    templateOk = true;
                    resolve();
                };
                img.onerror = resolve;
                img.src = data.templateDataUrl;
            });
        }

        // 3b. Fallback: re-read from disk via IPC (only if dataURL wasn't saved)
        if (!templateOk && data.templatePath && window.electronAPI?.readFileAsDataURL) {
            const result = await window.electronAPI.readFileAsDataURL(data.templatePath);
            if (result.ok) {
                await new Promise(resolve => {
                    const img = new Image();
                    img.onload = () => {
                        state.templateImage  = img;
                        state.templatePath   = data.templatePath;
                        state.templateDataUrl = result.dataUrl;
                        templateOk = true;
                        resolve();
                    };
                    img.onerror = resolve;
                    img.src = result.dataUrl;
                });
            }
        }

        // 4. Update UI badges / zones
        if (templateOk && state.templateImage) {
            const w = state.templateImage.width, h = state.templateImage.height;
            document.getElementById('zone-template')?.classList.add('has-file');
            document.getElementById('template-file-name').textContent = `✅ ${state.templateFileName} (${w}×${h})`;
            document.getElementById('badge-template')?.classList.add('completed');
            document.getElementById('badge-template').textContent = '✓';
            document.getElementById('status-template').textContent  = `Plantilla: ${state.templateFileName}`;
            document.getElementById('status-dimensions').textContent = `${w}×${h}px`;
        }

        if (state.records.length > 0) {
            const photoCount = Object.keys(state.photoPaths).length;
            document.getElementById('zone-photos')?.classList.add('has-file');
            document.getElementById('photos-file-name').textContent =
                `✅ ${photoCount} foto${photoCount !== 1 ? 's' : ''} (sesión restaurada)`;
            document.getElementById('badge-photos')?.classList.add('completed');
            document.getElementById('badge-photos').textContent = '✓';
        }

        // 5. Refresh all UI
        showDataPreview();
        document.getElementById('data-preview').style.display = 'block';
        updatePhotoInputsForCurrentRecord();
        updateNavigation();

        showSidebarNameEditor();
        if (templateOk) tryRender();
        renderFilmstrip();

        const mins = Math.round((Date.now() - data.savedAt) / 60000);
        const ageText = mins < 60 ? `${mins} min` : `${Math.round(mins / 60)}h`;
        showToast(
            `Sesión restaurada (${ageText} atrás) — ${state.records.length} registros, ${state.photosCount} fotos`,
            'info'
        );

        // Background preload: load all session photos in parallel after restore
        // so the filmstrip and navigation feel instant instead of loading on demand.
        _preloadSessionPhotos();

        // Reanudar vigilancia de carpeta si estaba activa antes (Tauri only).
        // Hacemos esto en background para no bloquear la restauración.
        if (data.watchedFolderPath && typeof startWatchingFolder === 'function') {
            startWatchingFolder(data.watchedFolderPath).catch(err => {
                console.warn('[Sesión] No se pudo reanudar la vigilancia:', err);
                state.watchedFolderPath = null;
            });
        }

        return true;
    } catch (err) {
        console.warn('[Sesión] Error al restaurar:', err);
        return false;
    }
}

// Preload all session photos in the background using batch IPC (rayon parallel in Rust).
// Populates state.photosMap with blob URLs so renders and filmstrip are instant.
async function _preloadSessionPhotos() {
    if (!window.electronAPI?.readFilesBatch) return;

    const entries = Object.entries(state.photosMap).filter(([, v]) =>
        v && !v.startsWith('blob:') && !v.startsWith('data:')
    );
    if (!entries.length) return;

    const keys   = entries.map(([k]) => k);
    const paths  = entries.map(([, v]) => v);

    let results;
    try {
        results = await window.electronAPI.readFilesBatch(paths);
    } catch (_) {
        return; // Non-critical — lazy loading will handle it on demand
    }

    for (let i = 0; i < keys.length; i++) {
        const result = results[i];
        if (!result?.ok) continue;
        // Only update if still a raw path (user may have changed photos since)
        const current = state.photosMap[keys[i]];
        if (!current || current.startsWith('blob:') || current.startsWith('data:')) continue;
        try {
            const [header, b64] = result.dataUrl.split(',');
            const mime = header.match(/:(.*?);/)[1];
            const bytes = atob(b64);
            const arr = new Uint8Array(bytes.length);
            for (let j = 0; j < bytes.length; j++) arr[j] = bytes.charCodeAt(j);
            const objUrl = URL.createObjectURL(new Blob([arr], { type: mime }));
            state.photosMap[keys[i]] = objUrl;
            state.photoObjectUrls.push(objUrl);
        } catch (_) {
            state.photosMap[keys[i]] = result.dataUrl;
        }
    }

    // Refresh filmstrip now that photos are ready
    renderFilmstrip();
}
