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
        control.addEventListener('click', (event) => {
            const inputId = control.dataset.fileInput;
            if (!inputId) return;
            event.preventDefault();
            event.stopPropagation();
            if (typeof window.openFileInputById === 'function') {
                window.openFileInputById(inputId);
            } else {
                document.getElementById(inputId)?.click();
            }
        });
    });
}

function handleTemplateUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
            state.templateImage = img;
            state.templateFileName = file.name;
            state.templateDataUrl = ev.target.result; // Save for reliable session restore (no path needed)
            state.templatePath = window.electronAPI?.getPathForFile(file) || file.path || null;

            document.getElementById('zone-template').classList.add('has-file');
            document.getElementById('template-file-name').textContent = `✅ ${file.name} (${img.width}×${img.height})`;
            document.getElementById('badge-template').classList.add('completed');
            document.getElementById('badge-template').textContent = '✓';

            document.getElementById('status-template').textContent = `Plantilla: ${file.name}`;
            document.getElementById('status-dimensions').textContent = `${img.width}×${img.height}px`;

            showToast('Plantilla cargada correctamente', 'success');
            saveSessionDebounced();
            tryRender();
        };
        img.src = ev.target.result;
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

function handlePhotosUpload(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    state.globalPhotoConfig = readPhotoConfigFromInputs();

    revokePhotoObjectUrls();
    state.reniecGeneration++;          // Invalidates any in-progress RENIEC query
    state.photosMap = {};
    state.photoPaths = {};
    state.photoImageCache.clear();
    state.photoFaceBoxes = {};
    state.photoOverrides = {};
    state.photosCount = 0;
    state.records = [];
    invalidatePreflightReport();

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
        showToast(`No se encontraron imágenes. ${files.length} archivos en la carpeta. Revisa la consola (F12) para más detalles.`, 'error');
        return;
    }

    const parsedRecords = [];

    imageFiles.forEach(file => {
        // Parse filename for data
        const parsed = parsePhotoFilename(file.name);
        const dniKey = parsed.dniKey || normalizeDNI(parsed.dni);
        const objectUrl = URL.createObjectURL(file);

        // If duplicated DNI appears, keep the latest file and release old URL immediately
        if (state.photosMap[dniKey]) {
            const oldUrl = state.photosMap[dniKey];
            try { URL.revokeObjectURL(oldUrl); } catch (_) {}
            const idx = state.photoObjectUrls.indexOf(oldUrl);
            if (idx !== -1) state.photoObjectUrls.splice(idx, 1);
        }

        state.photosMap[dniKey] = objectUrl;
        state.photoObjectUrls.push(objectUrl);
        // Get filesystem path for session restore (webUtils.getPathForFile is the Electron 32+ API;
        // fall back to deprecated file.path for older builds)
        const filePath = window.electronAPI?.getPathForFile(file) || file.path || '';
        if (filePath) state.photoPaths[dniKey] = filePath;
        state.photosCount++;

        parsedRecords.push({
            dni: parsed.dni,
            dniKey,
            nombres: parsed.nombres,
            apellidos: parsed.apellidos,
            extra: '',    // Will be filled from CSV if available
            hasPhoto: true
        });
    });

    // Sort by DNI for consistent ordering
    parsedRecords.sort((a, b) => (a.dniKey || '').localeCompare(b.dniKey || '') || a.dni.localeCompare(b.dni));
    state.records = parsedRecords;
    state.currentIndex = 0;

    // If CSV data exists, merge it
    if (Array.isArray(state.csvRows) && state.csvRows.length > 0) {
        mergeCSVData();
    }

    document.getElementById('zone-photos').classList.add('has-file');
    document.getElementById('photos-file-name').textContent = `✅ ${imageFiles.length} fotos cargadas (datos extraídos)`;
    document.getElementById('badge-photos').classList.add('completed');
    document.getElementById('badge-photos').textContent = '✓';

    showDataPreview();
    document.getElementById('data-preview').style.display = 'block';
    updatePhotoInputsForCurrentRecord();

    updateNavigation();
    updateStatusBar();
    state.history.undoStack = [];
    state.history.redoStack = [];
    state.history.lastSignature = getSnapshotSignature(createHistorySnapshot());
    updateHistoryButtons();
    showToast(`${imageFiles.length} registros extraídos de las fotos`, 'success');
    saveSessionDebounced();
    tryRender();
    renderFilmstrip();

    // Auto-query RENIEC in background (no UI controls shown)
    enrichWithRENIEC();
}

// ---- RENIEC API enrichment (runs automatically, no UI controls) ----
