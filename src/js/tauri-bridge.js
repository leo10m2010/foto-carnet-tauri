// Tauri bridge — expone window.electronAPI y window.desktopMeta
// compatible con el resto del JS sin modificarlo.
// Solo se activa dentro de Tauri (__TAURI__ existe).
(function () {
    if (!window.__TAURI__) {
        window.openFileInputById = (id) => document.getElementById(id)?.click();
        return;
    }

    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke !== 'function') {
        console.error('[Tauri] window.__TAURI__.core.invoke no está disponible; usando selectores web como fallback.');
        window.openFileInputById = (id) => document.getElementById(id)?.click();
        return;
    }

    window.desktopMeta = { platform: 'win32', isElectron: false, isTauri: true };

    // DataTransfer en WebView2 reconstruye File objects al acceder dt.files / input.files,
    // perdiendo propiedades expando como `_tauriPath`. Guardamos un sidecar keyed por
    // name|size para poder recuperar la ruta en handlePhotosUpload (necesario para
    // persistir state.photoPaths y restaurar la sesión).
    const tauriPathByFileKey = new Map();
    const fileKeyOf = (f) => `${f.name}|${f.size}`;

    // Callbacks registrados vía onUpdateAvailable
    const _updateCbs = [];
    function _fireUpdate(info) { _updateCbs.forEach(cb => { try { cb(info); } catch (_) {} }); }

    window.electronAPI = {
        // RENIEC (CORS bloqueado en renderer → Rust)
        queryRENIEC: (dni, token) => invoke('reniec_query', { dni, token }),

        // Lee un archivo por ruta como data URL (caché + validación de mtime)
        readFileAsDataURL: (filePath) => invoke('read_file_as_dataurl', { filePath }),

        // Lee un thumbnail pequeño (maxDim px, default 200) — para previews de sesión
        readAsThumbnail: (filePath, maxDim = 200) =>
            invoke('read_as_thumbnail', { filePath, maxDim }),

        // Lee un lote de archivos en paralelo (rayon en Rust) — mucho más rápido que N llamadas
        readFilesBatch: (filePaths) => invoke('read_files_batch', { filePaths }),

        // Devuelve el path guardado en el File por el dialog interceptor.
        // Preferimos el expando (si sobrevivió), con fallback al sidecar name|size
        // porque DataTransfer clona los File y descarta las propiedades custom.
        getPathForFile: (file) => {
            if (file?._tauriPath) return file._tauriPath;
            if (!file) return '';
            return tauriPathByFileKey.get(fileKeyOf(file)) || '';
        },

        // Registra callback para cuando haya actualización
        onUpdateAvailable: (cb) => { _updateCbs.push(cb); },

        // Verifica actualizaciones manualmente — resuelve true si hay update, false si no
        checkForUpdates: () =>
            invoke('check_for_updates')
                .then(info => { if (info) _fireUpdate(info); return !!info; })
                .catch(() => false),

        // Diálogo nativo "Guardar como" — devuelve la ruta elegida o null si cancela
        pickSavePath: (defaultName, filterName, extension) =>
            invoke('pick_save_path', { defaultName, filterName, extension }),

        // Escribe datos base64 (o data-URI) en un archivo del disco
        saveFile: (path, base64Data) =>
            invoke('save_base64_to_file', { path, base64Data }),

        // Escribe HTML en un archivo temporal y lo abre en el navegador del sistema
        // (reemplaza window.open() para impresión, que Tauri bloquea por defecto)
        openPrintPreview: (html) =>
            invoke('open_print_preview', { html }),

        // Abre un URL externo en el navegador del sistema
        // (window.open está bloqueado en Tauri/WebView2 por defecto)
        openExternal: (url) => invoke('open_external_url', { url }),

        // ── Folder watcher ────────────────────────────────────────────────
        // Diálogo nativo "Seleccionar carpeta" — devuelve la ruta o null
        pickFolder: () => invoke('pick_folder'),
        // Lista todas las imágenes (recursivo) en la carpeta — para el escaneo inicial
        listFolderImages: (path) => invoke('list_folder_images', { path }),
        // Inicia la vigilancia de una carpeta (reemplaza cualquier vigilancia previa)
        watchFolder: (path) => invoke('start_watching_folder', { path }),
        // Detiene la vigilancia activa
        unwatchFolder: () => invoke('stop_watching_folder'),
        // Suscribe un callback al evento 'photo-folder-changed' — cb recibe Array<string>
        // de paths nuevos. Devuelve una función para cancelar la suscripción.
        onWatchedFolderChange: (cb) => {
            const listen = window.__TAURI__?.event?.listen;
            if (typeof listen !== 'function') return () => {};
            let unlistenFn = null;
            listen('photo-folder-changed', (ev) => {
                try { cb(ev?.payload || []); } catch (_) {}
            }).then(fn => { unlistenFn = fn; }).catch(() => {});
            return () => { try { unlistenFn?.(); } catch (_) {} };
        },
    };

    // Auto-verificar 5 s tras carga (igual que Electron)
    window.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => window.electronAPI.checkForUpdates(), 5000);
    });

    // ── File-input interceptor ──────────────────────────────────────────────
    // Reemplaza los <input type="file"> con el dialog nativo de Tauri para
    // obtener rutas reales, permitiendo la restauración de sesión.

    async function dataUrlToFile(dataUrl, name) {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        return new File([blob], name, { type: blob.type });
    }

    async function pathsToFiles(paths) {
        // Improvement 3: single IPC call → Rust reads all files in parallel (rayon).
        let results;
        try {
            results = await invoke('read_files_batch', { filePaths: paths });
        } catch (_) {
            // Fallback: read one by one if batch command fails
            results = await Promise.all(
                paths.map(p => invoke('read_file_as_dataurl', { filePath: p }).catch(() => null))
            );
        }

        const files = await Promise.all(paths.map(async (path, i) => {
            const result = results[i];
            if (!result?.ok) return null;
            const name = path.replace(/\\/g, '/').split('/').pop();
            const file = await dataUrlToFile(result.dataUrl, name);
            file._tauriPath = path;
            tauriPathByFileKey.set(fileKeyOf(file), path);
            return file;
        }));
        return files.filter(Boolean);
    }

    function injectFilesIntoInput(input, files) {
        if (files.length === 0) return;
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function reportPickerError(label, err) {
        console.error(`[Tauri picker] Falló ${label}:`, err);
        if (typeof showToast === 'function') {
            showToast(`No se pudo abrir ${label}. Revisa permisos o prueba de nuevo.`, 'error');
        }
    }

    async function handleTemplateInput(input) {
        const path = await invoke('pick_template_file').catch(err => {
            reportPickerError('el selector de plantilla', err);
            return null;
        });
        if (!path) return;
        const files = await pathsToFiles([path]);
        injectFilesIntoInput(input, files);
    }

    async function handlePhotosFilesInput(input) {
        const paths = await invoke('pick_photo_files').catch(err => {
            reportPickerError('el selector de fotos', err);
            return [];
        });
        if (!paths.length) return;
        if (paths.length > 5 && typeof showToast === 'function')
            showToast(`Cargando ${paths.length} fotos…`, 'info');
        const files = await pathsToFiles(paths);
        injectFilesIntoInput(input, files);
    }

    async function handlePhotosFolderInput(input) {
        const paths = await invoke('pick_photos_from_folder').catch(err => {
            reportPickerError('el selector de carpeta', err);
            return [];
        });
        if (!paths.length) return;
        if (paths.length > 5 && typeof showToast === 'function')
            showToast(`Cargando ${paths.length} fotos…`, 'info');
        const files = await pathsToFiles(paths);
        injectFilesIntoInput(input, files);
    }

    async function handleDataInput(input) {
        const path = await invoke('pick_data_file').catch(err => {
            reportPickerError('el selector de datos', err);
            return null;
        });
        if (!path) return;
        const files = await pathsToFiles([path]);
        injectFilesIntoInput(input, files);
    }

    const INPUT_HANDLERS = {
        'input-template':      handleTemplateInput,
        'input-photos-files':  handlePhotosFilesInput,
        'input-photos-folder': handlePhotosFolderInput,
        'input-data':          handleDataInput,
    };

    window.openFileInputById = async (id) => {
        const input = document.getElementById(id);
        if (!input) return;
        const handler = INPUT_HANDLERS[id];
        if (handler) {
            try {
                await handler(input);
            } catch (err) {
                reportPickerError('el selector de archivos', err);
            }
        } else {
            input.click();
        }
    };

    window.addEventListener('DOMContentLoaded', () => {
        // ── Tauri native drag-drop ────────────────────────────────────────────
        // The browser-level `drop` event gives us File objects without real paths
        // (so session restore can't find the photos later). Tauri emits a separate
        // event with the actual filesystem paths — route those through pathsToFiles
        // so _tauriPath is set and paths persist.
        setupTauriDragDrop();
    });

    async function setupTauriDragDrop() {
        // Prefer the event-system API (stable across Tauri 2 minor versions) over
        // Webview.onDragDropEvent (which has moved between namespaces).
        const listen = window.__TAURI__?.event?.listen;
        if (typeof listen !== 'function') {
            console.warn('[Tauri] __TAURI__.event.listen no disponible; drag-drop nativo desactivado');
            return;
        }

        // Flag so files.js knows Tauri is handling drops (prevents double-processing)
        window.__tauriDragDropHandled = true;

        // Track last hovered zone via drag-over events, since on the drop event some
        // Tauri builds report position = null.
        let lastHoveredZone = null;

        function zoneFromPosition(pos) {
            if (!pos) return null;
            const dpr = window.devicePixelRatio || 1;
            const x = (pos.x ?? 0) / dpr;
            const y = (pos.y ?? 0) / dpr;
            const el = document.elementFromPoint(x, y);
            return el?.closest?.('.upload-zone') || null;
        }

        async function handleDrop(paths, pos) {
            const zone = zoneFromPosition(pos) || lastHoveredZone;
            lastHoveredZone = null;
            if (!zone) {
                console.warn('[Tauri drop] No se encontró drop-zone bajo la posición', pos);
                return;
            }
            const input = zone.querySelector('input[type="file"]');
            if (!input) return;

            let filtered = Array.isArray(paths) ? paths.slice() : [];
            if (input.id === 'input-template' || input.id === 'input-photos-files' || input.id === 'input-photos-folder') {
                filtered = filtered.filter(pp => /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(pp));
            } else if (input.id === 'input-data') {
                filtered = filtered.filter(pp => /\.(csv|xlsx|xls)$/i.test(pp));
            }
            if (!filtered.length) {
                if (typeof showToast === 'function') showToast('Ningún archivo compatible en lo que arrastraste', 'warning');
                return;
            }

            if (filtered.length > 5 && typeof showToast === 'function') {
                showToast(`Cargando ${filtered.length} archivo${filtered.length > 1 ? 's' : ''}…`, 'info');
            }
            const files = await pathsToFiles(filtered);
            injectFilesIntoInput(input, files);
        }

        // Tauri 2 event names (both old and new naming live side-by-side in different builds)
        const DROP_EVENTS = ['tauri://drag-drop', 'tauri://file-drop'];
        const OVER_EVENTS = ['tauri://drag-over', 'tauri://file-drop-hover', 'tauri://drag-enter'];
        const LEAVE_EVENTS = ['tauri://drag-leave', 'tauri://file-drop-cancelled'];

        for (const name of OVER_EVENTS) {
            listen(name, (ev) => {
                const pos = ev?.payload?.position || ev?.payload;
                const zone = zoneFromPosition(pos);
                if (zone) {
                    lastHoveredZone = zone;
                    zone.classList.add('drop-active');
                }
            }).catch(() => {});
        }

        for (const name of LEAVE_EVENTS) {
            listen(name, () => {
                document.querySelectorAll('.upload-zone.drop-active').forEach(z => z.classList.remove('drop-active'));
                lastHoveredZone = null;
            }).catch(() => {});
        }

        for (const name of DROP_EVENTS) {
            listen(name, async (ev) => {
                document.querySelectorAll('.upload-zone.drop-active').forEach(z => z.classList.remove('drop-active'));
                // Payload shape differs by Tauri version:
                //   new: { type:'drop', paths:[], position:{x,y} }
                //   old: { paths:[], position:{x,y} } or just string[]
                const payload = ev?.payload;
                let paths, pos;
                if (Array.isArray(payload)) {
                    paths = payload;
                } else if (payload && typeof payload === 'object') {
                    if (payload.type && payload.type !== 'drop') return; // enter/over/leave on unified API
                    paths = payload.paths;
                    pos   = payload.position;
                }
                if (!Array.isArray(paths) || !paths.length) return;
                await handleDrop(paths, pos);
            }).catch((err) => {
                console.warn(`[Tauri] No se pudo suscribir a ${name}:`, err);
            });
        }

        console.info('[Tauri] drag-drop nativo activado');
    }
})();
