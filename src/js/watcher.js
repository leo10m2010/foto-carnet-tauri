// ===================== FOLDER WATCHER =====================
// Auto-importa fotos nuevas de una carpeta vigilada.
// El backend (Rust) emite 'photo-folder-changed' con paths nuevos
// tras un debounce de ~800 ms.

let _watcherUnsubscribe = null;
let _watcherGeneration = 0;
let _watcherIngestQueue = Promise.resolve();

function _sameWatchPath(a, b) {
    const normalize = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return normalize(a) === normalize(b);
}

function _invalidateWatcherPhotoCaches(key) {
    const scope = typeof window !== 'undefined' ? window : globalThis;
    const helper = typeof invalidatePhotoCachesForKey === 'function'
        ? invalidatePhotoCachesForKey
        : typeof invalidatePhotoCacheForKey === 'function'
            ? invalidatePhotoCacheForKey
            : scope.invalidatePhotoCachesForKey || scope.invalidatePhotoCacheForKey;
    if (typeof helper === 'function') {
        helper(key);
        return;
    }
    if (typeof state.photoImageCache?.delete === 'function') {
        state.photoImageCache.delete(key);
    } else if (state.photoImageCache?._map && typeof state.photoImageCache._map.delete === 'function') {
        state.photoImageCache._map.delete(key);
    } else {
        state.photoImageCache?.clear?.();
    }
    delete state.photoFaceBoxes[key];
}

function _isWatcherGenerationCurrent(generation, watchedPath, recordsRef) {
    return generation === _watcherGeneration &&
        !!state.watchedFolderPath &&
        _sameWatchPath(state.watchedFolderPath, watchedPath) &&
        state.records === recordsRef;
}

function _queueWatcherIngestion(paths, silent, generation, watchedPath, options = {}) {
    const recordsRef = state.records;
    const run = () => {
        const importGeneration = options.showImportStatus ? ++state.photoImportGeneration : null;
        return _ingestNewPhotoPaths(paths, silent, generation, watchedPath, recordsRef, importGeneration, options);
    };
    const queued = _watcherIngestQueue.then(run, run);
    _watcherIngestQueue = queued.catch(err => console.warn('[watcher] Error en cola de ingesta:', err));
    return queued;
}

function setupFolderWatcher() {
    document.querySelectorAll('[data-watch-folder]').forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleFolderWatcher();
        });
    });

    if (!window.electronAPI?.onWatchedFolderChange) return;

    // Suscripción única al evento — los paths llegan agrupados por debounce.
    _watcherUnsubscribe = window.electronAPI.onWatchedFolderChange((paths) => {
        if (!Array.isArray(paths) || !paths.length) return;
        const generation = _watcherGeneration;
        const watchedPath = state.watchedFolderPath;
        if (!watchedPath) return;
        _queueWatcherIngestion(paths, false, generation, watchedPath).catch(() => {});
    });

    document.querySelectorAll('[data-app-action="clear"]').forEach(btn => {
        if (btn.dataset.watcherClearBound === '1') return;
        btn.dataset.watcherClearBound = '1';
        btn.addEventListener('click', () => {
            setTimeout(() => {
                const wasCleared = !state.templateImage && state.records.length === 0 &&
                    (!Array.isArray(state.csvRows) || state.csvRows.length === 0);
                if (wasCleared && state.watchedFolderPath) stopWatchingFolder(true);
            }, 0);
        });
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
    const path = await window.electronAPI.pickFolder().catch((err) => {
        console.error('[watcher] No se pudo abrir el selector de carpeta:', err);
        showToast('No se pudo abrir el selector de carpeta.', 'error');
        return null;
    });
    if (!path) return;
    await startWatchingFolder(path);
}

async function startWatchingFolder(path) {
    if (!window.electronAPI?.watchFolder) return;
    if (typeof path !== 'string' || !path.trim()) return;

    const watchedPath = path.trim();
    const generation = ++_watcherGeneration;

    try {
        await window.electronAPI.watchFolder(watchedPath);
    } catch (err) {
        if (generation !== _watcherGeneration) return;
        console.warn('[watcher] No se pudo vigilar la carpeta:', err);
        showToast(`No se pudo vigilar: ${err}`, 'error');
        return;
    }
    if (generation !== _watcherGeneration) return;

    state.watchedFolderPath = watchedPath;
    updateWatcherUI();
    saveSessionDebounced();
    const recordsRef = state.records;

    // Escaneo inicial: ingesta cualquier foto ya presente que no esté en records.
    try {
        const existing = await window.electronAPI.listFolderImages(watchedPath);
        if (generation !== _watcherGeneration || !_sameWatchPath(state.watchedFolderPath, watchedPath) || state.records !== recordsRef) return;
        if (existing?.length) {
            const ingested = await ingestNewPhotoPaths(existing, /*silent*/ true, generation, watchedPath, {
                showImportStatus: true
            });
            if (generation !== _watcherGeneration) return;
            if (ingested > 0) {
                showToast(`Vigilando carpeta — ${ingested} foto${ingested !== 1 ? 's' : ''} procesada${ingested !== 1 ? 's' : ''}`, 'success');
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

async function stopWatchingFolder(silent = false) {
    ++_watcherGeneration;
    state.watchedFolderPath = null;
    if (window.electronAPI?.unwatchFolder) {
        try { await window.electronAPI.unwatchFolder(); } catch (_) {}
    }
    updateWatcherUI();
    saveSessionDebounced();
    if (!silent) showToast('Vigilancia de carpeta detenida', 'info');
}

function updateWatcherUI() {
    const btn    = document.getElementById('btn-watch-folder');
    const status = document.getElementById('watched-folder-status');
    if (!btn) return;

    if (state.watchedFolderPath) {
        setIconButtonContent(btn, 'eye-off', 'Detener vigilancia');
        btn.classList.add('btn-watching');
        if (status) {
            const shortPath = _shortenPath(state.watchedFolderPath, 50);
            status.style.display = 'flex';
            status.innerHTML = `${iconHtml('radio', 'watched-folder-icon')}<span title="${escapeHtmlAttr(state.watchedFolderPath)}">Vigilando: <strong>${escapeHtml(shortPath)}</strong></span>`;
        }
    } else {
        setIconButtonContent(btn, 'eye', 'Vincular carpeta (auto-importar)');
        btn.classList.remove('btn-watching');
        if (status) status.style.display = 'none';
    }
    refreshLucideIcons();
}

function _shortenPath(p, max) {
    if (p.length <= max) return p;
    const head = p.slice(0, 3);
    const tail = p.slice(-(max - 4));
    return `${head}…${tail}`;
}

// Ingesta paths nuevos en state.records sin resetear lo existente.
// Devuelve la cantidad de fotos añadidas o actualizadas.
function ingestNewPhotoPaths(paths, silent = false, generation = _watcherGeneration, watchedPath = state.watchedFolderPath, options = {}) {
    if (!watchedPath) return Promise.resolve(0);
    return _queueWatcherIngestion(paths, silent, generation, watchedPath, options);
}

async function _ingestNewPhotoPaths(paths, silent, generation, watchedPath, recordsRef, importGeneration = null, options = {}) {
    if (!window.electronAPI?.inspectImageFiles) return 0;
    const isCurrent = () => _isWatcherGenerationCurrent(generation, watchedPath, recordsRef) &&
        (importGeneration === null || state.photoImportGeneration === importGeneration);
    if (!isCurrent()) return 0;

    const imageRe = /\.(jpg|jpeg|png|gif|bmp|webp)$/i;
    const folderPrefix = String(watchedPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/';
    const candidates = paths.filter(p => {
        const normalized = String(p || '').replace(/\\/g, '/').toLowerCase();
        return imageRe.test(normalized) && normalized.startsWith(folderPrefix);
    });
    if (!candidates.length) return 0;

    const existingByKey = new Map(state.records.map(record => [getRecordKey(record), record]));
    const incomingByKey = new Map();
    for (const fullPath of candidates) {
        const fileName = fullPath.replace(/\\/g, '/').split('/').pop();
        const parsed   = parsePhotoFilename(fileName);
        const dniKey   = parsed.dniKey || normalizeDNI(parsed.dni);
        if (!dniKey) continue;
        incomingByKey.set(dniKey, { fullPath, fileName, parsed, dniKey, existing: existingByKey.get(dniKey) || null });
    }
    const incoming = Array.from(incomingByKey.values());
    if (!incoming.length) return 0;
    const duplicateCount = Math.max(0, candidates.length - incoming.length);

    if (options.showImportStatus) {
        showPhotoImportProgress(
            'Inspeccionando carpeta vinculada',
            `${formatPhotoImportCount(incoming.length)} foto${incoming.length !== 1 ? 's' : ''} encontrada${incoming.length !== 1 ? 's' : ''}`,
            20
        );
    }

    if (!silent && incoming.length > 3) {
        showToast(`Procesando ${incoming.length} foto${incoming.length !== 1 ? 's' : ''}…`, 'info');
    }

    let results;
    try {
        results = await window.electronAPI.inspectImageFiles(incoming.map(f => f.fullPath));
    } catch (err) {
        console.warn('[watcher] Error inspeccionando lote:', err);
        if (options.showImportStatus && isCurrent()) {
            showPhotoImportError('No se pudo leer la carpeta vinculada. Comprueba que siga disponible y vuelve a vincularla.');
        }
        return 0;
    }
    if (!isCurrent()) return 0;
    if (!Array.isArray(results)) {
        if (options.showImportStatus) {
            showPhotoImportError('La carpeta no devolvió resultados válidos. Vuelve a vincularla e inténtalo de nuevo.');
        }
        return 0;
    }

    if (options.showImportStatus) {
        showPhotoImportProgress(
            'Preparando registros',
            `${formatPhotoImportCount(incoming.length)} foto${incoming.length !== 1 ? 's' : ''} inspeccionada${incoming.length !== 1 ? 's' : ''}`,
            75
        );
    }

    state.globalPhotoConfig = state.globalPhotoConfig || readPhotoConfigFromInputs();

    let added = 0;
    let updated = 0;
    let exportInvalidated = false;
    state.photoMeta = state.photoMeta || {};
    const selectedRecord = state.records[state.currentIndex] || null;
    const selectedKey = getRecordKey(selectedRecord);
    for (let i = 0; i < incoming.length; i++) {
        if (!isCurrent()) return added;
        const result = results[i];
        if (!result?.ok) continue;

        const { fullPath, parsed, dniKey, existing } = incoming[i];
        const previousMeta = state.photoMeta[dniKey];
        const previousPath = state.photoPaths[dniKey] || state.photosMap[dniKey] || '';
        if (_sameWatchPath(previousPath, fullPath) &&
                previousMeta?.sourceVersion === result.sourceVersion) {
            continue;
        }

        if (!exportInvalidated) {
            invalidatePreflightReport();
            exportInvalidated = true;
        }
        _invalidateWatcherPhotoCaches(dniKey);
        const oldUrl = state.photosMap[dniKey];
        if (oldUrl && String(oldUrl).startsWith('blob:')) {
            try { URL.revokeObjectURL(oldUrl); } catch (_) {}
            const oldIndex = state.photoObjectUrls.indexOf(oldUrl);
            if (oldIndex >= 0) state.photoObjectUrls.splice(oldIndex, 1);
        }
        state.photosMap[dniKey] = fullPath;
        state.photoPaths[dniKey] = fullPath;
        state.photoMeta[dniKey] = {
            source: fullPath,
            filePath: fullPath,
            width: result.width,
            height: result.height,
            sourceBytes: result.sourceBytes,
            sourceVersion: result.sourceVersion,
        };
        if (existing) {
            existing.hasPhoto = true;
            updated++;
        } else {
            const record = {
                dni: parsed.dni,
                dniKey,
                nombres: parsed.nombres,
                apellidos: parsed.apellidos,
                extra: '',
                hasPhoto: true,
            };
            ensureRecordIdentity(record, dniKey);
            state.records.push(record);
            existingByKey.set(dniKey, record);
            added++;
        }
    }

    if (!added && !updated) {
        if (options.showImportStatus) showPhotoImportReady(state.photosCount, duplicateCount);
        return 0;
    }
    state.photoLoadGeneration++;
    state.photosCount = Object.keys(state.photosMap).filter(key => !!state.photosMap[key]).length;
    state.reniecGeneration++;

    state.records.sort((a, b) =>
        (a.dniKey || '').localeCompare(b.dniKey || '') ||
        (a.dni || '').localeCompare(b.dni || '')
    );
    const selectedIndex = selectedRecord ? state.records.indexOf(selectedRecord) : -1;
    const selectedByKey = selectedIndex >= 0 ? selectedIndex : state.records.findIndex(r => getRecordKey(r) === selectedKey);
    state.currentIndex = selectedByKey >= 0 ? selectedByKey : clamp(state.currentIndex, 0, Math.max(0, state.records.length - 1));

    if (Array.isArray(state.csvRows) && state.csvRows.length > 0) {
        try { mergeCSVData(); } catch (_) {}
    }

    // UI: si la sección Fotos aún no está marcada como completada, márcala.
    const zonePhotos = document.getElementById('zone-photos');
    if (zonePhotos && !zonePhotos.classList.contains('has-file')) {
        zonePhotos.classList.add('has-file');
        document.getElementById('badge-photos')?.classList.add('completed');
        const badge = document.getElementById('badge-photos');
        if (badge) setStepBadgeCompleted('badge-photos');
    }
    const fileNameEl = document.getElementById('photos-file-name');
    if (fileNameEl) setFileStatus('photos-file-name', 'check-circle-2', `${state.photosCount} foto${state.photosCount !== 1 ? 's' : ''} cargadas`);

    showDataPreview();
    document.getElementById('data-preview').style.display = 'block';
    updatePhotoInputsForCurrentRecord();
    updateNavigation();
    updateStatusBar();
    renderFilmstrip();
    tryRender();
    saveSessionDebounced();

    if (!silent) {
        const parts = [];
        if (added) parts.push(`${added} nueva${added !== 1 ? 's' : ''}`);
        if (updated) parts.push(`${updated} actualizada${updated !== 1 ? 's' : ''}`);
        showToast(`Fotos: ${parts.join(', ')}`, 'success');
    }

    // Enriquecimiento RENIEC en background (mismo flow que carga manual)
    try { enrichWithRENIEC(); } catch (_) {}

    if (options.showImportStatus) showPhotoImportReady(state.photosCount, duplicateCount);

    return added + updated;
}
