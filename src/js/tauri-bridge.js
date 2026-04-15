// Tauri bridge — expone window.electronAPI y window.desktopMeta
// compatible con el resto del JS sin modificarlo.
// Solo se activa dentro de Tauri (__TAURI__ existe).
(function () {
    if (!window.__TAURI__) return;

    const invoke = window.__TAURI__.core.invoke;

    window.desktopMeta = { platform: 'win32', isElectron: false, isTauri: true };

    // Callbacks registrados vía onUpdateAvailable
    const _updateCbs = [];
    function _fireUpdate(info) { _updateCbs.forEach(cb => { try { cb(info); } catch (_) {} }); }

    window.electronAPI = {
        // RENIEC (CORS bloqueado en renderer → Rust)
        queryRENIEC: (dni, token) => invoke('reniec_query', { dni, token }),

        // Lee archivo por ruta (sesión anterior)
        readFileAsDataURL: (filePath) => invoke('read_file_as_dataurl', { filePath }),

        // Devuelve el path guardado en el File por el dialog interceptor
        getPathForFile: (file) => file._tauriPath || '',

        // Registra callback para cuando haya actualización
        onUpdateAvailable: (cb) => { _updateCbs.push(cb); },

        // Verifica actualizaciones manualmente — resuelve true si hay update, false si no
        checkForUpdates: () =>
            invoke('check_for_updates')
                .then(info => { if (info) _fireUpdate(info); return !!info; })
                .catch(() => false),
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
        const files = await Promise.all(paths.map(async path => {
            const result = await invoke('read_file_as_dataurl', { filePath: path }).catch(() => null);
            if (!result?.ok) return null;
            const name = path.replace(/\\/g, '/').split('/').pop();
            const file = await dataUrlToFile(result.dataUrl, name);
            file._tauriPath = path; // getPathForFile lo leerá aquí
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

    async function handleTemplateInput(input) {
        const path = await invoke('pick_template_file').catch(() => null);
        if (!path) return;
        const files = await pathsToFiles([path]);
        injectFilesIntoInput(input, files);
    }

    async function handlePhotosFilesInput(input) {
        const paths = await invoke('pick_photo_files').catch(() => []);
        if (!paths.length) return;
        const files = await pathsToFiles(paths);
        injectFilesIntoInput(input, files);
    }

    async function handlePhotosFolderInput(input) {
        const paths = await invoke('pick_photos_from_folder').catch(() => []);
        if (!paths.length) return;
        const files = await pathsToFiles(paths);
        injectFilesIntoInput(input, files);
    }

    async function handleDataInput(input) {
        const path = await invoke('pick_data_file').catch(() => null);
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

    window.addEventListener('DOMContentLoaded', () => {
        Object.entries(INPUT_HANDLERS).forEach(([id, handler]) => {
            const el = document.getElementById(id);
            if (!el) return;
            // Capture phase: intercept BEFORE the browser's native file picker
            el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();
                handler(el);
            }, true);
        });
    });
})();
