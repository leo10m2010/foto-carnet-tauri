/* =====================================================
   Generador Masivo de Carnets — App Logic
   ===================================================== */

// ===================== BOUNDED IMAGE CACHE =====================
class ByteBudgetLRUCache {
    constructor({ maxEntries, maxBytes, onEvict } = {}) {
        this._map = new Map();
        this._aliases = new Map();
        this._maxEntries = Math.max(1, maxEntries || 1);
        this._maxBytes = Math.max(1, maxBytes || 1);
        this._onEvict = typeof onEvict === 'function' ? onEvict : null;
        this._bytes = 0;
    }
    get(key) {
        const resolvedKey = this._map.has(key) ? key : this._aliases.get(key);
        if (!this._map.has(resolvedKey)) return undefined;
        const entry = this._map.get(resolvedKey);
        this._map.delete(resolvedKey);
        this._map.set(resolvedKey, entry);
        return entry.value;
    }
    set(key, value, bytes = 0) {
        const size = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
        if (this._map.has(key)) this._remove(key, 'replace', value);
        if (size > this._maxBytes) return false;
        this._map.set(key, { value, bytes: size });
        this._bytes += size;
        while (this._map.size > this._maxEntries || this._bytes > this._maxBytes) {
            this._remove(this._map.keys().next().value, 'evict');
        }
        return this._map.has(key);
    }
    setAlias(alias, key) {
        if (this._map.has(key)) this._aliases.set(alias, key);
    }
    delete(key) {
        const resolvedKey = this._map.has(key) ? key : this._aliases.get(key);
        return this._remove(resolvedKey, 'delete');
    }
    deleteWhere(predicate) {
        Array.from(this._map.entries()).forEach(([key, entry]) => {
            if (predicate(entry.value, key)) this._remove(key, 'delete');
        });
    }
    _remove(key, reason, replacement) {
        if (!this._map.has(key)) return false;
        const entry = this._map.get(key);
        this._map.delete(key);
        this._bytes = Math.max(0, this._bytes - entry.bytes);
        this._aliases.forEach((target, alias) => {
            if (target === key) this._aliases.delete(alias);
        });
        if (this._onEvict && entry.value !== replacement) {
            this._onEvict(entry.value, key, reason);
        }
        return true;
    }
    has(key) {
        return this._map.has(key) || this._map.has(this._aliases.get(key));
    }
    clear({ destructive = false } = {}) {
        const reason = destructive ? 'destroy' : 'clear';
        Array.from(this._map.keys()).forEach(key => this._remove(key, reason));
        this._aliases.clear();
    }
    get size() { return this._map.size; }
    get totalBytes() { return this._bytes; }
    get maxEntries() { return this._maxEntries; }
    get maxBytes() { return this._maxBytes; }
}

function disposeCachedPhotoImage(img, _key, reason) {
    if (!img) return;
    const objectUrl = img._cacheObjectUrl;
    img.onload = null;
    img.onerror = null;
    if (reason === 'destroy') {
        try { img.src = ''; } catch (_) {}
    }
    if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch (_) {}
        img._cacheObjectUrl = null;
    }
}

// ===================== STATE =====================

var state = {
    templateImage: null,      // HTMLImageElement
    templateFileName: '',
    templatePath: null,       // Filesystem path (Electron only, for session restore)
    templateDataUrl: null,    // Base64 dataURL of template (saved in session for reliable restore)
    records: [],              // Array of { dni, nombres, apellidos, extra, hasPhoto }
    photosMap: {},            // { "07971267": objectURL/dataURL/filePath, ... }
    photoPaths: {},           // { "07971267": filePath } — for session restore
    photoObjectUrls: [],      // Temporary object URLs to revoke on reload
    photoMeta: {},             // { [key]: { source, filePath, sourceVersion } }
    photoImageCache: new ByteBudgetLRUCache({
        maxEntries: 20,
        maxBytes: 96 * 1024 * 1024,
        onEvict: disposeCachedPhotoImage
    }),
    photoThumbnailCache: new ByteBudgetLRUCache({
        maxEntries: 160,
        maxBytes: 20 * 1024 * 1024,
        onEvict: disposeCachedPhotoImage
    }),
    photoImageInflight: new Map(),
    photoThumbnailInflight: new Map(),
    photosCount: 0,
    csvData: null,            // Optional CSV data keyed by DNI
    csvRows: [],              // Raw CSV rows for remapping
    csvFileName: '',          // Saved in session for UI restore (mirrors templateFileName)
    watchedFolderPath: null,  // Carpeta vigilada para auto-importar fotos nuevas (Tauri)
    photoOverrides: {},       // { [dni]: { x, y, w, h } }
    globalPhotoConfig: null,  // Default photo position/size for all records
    defaultFieldValues: {},   // Snapshot of original field values (for quick reset)
    currentIndex: 0,
    zoom: 1,
    renderTimer: null,        // Debounce timer for hover renders
    // Drag-and-drop state
    drag: {
        active: false,
        elementId: null,
        selectedId: null,      // Persistent selection
        resizeHandle: null,    // nw, ne, sw, se
        photoPanActive: false,
        startMouseX: 0,
        startMouseY: 0,
        startElemX: 0,
        startElemY: 0,
        startElemW: 0,
        startElemH: 0,
        startPhotoOffsetX: 0,
        startPhotoOffsetY: 0,
        startInputX: 0,
        startInputY: 0,
        snapGuides: null,
        hoveredId: null,
        historyCaptured: false
    },
    inlineEditor: {
        active: false,
        fieldId: null
    },
    photoColorPicker: {
        active: false
    },
    photoCropMode: {
        active: false
    },
    hitboxes: [],
    lifecycleGeneration: 0,   // Invalidates asynchronous work when the session changes
    previewGeneration: 0,     // Only the latest preview render may paint/commit hitboxes
    templateLoadGeneration: 0,
    dataLoadGeneration: 0,
    photoImportGeneration: 0,
    photoLoadGeneration: 0,
    swatchGeneration: 0,
    uiMode: 'simple',
    preflightReport: null,
    exportRevision: 0,
    photoFaceBoxes: {},
    history: {
        undoStack: [],
        redoStack: [],
        maxSize: 40,
        // Approximate total-size cap for each stack (bytes of JSON).
        // With large record sets a single snapshot can be hundreds of KB, so
        // cap by weight in addition to count to avoid unbounded growth.
        maxBytes: 50 * 1024 * 1024,
        suspend: false,
        lastSignature: '',
        zoomSessionUntil: 0,
        panSessionUntil: 0,
        rotationSessionUntil: 0,
        nudgeSessionUntil: 0
    },
    job: {
        active: false,
        cancelRequested: false,
        label: ''
    },
    reniecGeneration: 0,   // Incremented on every photo reload; aborts stale RENIEC queries
    filmstripVisible: true
};
