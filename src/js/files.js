function setupFileHandlers() {
    document.getElementById('input-template').addEventListener('change', handleTemplateUpload);
    document.getElementById('input-photos-files').addEventListener('change', handlePhotosUpload);
    document.getElementById('input-photos-folder').addEventListener('change', handlePhotosUpload);
    document.getElementById('input-data').addEventListener('change', handleDataUpload);
    setupFilePickerControls();

    // Drag-and-drop for upload zones
    ['zone-template', 'zone-photos', 'zone-data'].forEach(id => {
        const zone = document.getElementById(id);
        if (!zone) return;
        let depth = 0;   // Track nested dragenter/leave on children so the hover state doesn't flicker
        zone.addEventListener('dragenter', e => {
            e.preventDefault();
            depth++;
            zone.classList.add('drop-active');
        });
        zone.addEventListener('dragover', e => {
            e.preventDefault();
            zone.classList.add('drop-active');
        });
        zone.addEventListener('dragleave', () => {
            depth = Math.max(0, depth - 1);
            if (depth === 0) zone.classList.remove('drop-active');
        });
        zone.addEventListener('drop', e => {
            e.preventDefault();
            depth = 0;
            zone.classList.remove('drop-active');
            // In Tauri, the native drag-drop handler in tauri-bridge.js handles
            // files with real paths — skip here to avoid double-processing
            // (and losing paths needed for session restore).
            if (window.__tauriDragDropHandled) return;
            const input = zone.querySelector('input[type="file"]');
            if (e.dataTransfer.files.length > 0) {
                input.files = e.dataTransfer.files;
                input.dispatchEvent(new Event('change'));
            }
        });
    });
}

function setupFilePickerControls() {
    document.querySelectorAll('[data-file-input]').forEach(control => {
        const activate = (event) => {
            const inputId = control.dataset.fileInput;
            if (!inputId) return;
            event.preventDefault();
            event.stopPropagation();
            if (typeof window.openFileInputById === 'function') {
                window.openFileInputById(inputId);
            } else {
                document.getElementById(inputId)?.click();
            }
        };
        control.addEventListener('click', (event) => {
            activate(event);
        });
        if (control.classList.contains('upload-zone')) {
            control.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') activate(event);
            });
        }
    });
}

function handleTemplateUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const loadGeneration = ++state.templateLoadGeneration;
    const lifecycleGeneration = state.lifecycleGeneration;
    const isStale = () => state.templateLoadGeneration !== loadGeneration ||
        state.lifecycleGeneration !== lifecycleGeneration;

    const reader = new FileReader();
    reader.onload = (ev) => {
        if (isStale()) return;
        const img = new Image();
        img.onload = () => {
            if (isStale()) return;
            state.templateImage = img;
            state.templateFileName = file.name;
            state.templateDataUrl = ev.target.result; // Save for reliable session restore (no path needed)
            state.templatePath = window.electronAPI?.getPathForFile(file) || file.path || null;

            document.getElementById('zone-template').classList.add('has-file');
            setFileStatus('template-file-name', 'check-circle-2', `${file.name} (${img.width}×${img.height})`);
            document.getElementById('badge-template').classList.add('completed');
            setStepBadgeCompleted('badge-template');

            document.getElementById('status-template').textContent = `Plantilla: ${file.name}`;
            document.getElementById('status-dimensions').textContent = `${img.width}×${img.height}px`;

            showToast('Plantilla cargada correctamente', 'success');
            saveSessionDebounced();
            tryRender();
        };
        img.onerror = () => {
            if (!isStale()) showToast('La plantilla seleccionada no es una imagen válida', 'error');
        };
        img.src = ev.target.result;
    };
    reader.onerror = () => {
        if (!isStale()) showToast('No se pudo leer la plantilla seleccionada', 'error');
    };
    reader.readAsDataURL(file);
}

// ---- Photos (PRIMARY data source) ----

function parsePhotoFilename(filename) {
    // Strip ALL trailing image extensions (handles doubles like ".jpg.jpg")
    const baseName = filename.replace(/(\.(jpg|jpeg|png|gif|bmp|webp))+$/i, '').trim()
                             .replace(/_/g, ' '); // normalize underscores to spaces

    // Helper: split a "APELLIDOS NOMBRES" text block by Peruvian convention
    // (2 apellidos + 1-2 nombres)
    function splitApellidosNombres(text) {
        const words = text.trim().split(/\s+/);
        if (words.length >= 4) return { apellidos: words.slice(0, 2).join(' '), nombres: words.slice(2).join(' ') };
        if (words.length === 3) return { apellidos: words.slice(0, 2).join(' '), nombres: words[2] };
        if (words.length === 2) return { apellidos: words[0], nombres: words[1] };
        return { apellidos: text.trim(), nombres: '' };
    }

    let match;

    // 1. Standard: "12345678 - APELLIDOS NOMBRES"  (most common)
    match = baseName.match(/^(\d+)\s*[-–]\s*(.+)$/);
    if (match) {
        const dni = match[1].trim();
        return { dni, dniKey: normalizeDNI(dni), ...splitApellidosNombres(match[2]) };
    }

    // 2. Reversed: "APELLIDOS NOMBRES - 12345678"
    match = baseName.match(/^(.+)\s*[-–]\s*(\d+)$/);
    if (match) {
        const dni = match[2].trim();
        return { dni, dniKey: normalizeDNI(dni), ...splitApellidosNombres(match[1]) };
    }

    // 3. DNI as first token, space separator: "12345678 APELLIDOS NOMBRES"
    match = baseName.match(/^(\d{6,12})\s+(.+)$/);
    if (match) {
        const dni = match[1].trim();
        return { dni, dniKey: normalizeDNI(dni), ...splitApellidosNombres(match[2]) };
    }

    // 4. DNI as last token, space separator: "APELLIDOS NOMBRES 12345678"
    match = baseName.match(/^(.+)\s+(\d{6,12})$/);
    if (match) {
        const dni = match[2].trim();
        return { dni, dniKey: normalizeDNI(dni), ...splitApellidosNombres(match[1]) };
    }

    // 5. Only digits — bare DNI with no name
    if (/^\d{6,12}$/.test(baseName)) {
        return { dni: baseName, dniKey: normalizeDNI(baseName), nombres: '', apellidos: '' };
    }

    // 6. Fallback: no DNI found — treat as pure name file, parse nombres/apellidos
    //    The baseName becomes the DNI key so it still appears in the table,
    //    but at least nombres/apellidos are populated correctly.
    return { dni: baseName, dniKey: normalizeDNI(baseName), ...splitApellidosNombres(baseName) };
}

async function decodeImageFileMetadata(file) {
    const url = URL.createObjectURL(file);
    try {
        return await new Promise(resolve => {
            const img = new Image();
            let settled = false;
            const finish = result => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => finish(false), 10000);
            img.onload = () => finish(img.naturalWidth && img.naturalHeight
                ? { width: img.naturalWidth, height: img.naturalHeight }
                : null);
            img.onerror = () => finish(null);
            img.src = url;
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function isDecodableImageFile(file) {
    return !!(await decodeImageFileMetadata(file));
}

function commitPhotoSelection({ photosMap, photoPaths, photoMeta, photoObjectUrls, records }) {
    const previousKey = getRecordKey(getCurrentRecord());
    records.sort((a, b) => (a.dniKey || '').localeCompare(b.dniKey || '') || a.dni.localeCompare(b.dni));
    const globalPhotoConfig = readPhotoConfigFromInputs();

    ++state.photoLoadGeneration;
    ++state.reniecGeneration;
    revokePhotoObjectUrls();
    if (typeof clearPhotoCaches === 'function') clearPhotoCaches();
    else state.photoImageCache.clear();
    state.photosMap = photosMap;
    state.photoPaths = photoPaths;
    state.photoMeta = photoMeta;
    state.photoObjectUrls = photoObjectUrls;
    state.photoFaceBoxes = {};
    state.photoOverrides = {};
    state.photosCount = records.length;
    state.globalPhotoConfig = globalPhotoConfig;
    state.records = records;
    const stableIndex = previousKey ? records.findIndex(record => getRecordKey(record) === previousKey) : -1;
    state.currentIndex = stableIndex >= 0 ? stableIndex : 0;
    state.drag.selectedId = null;
    state.hitboxes = [];
    invalidatePreflightReport();

    if (Array.isArray(state.csvRows) && state.csvRows.length > 0) mergeCSVData();

    document.getElementById('zone-photos').classList.add('has-file');
    setFileStatus('photos-file-name', 'check-circle-2', `${records.length} fotos cargadas (datos extraídos)`);
    document.getElementById('badge-photos').classList.add('completed');
    setStepBadgeCompleted('badge-photos');

    showDataPreview();
    document.getElementById('data-preview').style.display = 'block';
    updatePhotoInputsForCurrentRecord();
    updateNavigation();
    updateStatusBar();
    state.history.undoStack = [];
    state.history.redoStack = [];
    state.history.lastSignature = '';
    updateHistoryButtons();
    showToast(`${records.length} registros extraídos de las fotos`, 'success');
    saveSessionDebounced();
    tryRender();
    renderFilmstrip();
    enrichWithRENIEC();
}

async function handlePhotoPathSelection(paths, options = {}) {
    const imageRe = /\.(jpg|jpeg|png|gif|bmp|webp)$/i;
    const allPaths = Array.isArray(paths) ? paths : [];
    const loadGeneration = ++state.photoImportGeneration;
    const lifecycleGeneration = state.lifecycleGeneration;
    const isStale = () => state.photoImportGeneration !== loadGeneration ||
        state.lifecycleGeneration !== lifecycleGeneration ||
        (typeof options.isCurrent === 'function' && !options.isCurrent());
    const compatiblePaths = allPaths.filter(path => {
        if (typeof path !== 'string' || !imageRe.test(path)) return false;
        const name = path.replace(/\\/g, '/').split('/').pop();
        return !!name && !name.startsWith('.') && name !== 'Thumbs.db' && name !== 'desktop.ini';
    });
    const imagePaths = compatiblePaths.slice(0, 1000);

    if (!imagePaths.length) {
        showPhotoImportError('Selecciona archivos JPG, PNG, GIF, BMP o WebP e inténtalo de nuevo.');
        showToast('No se encontraron imágenes compatibles.', 'error');
        return false;
    }
    if (!window.electronAPI?.inspectImageFiles) {
        showPhotoImportError('La validación nativa no está disponible. Cierra y vuelve a abrir la aplicación antes de reintentar.');
        showToast('No se pudo validar la selección nativa. La sesión actual se conservó.', 'error');
        return false;
    }
    if (compatiblePaths.length > 1000) {
        showToast('Solo se procesarán las primeras 1000 imágenes.', 'warning');
    }

    showPhotoImportProgress(
        'Inspeccionando fotos',
        `${formatPhotoImportCount(imagePaths.length)} foto${imagePaths.length !== 1 ? 's' : ''} seleccionada${imagePaths.length !== 1 ? 's' : ''}`
    );

    let results;
    try {
        results = await window.electronAPI.inspectImageFiles(imagePaths);
    } catch (err) {
        if (!isStale()) {
            console.warn('[Fotos] No se pudo inspeccionar la selección:', err);
            showPhotoImportError('No se pudieron validar las fotos. Comprueba que los archivos sigan disponibles y vuelve a intentarlo.');
            showToast('No se pudieron validar las fotos. La sesión actual se conservó.', 'error');
        }
        return false;
    }
    if (isStale()) return false;

    const invalidCount = imagePaths.reduce((count, _, index) => {
        const result = Array.isArray(results) ? results[index] : null;
        return count + ((!result?.ok || !(result.width > 0) || !(result.height > 0)) ? 1 : 0);
    }, 0);
    if (invalidCount) {
        showPhotoImportError(`${formatPhotoImportCount(invalidCount)} imagen${invalidCount !== 1 ? 'es' : ''} no se pudo${invalidCount !== 1 ? 'ieron' : ''} abrir. Retírala${invalidCount !== 1 ? 's' : ''} de la selección y vuelve a intentarlo.`);
        showToast(`${invalidCount} imagen(es) no se pudieron abrir. La sesión actual se conservó.`, 'error');
        return false;
    }

    showPhotoImportProgress(
        'Preparando registros',
        `${formatPhotoImportCount(imagePaths.length)} foto${imagePaths.length !== 1 ? 's' : ''} validada${imagePaths.length !== 1 ? 's' : ''}`,
        75
    );
    const nextPhotosMap = {};
    const nextPhotoPaths = {};
    const nextPhotoMeta = {};
    const recordsByKey = new Map();
    for (let index = 0; index < imagePaths.length; index++) {
        const path = imagePaths[index];
        const fileName = path.replace(/\\/g, '/').split('/').pop();
        const parsed = parsePhotoFilename(fileName);
        const dniKey = parsed.dniKey || normalizeDNI(parsed.dni);
        const result = results[index];
        nextPhotosMap[dniKey] = path;
        nextPhotoPaths[dniKey] = path;
        nextPhotoMeta[dniKey] = {
            source: path,
            filePath: path,
            width: result.width,
            height: result.height,
            sourceBytes: result.sourceBytes,
            sourceVersion: result.sourceVersion,
        };
        const record = {
            dni: parsed.dni,
            dniKey,
            photoKey: dniKey,
            nombres: parsed.nombres,
            apellidos: parsed.apellidos,
            extra: '',
            hasPhoto: true,
        };
        ensureRecordIdentity(record, dniKey);
        recordsByKey.set(dniKey, record);
    }
    if (isStale()) return false;

    const records = Array.from(recordsByKey.values());
    commitPhotoSelection({
        photosMap: nextPhotosMap,
        photoPaths: nextPhotoPaths,
        photoMeta: nextPhotoMeta,
        photoObjectUrls: [],
        records,
    });
    showPhotoImportReady(records.length, imagePaths.length - records.length);
    return true;
}

async function handlePhotosUpload(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    const loadGeneration = ++state.photoImportGeneration;
    const lifecycleGeneration = state.lifecycleGeneration;
    const isStale = () => state.photoImportGeneration !== loadGeneration ||
        state.lifecycleGeneration !== lifecycleGeneration;

    // Filter images: check extension OR MIME type
    const imageFiles = files.filter(f => {
        // Skip hidden / system files
        if (f.name.startsWith('.') || f.name === 'Thumbs.db' || f.name === 'desktop.ini') return false;
        // Check extension
        if (/\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(f.name)) return true;
        // Fallback: check MIME type
        if (f.type && f.type.startsWith('image/')) return true;
        return false;
    });

    if (imageFiles.length === 0) {
        // Log sample filenames to aid debugging when nothing is detected as an image.
        const sampleNames = files.slice(0, 5).map(f => `"${f.name}" (type: ${f.type || 'N/A'})`);
        console.warn('[Fotos] Sin imágenes detectadas. Muestras:', sampleNames);
        showPhotoImportError('Selecciona archivos JPG, PNG, GIF, BMP o WebP e inténtalo de nuevo.');
        showToast(`No se encontraron imágenes. ${files.length} archivos en la carpeta. Revisa la consola (F12) para más detalles.`, 'error');
        return;
    }

    const validImageFiles = [];
    const metadataByFile = new Map();
    showPhotoImportProgress(
        'Inspeccionando fotos',
        `${formatPhotoImportCount(imageFiles.length)} foto${imageFiles.length !== 1 ? 's' : ''} seleccionada${imageFiles.length !== 1 ? 's' : ''}`
    );
    for (let index = 0; index < imageFiles.length; index++) {
        const file = imageFiles[index];
        let metadata = null;
        try { metadata = await decodeImageFileMetadata(file); } catch (_) {}
        if (isStale()) return;
        if (metadata) {
            validImageFiles.push(file);
            metadataByFile.set(file, metadata);
        }
        const inspected = index + 1;
        showPhotoImportProgress(
            'Inspeccionando fotos',
            `${formatPhotoImportCount(inspected)} de ${formatPhotoImportCount(imageFiles.length)} inspeccionadas`
        );
    }
    if (!validImageFiles.length) {
        showPhotoImportError('Las imágenes no se pudieron abrir. Comprueba su formato y vuelve a seleccionarlas.');
        showToast('Las imágenes seleccionadas no se pudieron abrir. La sesión actual se conservó.', 'error');
        return;
    }
    if (validImageFiles.length !== imageFiles.length) {
        const invalidCount = imageFiles.length - validImageFiles.length;
        showPhotoImportError(`${formatPhotoImportCount(invalidCount)} imagen${invalidCount !== 1 ? 'es' : ''} no se pudo${invalidCount !== 1 ? 'ieron' : ''} abrir. Retírala${invalidCount !== 1 ? 's' : ''} de la selección y vuelve a intentarlo.`);
        showToast(`${imageFiles.length - validImageFiles.length} imagen(es) no se pudieron abrir. La sesión actual se conservó.`, 'error');
        return;
    }

    // Build the complete replacement off-state. Existing photos remain usable if
    // any selected file cannot be prepared.
    const nextPhotosMap = {};
    const nextPhotoPaths = {};
    const nextPhotoMeta = {};
    const nextObjectUrls = [];
    const recordsByKey = new Map();
    showPhotoImportProgress(
        'Preparando registros',
        `${formatPhotoImportCount(validImageFiles.length)} foto${validImageFiles.length !== 1 ? 's' : ''} validada${validImageFiles.length !== 1 ? 's' : ''}`,
        75
    );
    try {
        validImageFiles.forEach(file => {
            const parsed = parsePhotoFilename(file.name);
            const dniKey = parsed.dniKey || normalizeDNI(parsed.dni);
            const objectUrl = URL.createObjectURL(file);

            if (nextPhotosMap[dniKey]) {
                const oldUrl = nextPhotosMap[dniKey];
                URL.revokeObjectURL(oldUrl);
                const oldIndex = nextObjectUrls.indexOf(oldUrl);
                if (oldIndex >= 0) nextObjectUrls.splice(oldIndex, 1);
            }

            nextPhotosMap[dniKey] = objectUrl;
            nextObjectUrls.push(objectUrl);
            const filePath = window.electronAPI?.getPathForFile(file) || file.path || '';
            if (filePath) nextPhotoPaths[dniKey] = filePath;
            const metadata = metadataByFile.get(file);
            nextPhotoMeta[dniKey] = {
                source: objectUrl,
                filePath,
                width: metadata?.width || 0,
                height: metadata?.height || 0,
                sourceBytes: Number.isFinite(file.size) ? file.size : null,
                sourceVersion: Number.isFinite(file.lastModified) ? file.lastModified : null,
            };

            const record = {
                dni: parsed.dni,
                dniKey,
                photoKey: dniKey,
                nombres: parsed.nombres,
                apellidos: parsed.apellidos,
                extra: '',
                hasPhoto: true
            };
            ensureRecordIdentity(record, dniKey);
            recordsByKey.set(dniKey, record);
        });
    } catch (err) {
        nextObjectUrls.forEach(url => {
            try { URL.revokeObjectURL(url); } catch (_) {}
        });
        console.warn('[Fotos] No se pudo preparar la selección:', err);
        showPhotoImportError('No se pudieron preparar las fotos. Comprueba que los archivos sigan disponibles y vuelve a intentarlo.');
        showToast('No se pudieron preparar las fotos seleccionadas. La sesión actual se conservó.', 'error');
        return;
    }

    const parsedRecords = Array.from(recordsByKey.values());
    commitPhotoSelection({
        photosMap: nextPhotosMap,
        photoPaths: nextPhotoPaths,
        photoMeta: nextPhotoMeta,
        photoObjectUrls: nextObjectUrls,
        records: parsedRecords,
    });
    showPhotoImportReady(parsedRecords.length, validImageFiles.length - parsedRecords.length);
}

// Guarded replacement for data.js' loader. This file is loaded after data.js,
// so the global handler used by setupFileHandlers resolves to this version.
function handleDataUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const isCSV = /\.csv$/i.test(file.name);
    const loadGeneration = ++state.dataLoadGeneration;
    const lifecycleGeneration = state.lifecycleGeneration;
    const isStale = () => state.dataLoadGeneration !== loadGeneration ||
        state.lifecycleGeneration !== lifecycleGeneration;

    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            await ensureXLSX();
            if (isStale()) return;
            const workbook = XLSX.read(ev.target.result, isCSV
                ? { type: 'binary', codepage: 65001 }
                : { type: 'array' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
            if (isStale()) return;
            if (!data.length) {
                showToast('El archivo no contiene datos', 'error');
                return;
            }

            const columns = Object.keys(data[0]);
            if (!columns.length) {
                showToast('El archivo no tiene columnas válidas', 'error');
                return;
            }
            const dniCol = autoDetectDNIColumn(columns, data);
            const extraCol = autoDetectExtraColumn(columns);

            state.csvRows = data;
            state.csvFileName = file.name;
            populateCSVMapping(columns, dniCol, extraCol);
            state.csvData = dniCol ? buildCSVIndex(dniCol) : {};
            reportDuplicateCSVKeys(dniCol);
            invalidatePreflightReport();

            document.getElementById('column-mapping').style.display = 'block';
            document.getElementById('zone-data').classList.add('has-file');
            setFileStatus('data-file-name', 'check-circle-2', `${file.name} (${data.length} registros)`);
            setStepBadgeCompleted('badge-data');

            const dniRatio = dniCol ? dniLikeRatio(data, dniCol) : 0;
            if (dniRatio < 0.3) {
                showToast(`Advertencia: la columna "${dniCol}" no parece contener DNIs. Selecciona la columna correcta en el mapeo.`, 'warning');
            }

            if (state.records.length > 0) {
                const matched = mergeCSVData();
                showDataPreview();
                tryRender();
                if (matched === 0) {
                    showToast('Ningún registro coincidió con el CSV. Revisa el mapeo de la columna DNI.', 'warning');
                }
            }

            showToast(`CSV cargado: ${data.length} registros. Se vincularán por DNI.`, 'success');
            saveSessionDebounced();
        } catch (err) {
            if (isStale()) return;
            showToast('Error al leer el archivo: ' + err.message, 'error');
            console.error(err);
        }
    };
    reader.onerror = () => {
        if (!isStale()) showToast('No se pudo leer el archivo de datos', 'error');
    };

    if (isCSV) reader.readAsBinaryString(file);
    else reader.readAsArrayBuffer(file);
}

// ---- RENIEC API enrichment (runs automatically, no UI controls) ----
