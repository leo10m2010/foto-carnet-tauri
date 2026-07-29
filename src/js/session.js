// ===================== SESSION PERSISTENCE =====================

const SESSION_KEY = 'fotocarnet_session_v2';
const SESSION_PERSISTENCE_KEY = 'fotocarnet_session_persist';
const SESSION_TOO_LARGE_ERROR = 'La sesión supera el tamaño máximo permitido';
let _saveSessionTimer = null;
let _sessionPersistenceEnabled = false;
let _sessionStorageQueue = Promise.resolve();

function isOfficialTauriRuntime() {
    return !!window.__TAURI__;
}

function queueSessionStorageOperation(operation) {
    const result = _sessionStorageQueue.then(operation, operation);
    _sessionStorageQueue = result.catch(() => {});
    return result;
}

function setSessionPersistencePreference(enabled) {
    try {
        localStorage.setItem(SESSION_PERSISTENCE_KEY, String(enabled));
        return true;
    } catch (_) {
        return false;
    }
}

async function clearPersistedSession(options = {}) {
    if (!options.preserveLegacy) {
        try {
            localStorage.removeItem(SESSION_KEY);
        } catch (_) {}
    }
    if (!isOfficialTauriRuntime()) return;
    return queueSessionStorageOperation(async () => {
        if (!window.electronAPI?.clearSecureSession) {
            throw new Error('El almacenamiento seguro no está disponible');
        }
        await window.electronAPI.clearSecureSession();
    });
}

function parseValidLegacySession(raw) {
    if (!raw) return null;
    try {
        const data = JSON.parse(raw);
        if (!data || data.v < 2 || !Array.isArray(data.records) || !data.records.length) return null;
        if (!Number.isFinite(data.savedAt) || data.savedAt <= 0) return null;
        return data;
    } catch (_) {
        return null;
    }
}

async function saveSecureSessionJson(sessionJson, dataWithoutTemplate = null) {
    if (!window.electronAPI?.saveSecureSession) {
        throw new Error('El almacenamiento seguro no está disponible');
    }
    try {
        await window.electronAPI.saveSecureSession(sessionJson);
    } catch (err) {
        if (!String(err).includes(SESSION_TOO_LARGE_ERROR)) throw err;
        const compactData = dataWithoutTemplate || JSON.parse(sessionJson);
        await window.electronAPI.saveSecureSession(JSON.stringify({ ...compactData, templateDataUrl: null }));
        console.warn('[Sesión] templateDataUrl omitida por límite; se usará ruta de archivo.');
    }
}

async function initializeSessionPersistence() {
    let preferenceValue = null;
    let legacySessionJson = null;
    try {
        preferenceValue = localStorage.getItem(SESSION_PERSISTENCE_KEY);
        legacySessionJson = localStorage.getItem(SESSION_KEY);
        _sessionPersistenceEnabled = preferenceValue === 'true';
    } catch (_) {
        _sessionPersistenceEnabled = false;
    }

    const persistInput = document.getElementById('session-persist');
    const detail = document.getElementById('session-persistence-detail');
    if (!isOfficialTauriRuntime()) {
        if (detail) {
            detail.textContent = 'Fallback del navegador: se guarda en localStorage sin cifrado de la aplicación.';
        }
    }

    let preserveLegacy = false;
    const shouldMigrateLegacy = isOfficialTauriRuntime() && legacySessionJson &&
        (preferenceValue === null || _sessionPersistenceEnabled);
    if (shouldMigrateLegacy) {
        const legacyData = parseValidLegacySession(legacySessionJson);
        if (legacyData) {
            try {
                await queueSessionStorageOperation(() => saveSecureSessionJson(legacySessionJson, legacyData));
                if (!setSessionPersistencePreference(true)) {
                    throw new Error('No se pudo guardar la preferencia de sesión segura');
                }
                try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
                _sessionPersistenceEnabled = true;
                showToast('Sesión anterior migrada al almacenamiento seguro', 'info');
            } catch (err) {
                preserveLegacy = true;
                if (preferenceValue === null) _sessionPersistenceEnabled = false;
                console.warn('[Sesión] No se pudo migrar la sesión anterior:', err);
                showToast('La sesión anterior se conservó sin cambios; no se pudo cifrar todavía', 'error');
            }
        } else {
            preserveLegacy = true;
            if (detail) detail.textContent = 'Hay una sesión anterior que no se modificará hasta que pueda migrarse de forma segura.';
            showToast('Se conservó una sesión anterior que requiere activación manual', 'warning');
        }
    }

    if (!_sessionPersistenceEnabled) {
        try {
            await clearPersistedSession({ preserveLegacy });
        } catch (err) {
            console.warn('[Sesión] No se pudo completar la limpieza segura:', err);
        }
    }

    if (persistInput) persistInput.checked = _sessionPersistenceEnabled;

    if (persistInput && persistInput.dataset.bound !== '1') {
        persistInput.dataset.bound = '1';
        persistInput.addEventListener('change', async () => {
            if (persistInput.checked) {
                _sessionPersistenceEnabled = true;
                const saved = await saveSession({ allowEmpty: true });
                if (saved && setSessionPersistencePreference(true)) {
                    showToast('Guardado seguro de sesión activado', 'info');
                } else {
                    _sessionPersistenceEnabled = false;
                    persistInput.checked = false;
                    setSessionPersistencePreference(false);
                    if (saved) {
                        try { await clearPersistedSession(); } catch (_) {}
                        showToast('No se pudo activar el guardado seguro de sesión', 'error');
                    }
                }
                return;
            }
            clearTimeout(_saveSessionTimer);
            _saveSessionTimer = null;
            try {
                await clearPersistedSession();
                _sessionPersistenceEnabled = false;
                setSessionPersistencePreference(false);
                showToast('Sesión guardada eliminada', 'info');
            } catch (err) {
                _sessionPersistenceEnabled = true;
                persistInput.checked = true;
                setSessionPersistencePreference(true);
                console.warn('[Sesión] No se pudo eliminar la sesión guardada:', err);
                showToast('No se pudo eliminar la sesión guardada', 'error');
            }
        });
    }
}

function setupSecureClearAll() {
    if (typeof clearAll !== 'function' || clearAll._securePersistenceWrapped) return;
    const clearAllBase = clearAll;
    clearAll = async function secureClearAll() {
        await clearAllBase();
        const wasCleared = !state.records.length && !state.templateImage && !state.csvRows?.length;
        if (!wasCleared) return;
        const results = await Promise.allSettled([
            clearPersistedSession(),
            window.electronAPI?.clearBackendCaches?.()
        ]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) {
            console.warn('[Sesión] La limpieza nativa no se completó:', failure.reason);
            showToast('No se pudo completar la limpieza segura', 'error');
        }
    };
    clearAll._securePersistenceWrapped = true;
}

function saveSessionDebounced() {
    clearTimeout(_saveSessionTimer);
    _saveSessionTimer = setTimeout(saveSession, 2000);
}

function flushPendingSessionSave() {
    if (_saveSessionTimer) {
        clearTimeout(_saveSessionTimer);
        _saveSessionTimer = null;
    }
    const saveResult = saveSession();
    if (!isOfficialTauriRuntime()) return saveResult;
    const queuedNativeSave = _sessionStorageQueue;
    return Promise.all([saveResult, queuedNativeSave]).then(([result]) => result);
}

function buildSessionData(includeDataUrl) {
    ensureRecordIdentities(state.records);
    const currentRecord = state.records[state.currentIndex];
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
        currentRecordId: currentRecord ? getRecordIdentity(currentRecord) : '',
        csvRows: state.csvRows || [],
        csvFileName: state.csvFileName || '',
        watchedFolderPath: state.watchedFolderPath || null,
        inputValues: readTrackedInputState(),
    };
}

async function saveSession(options = {}) {
    if (!_sessionPersistenceEnabled || (!state.records.length && !options.allowEmpty)) return true;
    const saveOperation = async () => {
        let sessionJson = JSON.stringify(buildSessionData(true));
        if (isOfficialTauriRuntime()) {
            await saveSecureSessionJson(sessionJson, buildSessionData(false));
            return;
        }

        // Fallback web explícito: solo se usa después del opt-in del operador.
        try {
            localStorage.setItem(SESSION_KEY, sessionJson);
        } catch (err) {
            if (err.name !== 'QuotaExceededError' && err.code !== 22) throw err;
            localStorage.setItem(SESSION_KEY, JSON.stringify(buildSessionData(false)));
            console.warn('[Sesión web] templateDataUrl omitida por cuota.');
        }
    };

    try {
        if (isOfficialTauriRuntime()) await queueSessionStorageOperation(saveOperation);
        else await saveOperation();
        return true;
    } catch (err) {
        console.warn('[Sesión] No se pudo guardar la sesión:', err);
        showToast('No se pudo guardar la sesión de forma segura', 'error');
        return false;
    }
}

async function restoreSession() {
    if (!_sessionPersistenceEnabled) return false;
    const lifecycleGeneration = state.lifecycleGeneration;
    const templateLoadGeneration = ++state.templateLoadGeneration;
    const photoLoadGeneration = ++state.photoLoadGeneration;
    const isStale = () => state.lifecycleGeneration !== lifecycleGeneration ||
        state.templateLoadGeneration !== templateLoadGeneration ||
        state.photoLoadGeneration !== photoLoadGeneration;
    try {
        let raw;
        if (isOfficialTauriRuntime()) {
            if (!window.electronAPI?.loadSecureSession) {
                throw new Error('El almacenamiento seguro no está disponible');
            }
            raw = await queueSessionStorageOperation(() => window.electronAPI.loadSecureSession());
        } else {
            raw = localStorage.getItem(SESSION_KEY);
        }
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data.v || data.v < 2 || !Array.isArray(data.records) || !data.records.length) return false;

        // Discard sessions older than 30 days
        if (Date.now() - data.savedAt > 30 * 24 * 60 * 60 * 1000) {
            await clearPersistedSession();
            return false;
        }

        // 1. Restore text data immediately (no file I/O)
        if (isStale()) return false;
        state.records        = data.records.map(record => ({ ...record }));
        ensureRecordIdentities(state.records);
        state.photoOverrides = data.photoOverrides || {};
        state.globalPhotoConfig = data.globalPhotoConfig || null;
        const stableIndex = data.currentRecordId
            ? state.records.findIndex(record => getRecordIdentity(record) === data.currentRecordId)
            : -1;
        state.currentIndex   = stableIndex >= 0
            ? stableIndex
            : Math.min(data.currentIndex || 0, data.records.length - 1);
        state.templateFileName = data.templateFileName || '';
        state.photoPaths     = data.photoPaths || {};
        state.photoMeta      = {};
        state.photosCount    = Object.keys(state.photoPaths).length;

        // Mark photos as "available via path" in photosMap so rendering works lazily
        state.photosMap = {};
        for (const [dniKey, filePath] of Object.entries(state.photoPaths)) {
            state.photosMap[dniKey] = filePath; // lazy: getPhotoImageByKey reads it on demand
        }
        state.records.forEach(record => {
            record.hasPhoto = !!state.photoPaths[getRecordKey(record)];
        });

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
            setFileStatus('data-file-name', 'check-circle-2', `${state.csvFileName} (${state.csvRows.length} registros)`);
            setStepBadgeCompleted('badge-data');
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
                    if (isStale()) { resolve(); return; }
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
            if (!isStale() && result.ok) {
                await new Promise(resolve => {
                    const img = new Image();
                    img.onload = () => {
                        if (isStale()) { resolve(); return; }
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

        if (isStale()) return false;

        // Validate persisted photo paths before presenting them as available.
        await _preloadSessionPhotos(photoLoadGeneration, lifecycleGeneration);
        if (isStale()) return false;
        state.photosCount = state.records.filter(record => record.hasPhoto).length;

        // 4. Update UI badges / zones
        if (templateOk && state.templateImage) {
            const w = state.templateImage.width, h = state.templateImage.height;
            document.getElementById('zone-template')?.classList.add('has-file');
            setFileStatus('template-file-name', 'check-circle-2', `${state.templateFileName} (${w}×${h})`);
            document.getElementById('badge-template')?.classList.add('completed');
            setStepBadgeCompleted('badge-template');
            document.getElementById('status-template').textContent  = `Plantilla: ${state.templateFileName}`;
            document.getElementById('status-dimensions').textContent = `${w}×${h}px`;
        }

        if (state.photosCount > 0) {
            const photoCount = state.photosCount;
            document.getElementById('zone-photos')?.classList.add('has-file');
            setFileStatus('photos-file-name', 'check-circle-2', `${photoCount} foto${photoCount !== 1 ? 's' : ''} (sesión restaurada)`);
            document.getElementById('badge-photos')?.classList.add('completed');
            setStepBadgeCompleted('badge-photos');
            showPhotoImportReady(photoCount);
        }

        // 5. Refresh all UI
        showDataPreview();
        document.getElementById('data-preview').style.display = 'block';
        updatePhotoInputsForCurrentRecord();
        updateNavigation();
        updateStatusBar();

        showSidebarNameEditor();
        if (templateOk) tryRender();
        renderFilmstrip();

        const mins = Math.round((Date.now() - data.savedAt) / 60000);
        const ageText = mins < 60 ? `${mins} min` : `${Math.round(mins / 60)}h`;
        showToast(
            `Sesión restaurada (${ageText} atrás) — ${state.records.length} registros, ${state.photosCount} fotos`,
            'info'
        );

        // Reanudar vigilancia de carpeta si estaba activa antes (Tauri only).
        // Hacemos esto en background para no bloquear la restauración.
        if (data.watchedFolderPath && typeof startWatchingFolder === 'function') {
            startWatchingFolder(data.watchedFolderPath).catch(err => {
                console.warn('[Sesión] No se pudo reanudar la vigilancia:', err);
                state.watchedFolderPath = null;
            });
        }

        state.history.undoStack = [];
        state.history.redoStack = [];
        state.history.lastSignature = '';
        updateHistoryButtons();
        saveSessionDebounced();

        return true;
    } catch (err) {
        console.warn('[Sesión] Error al restaurar:', err);
        return false;
    }
}

// Validate restored paths and retain only metadata. Photo bytes stay on disk
// until an individual image is actually needed by the renderer.
async function _preloadSessionPhotos(photoLoadGeneration = state.photoLoadGeneration, lifecycleGeneration = state.lifecycleGeneration) {
    const isStale = () => state.photoLoadGeneration !== photoLoadGeneration ||
        state.lifecycleGeneration !== lifecycleGeneration;
    if (!window.electronAPI?.inspectImageFiles) return;

    const entries = Object.entries(state.photoPaths || {}).filter(([, v]) =>
        v && !v.startsWith('blob:') && !v.startsWith('data:')
    );
    if (!entries.length) return;

    const keys   = entries.map(([k]) => k);
    const paths  = entries.map(([, v]) => v);

    let results;
    try {
        results = await window.electronAPI.inspectImageFiles(paths);
    } catch (_) {
        return;
    }

    if (isStale()) return;

    for (let i = 0; i < keys.length; i++) {
        if (state.photoPaths[keys[i]] !== paths[i] || state.photosMap[keys[i]] !== paths[i]) continue;
        const result = results[i];
        if (!result?.ok) {
            state.records.forEach(record => {
                if (getRecordKey(record) === keys[i]) record.hasPhoto = false;
            });
            delete state.photosMap[keys[i]];
            delete state.photoPaths[keys[i]];
            delete state.photoMeta[keys[i]];
            continue;
        }
        state.photoMeta[keys[i]] = {
            source: paths[i],
            filePath: paths[i],
            width: result.width,
            height: result.height,
            sourceBytes: result.sourceBytes,
            sourceVersion: result.sourceVersion,
        };
    }
}
