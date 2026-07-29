// ===================== PRE-CHEQUEO =====================

function invalidatePreflightReport() {
    state.exportRevision = (Number.isSafeInteger(state.exportRevision) ? state.exportRevision : 0) + 1;
    state.preflightReport = null;
    renderPreflightReport(null);
}

function getPhotoUpscaleFactor(photoCfg, sourceW, sourceH, exportScale = 1) {
    if (!Number.isFinite(sourceW) || !Number.isFinite(sourceH) || sourceW <= 0 || sourceH <= 0) return 999;
    const scaleX = photoCfg.w / sourceW;
    const scaleY = photoCfg.h / sourceH;
    const baseScale = photoCfg.fit === 'contain' ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
    return baseScale * photoCfg.scale * exportScale;
}

function renderPreflightReport(report) {
    const box = document.getElementById('preflight-report');
    if (!box) return;

    if (!report) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }

    const preflightItem = (iconName, content) =>
        `<span class="pf-list-row">${iconHtml(iconName, 'pf-list-icon')}<span>${content}</span></span>`;

    const duplicateList = report.duplicates.slice(0, 8)
        .map(d => preflightItem('copy', `DNI ${escapeHtml(d.key)} (${d.count} veces)`))
        .join('');
    const missingList = report.missingPhotos.slice(0, 8)
        .map(d => preflightItem('image-off', `${escapeHtml(d.dni || 'SIN_DNI')} - ${escapeHtml(d.name || 'Registro sin nombre')}`))
        .join('');
    const lowQualityList = report.lowQuality.slice(0, 8)
        .map(d => preflightItem('triangle-alert', `${escapeHtml(d.dni || 'SIN_DNI')} (${d.width}×${d.height}px, x${d.factor.toFixed(2)} de escalado)`))
        .join('');
    const invalidBarcodeList = (report.invalidBarcodes || []).slice(0, 8)
        .map(d => preflightItem('scan-barcode', `${escapeHtml(d.dni || 'SIN_DNI')} - ${escapeHtml(d.message)}`))
        .join('');

    box.innerHTML = `
        <div class="pf-summary ${report.ok ? 'pf-ok' : 'pf-error'}">
            ${report.ok ? 'Listo para exportar' : 'Se detectaron puntos críticos'}
        </div>
        <div class="pf-summary">
            Total: <strong>${report.total}</strong> ·
            Duplicados: <strong class="${report.duplicates.length ? 'pf-warn' : 'pf-ok'}">${report.duplicates.length}</strong> ·
            Sin foto: <strong class="${report.missingPhotos.length ? 'pf-error' : 'pf-ok'}">${report.missingPhotos.length}</strong> ·
            Baja calidad: <strong class="${report.lowQuality.length ? 'pf-warn' : 'pf-ok'}">${report.lowQuality.length}</strong> ·
            Código inválido: <strong class="${(report.invalidBarcodes || []).length ? 'pf-error' : 'pf-ok'}">${(report.invalidBarcodes || []).length}</strong>
        </div>
        ${duplicateList ? `<div class="pf-list"><strong class="pf-warn">DNI duplicados</strong><br>${duplicateList}</div>` : ''}
        ${missingList ? `<div class="pf-list"><strong class="pf-error">Registros sin foto</strong><br>${missingList}</div>` : ''}
        ${lowQualityList ? `<div class="pf-list"><strong class="pf-warn">Fotos con posible pixelado en el DPI actual</strong><br>${lowQualityList}</div>` : ''}
        ${invalidBarcodeList ? `<div class="pf-list"><strong class="pf-error">Valores incompatibles con el formato de código de barras</strong><br>${invalidBarcodeList}</div>` : ''}
    `;
    box.style.display = 'block';
    refreshLucideIcons();
}

async function runPreflightCheck(options = {}) {
    const opts = {
        showToastOnPass: true,
        silent: false,
        validatePhotoLoads: true,
        ...options
    };
    const snapshot = opts.snapshot || null;
    const records = snapshot?.records || state.records;
    const templateImage = snapshot?.templateImage || state.templateImage;
    const photoSources = snapshot?.photoSources || null;
    const photoMeta = snapshot?.photoMeta || state.photoMeta;
    const recordIndices = Array.isArray(opts.recordIndices)
        ? opts.recordIndices.filter(index => Number.isInteger(index) && index >= 0 && index < records.length)
        : records.map((_, index) => index);

    if (!templateImage || recordIndices.length === 0) {
        const emptyReport = {
            ok: false,
            total: 0,
            duplicates: [],
            missingPhotos: [],
            lowQuality: [],
            invalidBarcodes: []
        };
        state.preflightReport = emptyReport;
        renderPreflightReport(emptyReport);
        if (!opts.silent) showToast('No hay datos suficientes para validar', 'warning');
        return emptyReport;
    }

    const { widthCM, heightCM } = getConfiguredCarnetSizeCM();
    const dpi = getExportDPI();
    const targetW = cmToPx(widthCM, dpi);
    const targetH = cmToPx(heightCM, dpi);
    validateCanvasBudget(targetW, targetH, 'La salida del carnet');
    const exportScale = getRenderScaleForTargetPx(targetW, targetH, templateImage);

    const counts = {};
    const duplicates = [];
    const missingPhotos = [];
    const lowQuality = [];
    const invalidBarcodes = [];
    const seenDuplicate = new Set();

    for (let position = 0; position < recordIndices.length; position++) {
        assertExportSnapshot(snapshot, opts.jobId);
        const i = recordIndices[position];
        const record = records[i];
        const key = getRecordKey(record);
        counts[key] = (counts[key] || 0) + 1;
        if (counts[key] > 1 && key && !seenDuplicate.has(key)) {
            seenDuplicate.add(key);
            duplicates.push({ key, count: counts[key] });
        } else if (counts[key] > 1 && key) {
            const idx = duplicates.findIndex(d => d.key === key);
            if (idx >= 0) duplicates[idx].count = counts[key];
        }

        const barcodeError = validateBarcodeValue(record?.dni);
        if (barcodeError) invalidBarcodes.push({ index: i, dni: record?.dni || '', message: barcodeError });

        const src = key
            ? (photoSources ? photoSources[key] : state.photoPaths[key] || state.photosMap[key])
            : null;
        if (!src) {
            missingPhotos.push({
                index: i,
                dni: record?.dni || '',
                name: `${record?.apellidos || ''} ${record?.nombres || ''}`.trim()
            });
            continue;
        }

        const meta = photoMeta?.[key];
        const isBrowserSource = String(src).startsWith('blob:') || String(src).startsWith('data:');
        let sourceW = Number(meta?.width);
        let sourceH = Number(meta?.height);
        if (opts.validatePhotoLoads && (isBrowserSource || !Number.isFinite(sourceW) || !Number.isFinite(sourceH) || sourceW <= 0 || sourceH <= 0)) {
            const img = await getPhotoImageByKey(key);
            assertExportSnapshot(snapshot, opts.jobId);
            if (!img) {
                missingPhotos.push({
                    index: i,
                    dni: record?.dni || '',
                    name: `${record?.apellidos || ''} ${record?.nombres || ''}`.trim()
                });
                continue;
            }
            sourceW = img.naturalWidth || img.width;
            sourceH = img.naturalHeight || img.height;
        }

        const photoCfg = getPhotoConfigForRecord(record);
        const dimensionsKnown = Number.isFinite(sourceW) && Number.isFinite(sourceH) && sourceW > 0 && sourceH > 0;
        const factor = dimensionsKnown ? getPhotoUpscaleFactor(photoCfg, sourceW, sourceH, exportScale) : 0;
        if (factor > 1.12) {
            lowQuality.push({
                index: i,
                dni: record?.dni || '',
                factor,
                width: sourceW,
                height: sourceH
            });
        }

        if (position % 20 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }

    const report = {
        ok: missingPhotos.length === 0 && invalidBarcodes.length === 0,
        total: recordIndices.length,
        duplicates,
        missingPhotos,
        lowQuality,
        invalidBarcodes,
        dpi,
        widthCM,
        heightCM
    };

    assertExportSnapshot(snapshot, opts.jobId);
    state.preflightReport = report;
    renderPreflightReport(report);

    if (!opts.silent) {
        if (!report.ok) {
            showToast(`Pre-chequeo: ${missingPhotos.length} sin foto, ${invalidBarcodes.length} código(s) inválido(s)`, 'error');
        } else if (duplicates.length || lowQuality.length) {
            showToast(`Pre-chequeo listo: ${duplicates.length} duplicados, ${lowQuality.length} con posible pixelado`, 'warning');
        } else if (opts.showToastOnPass) {
            showToast('Pre-chequeo OK: listo para exportar', 'success');
        }
    }

    return report;
}

// ===================== EXPORT PNG =====================

function getConfiguredCarnetSizeCM() {
    const widthCM = readFiniteClampedInput('pdf-width-cm', 5.4, 1, 50);
    const heightCM = readFiniteClampedInput('pdf-height-cm', 8.5, 1, 50);
    return { widthCM, heightCM };
}

function getExportDPI() {
    return Math.round(readFiniteClampedInput('export-dpi', 300, 72, 1200));
}

function cmToPx(cm, dpi) {
    if (!Number.isFinite(cm) || !Number.isFinite(dpi) || cm <= 0 || dpi <= 0) {
        throw new Error('Dimensiones físicas o DPI inválidos');
    }
    return Math.max(1, Math.round((cm / 2.54) * dpi));
}

// Max canvas dimension in pixels (Chrome/Electron limit is ~16 384 px per side,
// but we use 8 000 to stay well within safe memory on lower-end machines).
const MAX_CANVAS_SIDE = 8000;
const MAX_CANVAS_PIXELS = 32 * 1024 * 1024;
const MAX_PRINT_HTML_BYTES = 25 * 1024 * 1024;
const PRINT_HTML_BUDGET_BYTES = MAX_PRINT_HTML_BYTES - 64 * 1024;
const PRINT_JPEG_QUALITY = 0.88;

function utf8ByteLength(value) {
    const text = String(value ?? '');
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length &&
            text.charCodeAt(i + 1) >= 0xDC00 && text.charCodeAt(i + 1) <= 0xDFFF) {
            bytes += 4;
            i++;
        } else bytes += 3;
    }
    return bytes;
}

function createPrintHtmlBudget(prefix, suffix, maxBytes = PRINT_HTML_BUDGET_BYTES) {
    return {
        maxBytes,
        usedBytes: utf8ByteLength(prefix) + utf8ByteLength(suffix),
    };
}

function reservePrintHtmlBytes(budget, html) {
    const nextBytes = utf8ByteLength(html);
    if (budget.usedBytes + nextBytes > budget.maxBytes) return false;
    budget.usedBytes += nextBytes;
    return true;
}

function readFiniteClampedInput(id, fallback, min, max) {
    const parsed = Number.parseFloat(document.getElementById(id)?.value);
    return clamp(Number.isFinite(parsed) ? parsed : fallback, min, max);
}

function validateCanvasBudget(width, height, label = 'El canvas') {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error(`${label} tiene dimensiones inválidas`);
    }
    if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
        throw new Error(`${label} excede el límite de ${MAX_CANVAS_SIDE}px por lado. Reduce tamaño o DPI.`);
    }
    if (width * height > MAX_CANVAS_PIXELS) {
        throw new Error(`${label} excede el presupuesto de ${Math.round(MAX_CANVAS_PIXELS / 1048576)} megapíxeles. Reduce tamaño o DPI.`);
    }
}

function getRenderScaleForTargetPx(targetWidthPx, targetHeightPx, templateImage = state.templateImage) {
    validateCanvasBudget(targetWidthPx, targetHeightPx, 'La salida del carnet');
    if (!templateImage) return 1;
    const tw = Number(templateImage.width);
    const th = Number(templateImage.height);
    if (!Number.isFinite(tw) || !Number.isFinite(th) || tw <= 0 || th <= 0) {
        throw new Error('La plantilla tiene dimensiones inválidas');
    }
    const scaleByW = targetWidthPx  / tw;
    const scaleByH = targetHeightPx / th;
    const idealScale = Math.max(scaleByW, scaleByH);
    // Also clamp so neither canvas dimension exceeds MAX_CANVAS_SIDE
    const maxByW = MAX_CANVAS_SIDE / tw;
    const maxByH = MAX_CANVAS_SIDE / th;
    const maxByPixels = Math.sqrt(MAX_CANVAS_PIXELS / (tw * th));
    const safeMax = Math.min(maxByW, maxByH, maxByPixels, 12);
    if (!Number.isFinite(safeMax) || safeMax <= 0) throw new Error('La plantilla excede los límites de renderizado');
    return Math.min(Math.max(idealScale, 0.01), safeMax);
}

async function renderCarnetAtPhysicalSize(index, widthCM, heightCM, dpi, snapshot = null, jobId = null) {
    const targetW = cmToPx(widthCM, dpi);
    const targetH = cmToPx(heightCM, dpi);
    validateCanvasBudget(targetW, targetH, 'La salida del carnet');
    const renderScale = getRenderScaleForTargetPx(targetW, targetH, snapshot?.templateImage);

    const record = snapshot?.records?.[index] || state.records[index];
    let photoImage;
    if (record?.hasPhoto) {
        assertExportSnapshot(snapshot, jobId);
        const key = getRecordKey(record);
        photoImage = await getPhotoImageByKey(key, { variant: 'preview' });
        assertExportSnapshot(snapshot, jobId);
        if (!photoImage) {
            const label = record.dni || key || `registro ${index + 1}`;
            throw new Error(
                `No se pudo cargar la foto en calidad completa para ${label}. ` +
                'Comprueba que el archivo exista, sea legible y vuelve a exportar.'
            );
        }
    }

    const renderCanvas = document.createElement('canvas');
    const renderOptions = photoImage ? { photoImage } : {};
    const rendered = await renderCarnet(index, renderCanvas, renderScale, renderOptions);
    assertExportSnapshot(snapshot, jobId);
    if (!rendered) {
        const err = new Error('El render quedó obsoleto antes de completarse');
        err.code = JOB_STALE_ERROR;
        throw err;
    }
    validateCanvasBudget(renderCanvas.width, renderCanvas.height, 'El render intermedio');

    // Ensure exact output dimensions in pixels for the requested physical size.
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = targetW;
    finalCanvas.height = targetH;
    const fctx = finalCanvas.getContext('2d');
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = 'high';
    fctx.clearRect(0, 0, targetW, targetH);

    const scale = Math.min(targetW / renderCanvas.width, targetH / renderCanvas.height);
    const drawW = renderCanvas.width * scale;
    const drawH = renderCanvas.height * scale;
    const drawX = (targetW - drawW) / 2;
    const drawY = (targetH - drawH) / 2;
    fctx.drawImage(renderCanvas, drawX, drawY, drawW, drawH);

    // Free the intermediate render canvas; caller keeps only finalCanvas
    renderCanvas.width = 0;
    renderCanvas.height = 0;

    return finalCanvas;
}

function validateBarcodeValue(value) {
    if (!value || typeof JsBarcode !== 'function') return '';
    try {
        const canvas = document.createElement('canvas');
        JsBarcode(canvas, String(value), {
            format: document.getElementById('field-barcode-format')?.value || 'CODE128',
            displayValue: false,
            margin: 0
        });
        canvas.width = 0;
        canvas.height = 0;
        return '';
    } catch (err) {
        return err?.message || 'Valor no admitido por el formato seleccionado';
    }
}

function canvasToBlob(canvas, type = 'image/png', quality = 0.98) {
    return new Promise((resolve, reject) => {
        if (typeof canvas.toBlob === 'function') {
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error('No se pudo generar blob del canvas'));
                    return;
                }
                resolve(blob);
            }, type, quality);
            return;
        }

        try {
            const dataUrl = canvas.toDataURL(type, quality);
            fetch(dataUrl)
                .then(r => r.blob())
                .then(resolve)
                .catch(reject);
        } catch (err) {
            reject(err);
        }
    });
}

function sanitizeFileComponent(value, fallback = 'archivo') {
    const base = String(value || fallback)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (base || fallback).replace(/\s/g, '_').slice(0, 120);
}

async function downloadBlob(blob, filename, assertCurrent = null) {
    // Tauri: use native "Save As" dialog so the user picks the destination folder.
    if (window.electronAPI?.pickSavePath && window.electronAPI?.saveFile) {
        const ext = filename.split('.').pop().toLowerCase() || 'bin';
        const filterLabels = { pdf: 'Documento PDF', zip: 'Archivo ZIP', png: 'Imagen PNG' };
        const filterLabel = filterLabels[ext] || ext.toUpperCase();

        const savePath = await window.electronAPI.pickSavePath(filename, filterLabel, ext);
        if (!savePath) return false; // user cancelled
        if (assertCurrent) assertCurrent();

        // Convert blob → base64 via FileReader
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        if (assertCurrent) assertCurrent();
        await window.electronAPI.saveFile(savePath, base64);
        return savePath; // truthy = saved via native dialog
    }

    // Browser/Electron fallback
    if (assertCurrent) assertCurrent();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return false;
}

const JOB_CANCELLED_ERROR = '__JOB_CANCELLED__';
const JOB_STALE_ERROR = '__JOB_STALE__';
let _jobGeneration = 0;

function createExportSnapshot() {
    const records = state.records.map(record => Object.freeze({ ...record }));
    const photoSources = {};
    const photoMeta = {};
    records.forEach(record => {
        const key = getRecordKey(record);
        if (!key) return;
        photoSources[key] = state.photoPaths[key] || state.photosMap[key] || '';
        const meta = state.photoMeta[key];
        if (meta) photoMeta[key] = Object.freeze({ ...meta });
    });
    return Object.freeze({
        records: Object.freeze(records),
        currentIndex: clamp(state.currentIndex, 0, Math.max(0, records.length - 1)),
        templateImage: state.templateImage,
        photoSources: Object.freeze(photoSources),
        photoMeta: Object.freeze(photoMeta),
        exportRevision: Number.isSafeInteger(state.exportRevision) ? state.exportRevision : 0
    });
}

function completedUnitsProgress(completed, total, start = 0, end = 80) {
    const safeTotal = Math.max(1, Number.isFinite(total) ? total : 1);
    const safeCompleted = clamp(Number.isFinite(completed) ? completed : 0, 0, safeTotal);
    return start + (safeCompleted / safeTotal) * Math.max(0, end - start);
}

function beginJob(label = 'job') {
    const jobId = ++_jobGeneration;
    state.job.active = true;
    state.job.cancelRequested = false;
    state.job.label = label;
    return jobId;
}

function endJob(jobId) {
    if (jobId !== _jobGeneration) return;
    state.job.active = false;
    state.job.cancelRequested = false;
    state.job.label = '';
}

function cancelCurrentJob() {
    if (!state.job.active) return;
    state.job.cancelRequested = true;
    const textEl = document.getElementById('modal-text');
    if (textEl) textEl.textContent = 'Cancelando operación...';
    const cancelBtn = document.getElementById('modal-cancel-btn');
    if (cancelBtn) {
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelando...';
    }
}

function assertJobNotCancelled(jobId = _jobGeneration) {
    if (jobId !== _jobGeneration || !state.job.active) {
        const err = new Error(JOB_STALE_ERROR);
        err.code = JOB_STALE_ERROR;
        throw err;
    }
    if (state.job.cancelRequested) {
        const err = new Error(JOB_CANCELLED_ERROR);
        err.code = JOB_CANCELLED_ERROR;
        throw err;
    }
}

function assertExportSnapshot(snapshot, jobId) {
    if (jobId != null) assertJobNotCancelled(jobId);
    if (!snapshot) return;
    const exportRevision = Number.isSafeInteger(state.exportRevision) ? state.exportRevision : 0;
    if (state.templateImage !== snapshot.templateImage || exportRevision !== snapshot.exportRevision) {
        const err = new Error('Los datos cambiaron durante la operación. Inicia la exportación nuevamente.');
        err.code = JOB_STALE_ERROR;
        throw err;
    }
}

function isJobCancelledError(err) {
    return err && (err.code === JOB_CANCELLED_ERROR || String(err.message || '') === JOB_CANCELLED_ERROR);
}

function isJobStaleError(err) {
    return err?.code === JOB_STALE_ERROR || String(err?.message || '') === JOB_STALE_ERROR;
}

function hasExportableData() {
    return !!state.templateImage && state.records.length > 0;
}

function validateExportReady(label = 'exportar') {
    if (state.job.active) {
        showToast('Ya hay una exportacion en curso. Espera a que termine o cancelala.', 'warning');
        return false;
    }
    if (!state.templateImage || state.records.length === 0) {
        showToast(`Carga una plantilla y fotos antes de ${label}.`, 'warning');
        renderPreflightReport(null);
        updateNavigation();
        return false;
    }
    return true;
}

function setupExportToolbarHandlers() {
    const actions = {
        png: () => exportPNG(),
        zip: () => exportAllZIP(),
        pdf: () => exportPDF(),
        print: () => printAll(),
        preflight: () => runPreflightCheck()
    };

    document.querySelectorAll('[data-export-action]').forEach(button => {
        if (button.dataset.bound === '1') return;
        button.dataset.bound = '1';

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (button.disabled) {
                if (!hasExportableData()) {
                    showToast('Carga una plantilla y fotos antes de exportar.', 'warning');
                }
                return;
            }

            const action = actions[button.dataset.exportAction];
            if (action) action();
        });
    });
}

async function exportPNG() {
    if (!validateExportReady('exportar PNG')) return;
    const { widthCM, heightCM } = getConfiguredCarnetSizeCM();
    const dpi = getExportDPI();
    const snapshot = createExportSnapshot();

    const jobId = beginJob('export-png');
    showModal('Exportando...', `Generando PNG ${widthCM.toFixed(1)}×${heightCM.toFixed(1)} cm @ ${dpi} DPI`, true);

    try {
        const check = await runPreflightCheck({
            silent: true,
            showToastOnPass: false,
            validatePhotoLoads: false,
            recordIndices: [snapshot.currentIndex],
            snapshot,
            jobId
        });
        assertExportSnapshot(snapshot, jobId);
        if (!check.ok) {
            showToast('Pre-chequeo bloqueó la exportación. Revisa fotos y códigos de barras.', 'error');
            return;
        }

        updateModal('Pre-chequeo completado. Renderizando PNG...', 10);
        const offCanvas = await renderCarnetAtPhysicalSize(snapshot.currentIndex, widthCM, heightCM, dpi, snapshot, jobId);
        assertExportSnapshot(snapshot, jobId);
        updateModal('Carnet renderizado. Generando archivo PNG...', 75);
        const record = snapshot.records[snapshot.currentIndex];
        const dniValue = record?.dni || 'carnet';
        const pngBlob = await canvasToBlob(offCanvas, 'image/png');
        offCanvas.width = 0;
        offCanvas.height = 0;
        assertExportSnapshot(snapshot, jobId);

        updateModal('PNG generado. Guardando archivo...', 90);
        const pngFilename = `carnet_${sanitizeFileComponent(dniValue)}_${dpi}dpi.png`;
        const pngSaved = await downloadBlob(pngBlob, pngFilename, () => assertExportSnapshot(snapshot, jobId));
        if (pngSaved === false && window.electronAPI?.pickSavePath) return; // cancelled native dialog
        updateModal('PNG completado', 100);
        showToast(pngSaved ? `PNG guardado: ${String(pngSaved).split(/[\\/]/).pop()}` : 'PNG descargado en alta calidad', 'success');
        recordExport('png');
    } catch (err) {
        if (jobId !== _jobGeneration) return;
        if (isJobCancelledError(err)) {
            showToast('Exportación cancelada por el usuario', 'warning');
        } else if (isJobStaleError(err)) {
            showToast(err.message || 'La exportación quedó obsoleta y fue detenida', 'warning');
        } else {
            showToast(`Error al exportar PNG: ${err.message || err}`, 'error');
            console.error(err);
        }
    } finally {
        if (jobId === _jobGeneration) {
            hideModal();
            endJob(jobId);
        }
    }
}

async function exportAllZIP() {
    if (!validateExportReady('exportar ZIP')) return;
    const { widthCM, heightCM } = getConfiguredCarnetSizeCM();
    const dpi = getExportDPI();
    const snapshot = createExportSnapshot();

    const jobId = beginJob('export-zip');
    showModal('Generando ZIP...', `Renderizando 0 de ${snapshot.records.length} en ${widthCM.toFixed(1)}×${heightCM.toFixed(1)} cm @ ${dpi} DPI`, true);

    try {
        await ensureJSZip();
        assertExportSnapshot(snapshot, jobId);
        const check = await runPreflightCheck({
            silent: true,
            showToastOnPass: false,
            validatePhotoLoads: false,
            snapshot,
            jobId
        });
        assertExportSnapshot(snapshot, jobId);
        if (!check.ok) {
            showToast('Pre-chequeo bloqueó la exportación. Revisa fotos y códigos de barras.', 'error');
            return;
        }

        updateModal('Pre-chequeo completado. Renderizando carnets...', 5);
        const zip = new window.JSZip();
        const folder = zip.folder('carnets');

        for (let i = 0; i < snapshot.records.length; i++) {
            assertExportSnapshot(snapshot, jobId);
            const canvas = await renderCarnetAtPhysicalSize(i, widthCM, heightCM, dpi, snapshot, jobId);
            const record = snapshot.records[i];
            const pngBlob = await canvasToBlob(canvas, 'image/png');
            assertExportSnapshot(snapshot, jobId);
            // Free canvas GPU/CPU memory immediately after converting to blob
            canvas.width = 0;
            canvas.height = 0;

            const nameParts = [record?.dni, record?.apellidos, record?.nombres].filter(Boolean).join(' - ');
            const safeName = sanitizeFileComponent(nameParts || `registro_${i + 1}`, `registro_${i + 1}`);
            folder.file(`${String(i + 1).padStart(4, '0')}_${safeName}.png`, pngBlob);
            updateModal(
                `Renderizados ${i + 1}/${snapshot.records.length}: ${record?.apellidos || ''} ${record?.nombres || ''}`.trim(),
                completedUnitsProgress(i + 1, snapshot.records.length, 5, 80)
            );

            if (i % 3 === 0) {
                await new Promise(r => setTimeout(r, 0)); // Keep UI responsive
            }
        }

        const zipBlob = await zip.generateAsync(
            { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
            (meta) => {
                assertExportSnapshot(snapshot, jobId);
                const zipProgress = 80 + clamp(meta.percent || 0, 0, 100) * 0.1;
                updateModal('Comprimiendo ZIP...', zipProgress);
            }
        );

        assertExportSnapshot(snapshot, jobId);
        updateModal('ZIP generado. Guardando archivo...', 90);
        const fileName = `carnets_${widthCM.toFixed(1)}x${heightCM.toFixed(1)}cm_${dpi}dpi.zip`.replace(/\s/g, '');
        const zipSaved = await downloadBlob(zipBlob, fileName, () => assertExportSnapshot(snapshot, jobId));
        if (zipSaved === false && window.electronAPI?.pickSavePath) return; // cancelled native dialog
        updateModal('ZIP completado', 100);
        showToast(
            zipSaved
                ? `ZIP guardado: ${snapshot.records.length} carnets en ${String(zipSaved).split(/[\\/]/).pop()}`
                : `ZIP generado: ${snapshot.records.length} carnets individuales`,
            'success'
        );
        recordExport('zip');
    } catch (err) {
        if (jobId !== _jobGeneration) return;
        if (isJobCancelledError(err)) {
            showToast('Exportación ZIP cancelada por el usuario', 'warning');
        } else if (isJobStaleError(err)) {
            showToast(err.message || 'La exportación ZIP quedó obsoleta y fue detenida', 'warning');
        } else {
            showToast(`Error al generar ZIP: ${err.message || err}`, 'error');
            console.error(err);
        }
    } finally {
        if (jobId === _jobGeneration) {
            hideModal();
            endJob(jobId);
        }
    }
}

// ===================== EXPORT PDF =====================

function drawPDFCutGuides(pdf, x, y, w, h, markLengthMM = 3) {
    const mark = Math.max(1, Number.parseFloat(markLengthMM) || 3);
    pdf.setDrawColor(120, 120, 120);
    pdf.setLineWidth(0.2);

    // Main cut rectangle
    pdf.rect(x, y, w, h);

    // Top-left
    pdf.line(x - mark, y, x, y);
    pdf.line(x, y - mark, x, y);

    // Top-right
    pdf.line(x + w, y - mark, x + w, y);
    pdf.line(x + w, y, x + w + mark, y);

    // Bottom-left
    pdf.line(x - mark, y + h, x, y + h);
    pdf.line(x, y + h, x, y + h + mark);

    // Bottom-right
    pdf.line(x + w, y + h, x + w + mark, y + h);
    pdf.line(x + w, y + h, x + w, y + h + mark);
}

async function exportPDF() {
    if (!validateExportReady('exportar PDF')) return;
    const snapshot = createExportSnapshot();
    const jobId = beginJob('export-pdf');
    showModal('Generando PDF...', `Procesando carnet 0 de ${snapshot.records.length}`, true);

    try {
        await ensureJsPDF();
        assertExportSnapshot(snapshot, jobId);
        const check = await runPreflightCheck({
            silent: true,
            showToastOnPass: false,
            validatePhotoLoads: false,
            snapshot,
            jobId
        });
        assertExportSnapshot(snapshot, jobId);
        if (!check.ok) {
            showToast('Pre-chequeo bloqueó la exportación. Revisa fotos y códigos de barras.', 'error');
            return;
        }

        updateModal('Pre-chequeo completado. Preparando PDF...', 5);
        const { jsPDF } = window.jspdf;
        const rawOrientation = document.getElementById('pdf-orientation')?.value;
        const orientation = rawOrientation === 'landscape' ? 'landscape' : 'portrait';
        const PAGE_SIZES = ['a2', 'a3', 'a4', 'a5', 'letter', 'legal', 'tabloid'];
        const rawPageSize = String(document.getElementById('pdf-page-size')?.value || 'a4').toLowerCase();
        const pageSize = PAGE_SIZES.includes(rawPageSize) ? rawPageSize : 'a4';
        const marginMM = readFiniteClampedInput('pdf-margin', 10, 0, 50);
        const gapMM = readFiniteClampedInput('pdf-gap', 5, 0, 30);
        const showCutGuides = !!document.getElementById('pdf-cut-guides')?.checked;
        const cutMarkLengthMM = readFiniteClampedInput('pdf-cut-length', 3, 1, 12);
        const exportDPI = getExportDPI();
        const { widthCM, heightCM } = getConfiguredCarnetSizeCM();

        const pdf = new jsPDF({ orientation, unit: 'mm', format: pageSize });

        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const edgeInset = Math.max(marginMM, showCutGuides ? cutMarkLengthMM : 0);
        const usableWidth = pageWidth - 2 * edgeInset;
        const usableHeight = pageHeight - 2 * edgeInset;

        const carnetW = widthCM * 10;
        const carnetH = heightCM * 10;
        const targetCardPxW = cmToPx(carnetW / 10, exportDPI);
        const targetCardPxH = cmToPx(carnetH / 10, exportDPI);
        validateCanvasBudget(targetCardPxW, targetCardPxH, 'Cada carnet del PDF');
        const usePngInPdf = exportDPI >= 450;
        const imageMimeType = usePngInPdf ? 'image/png' : 'image/jpeg';
        const imageFormat = usePngInPdf ? 'PNG' : 'JPEG';

        // Auto calculate how many fit per page
        if (usableWidth <= 0 || usableHeight <= 0 || carnetW > usableWidth || carnetH > usableHeight) {
            throw new Error('El carnet no cabe en la hoja con los márgenes y marcas configurados. Reduce tamaño o márgenes.');
        }
        const cols = Math.floor((usableWidth + gapMM) / (carnetW + gapMM));
        const rows = Math.floor((usableHeight + gapMM) / (carnetH + gapMM));
        const perPage = cols * rows;
        if (!Number.isFinite(perPage) || perPage < 1) throw new Error('La configuración PDF no admite ningún carnet por hoja');

        let slotIdx = 0;
        let isFirstPage = true;

        // Center the grid on the page
        const gridTotalW = cols * carnetW + (cols - 1) * gapMM;
        const gridTotalH = rows * carnetH + (rows - 1) * gapMM;
        const startX = edgeInset + (usableWidth - gridTotalW) / 2;
        const startY = edgeInset + (usableHeight - gridTotalH) / 2;

        for (let i = 0; i < snapshot.records.length; i++) {
            assertExportSnapshot(snapshot, jobId);
            const rec = snapshot.records[i];
            const offCanvas = await renderCarnetAtPhysicalSize(i, widthCM, heightCM, exportDPI, snapshot, jobId);
            if (!usePngInPdf) {
                const pdfImageCtx = offCanvas.getContext('2d');
                pdfImageCtx.save();
                pdfImageCtx.globalCompositeOperation = 'destination-over';
                pdfImageCtx.fillStyle = '#ffffff';
                pdfImageCtx.fillRect(0, 0, offCanvas.width, offCanvas.height);
                pdfImageCtx.restore();
            }

            const imgData = usePngInPdf
                ? offCanvas.toDataURL(imageMimeType)
                : offCanvas.toDataURL(imageMimeType, 0.98);

            // Free canvas memory immediately after extracting image data
            offCanvas.width = 0;
            offCanvas.height = 0;

            const col = slotIdx % cols;
            const row = Math.floor(slotIdx / cols);
            const x = startX + col * (carnetW + gapMM);
            const y = startY + row * (carnetH + gapMM);

            if (slotIdx === 0 && !isFirstPage) pdf.addPage();
            isFirstPage = false;

            pdf.addImage(imgData, imageFormat, x, y, carnetW, carnetH);
            if (showCutGuides) {
                drawPDFCutGuides(pdf, x, y, carnetW, carnetH, cutMarkLengthMM);
            }

            slotIdx++;
            if (slotIdx >= perPage) slotIdx = 0;
            updateModal(
                `Procesados ${i + 1}/${snapshot.records.length}: ${rec?.apellidos || ''} ${rec?.nombres || ''}`.trim(),
                completedUnitsProgress(i + 1, snapshot.records.length, 5, 80)
            );

            await new Promise(r => setTimeout(r, 0)); // Yield to UI thread every record
        }

        assertExportSnapshot(snapshot, jobId);
        const pdfFilename = `carnets_${pageSize.toUpperCase()}_${exportDPI}dpi.pdf`;
        const pdfBlob = new Blob([pdf.output('arraybuffer')], { type: 'application/pdf' });
        updateModal('PDF generado. Guardando archivo...', 90);
        const pdfSaved = await downloadBlob(pdfBlob, pdfFilename, () => assertExportSnapshot(snapshot, jobId));
        if (pdfSaved === false && window.electronAPI?.pickSavePath) return; // cancelled native dialog
        updateModal('PDF completado', 100);
        showToast(
            pdfSaved
                ? `PDF guardado: ${String(pdfSaved).split(/[\\/]/).pop()} (${snapshot.records.length} carnets @ ${exportDPI} DPI)`
                : `PDF ${pageSize.toUpperCase()} generado con ${snapshot.records.length} carnets @ ${exportDPI} DPI`,
            'success'
        );
        recordExport('pdf');
    } catch (err) {
        if (jobId !== _jobGeneration) return;
        if (isJobCancelledError(err)) {
            showToast('Exportación PDF cancelada por el usuario', 'warning');
        } else if (isJobStaleError(err)) {
            showToast(err.message || 'La exportación PDF quedó obsoleta y fue detenida', 'warning');
        } else {
            showToast(`Error al generar PDF: ${err.message || err}`, 'error');
            console.error(err);
        }
    } finally {
        if (jobId === _jobGeneration) {
            hideModal();
            endJob(jobId);
        }
    }
}

// ===================== PRINT =====================

async function printAll() {
    if (!validateExportReady('imprimir')) return;
    const snapshot = createExportSnapshot();
    const jobId = beginJob('print');
    showModal('Preparando impresión...', `Renderizando carnet 0 de ${snapshot.records.length}`, true);

    try {
        const check = await runPreflightCheck({
            silent: true,
            showToastOnPass: false,
            validatePhotoLoads: false,
            snapshot,
            jobId
        });
        assertExportSnapshot(snapshot, jobId);
        if (!check.ok) {
            showToast('Pre-chequeo bloqueó la impresión. Revisa fotos y códigos de barras.', 'error');
            return;
        }

        updateModal('Pre-chequeo completado. Renderizando carnets...', 5);
        const { widthCM, heightCM } = getConfiguredCarnetSizeCM();
        const printDPI = Math.min(getExportDPI(), 300);
        const widthMM = widthCM * 10;
        const heightMM = heightCM * 10;

        const style = `
            body { margin:0; padding:10mm; font-family:Arial; text-align:center; background:#fff; }
            .carnet-wrapper { display:inline-block; margin:3mm; page-break-inside:avoid; }
            .carnet-img { width:${widthMM}mm; height:${heightMM}mm; object-fit:contain; border:1px dotted #ccc; display:block; }
            @media print { body { padding:5mm; } .carnet-img { border:none; } }`;

        const htmlPrefix = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Carnets — Impresión</title><style>${style}</style></head>
<body>`;
        const htmlSuffix = `
<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},300);});<\/script>
</body></html>`;
        const htmlBudget = createPrintHtmlBudget(htmlPrefix, htmlSuffix);

        // Render all carnets and collect as bounded JPEG data URLs. The native
        // command rejects UTF-8 HTML payloads over 25 MiB, including markup.
        const imgTags = [];
        for (let i = 0; i < snapshot.records.length; i++) {
            assertExportSnapshot(snapshot, jobId);
            const offCanvas = await renderCarnetAtPhysicalSize(i, widthCM, heightCM, printDPI, snapshot, jobId);
            assertExportSnapshot(snapshot, jobId);
            const printCtx = offCanvas.getContext('2d');
            printCtx.save();
            printCtx.globalCompositeOperation = 'destination-over';
            printCtx.fillStyle = '#ffffff';
            printCtx.fillRect(0, 0, offCanvas.width, offCanvas.height);
            printCtx.restore();
            const imageDataUrl = offCanvas.toDataURL('image/jpeg', PRINT_JPEG_QUALITY);
            const imageTag = `<div class="carnet-wrapper"><img src="${imageDataUrl}" class="carnet-img"></div>`;
            offCanvas.width = 0; offCanvas.height = 0; // free canvas memory
            assertExportSnapshot(snapshot, jobId);
            if (!reservePrintHtmlBytes(htmlBudget, imageTag + '\n')) {
                throw new Error(
                    `La vista de impresión superaría el límite nativo de 25 MiB al agregar el carnet ${i + 1}. ` +
                    `Divide los registros e imprime menos carnets por vez.`
                );
            }
            imgTags.push(imageTag);
            updateModal(
                `Renderizados ${i + 1} de ${snapshot.records.length} carnets`,
                completedUnitsProgress(i + 1, snapshot.records.length, 5, 80)
            );
            await new Promise(r => setTimeout(r, 0));
        }

        assertExportSnapshot(snapshot, jobId);
        const html = `${htmlPrefix}${imgTags.join('\n')}\n${htmlSuffix.trimStart()}`;
        updateModal('Documento de impresión generado. Abriendo vista previa...', 90);

        if (window.electronAPI?.openPrintPreview) {
            // Tauri: window.open() está bloqueado → abrir en el navegador del sistema
            assertExportSnapshot(snapshot, jobId);
            await window.electronAPI.openPrintPreview(html);
            showToast('Vista de impresión abierta en el navegador del sistema', 'info');
        } else {
            // Electron / browser: usar window.open tradicional
            const printWindow = window.open('', '_blank');
            if (!printWindow) {
                showToast('El navegador bloqueó la ventana. Permite ventanas emergentes e inténtalo otra vez.', 'error');
                return;
            }
            assertExportSnapshot(snapshot, jobId);
            printWindow.document.write(html);
            printWindow.document.close();
            showToast('Diálogo de impresión preparado', 'info');
        }
        updateModal('Vista de impresión completada', 100);
        recordExport('print');
    } catch (err) {
        if (jobId !== _jobGeneration) return;
        if (isJobCancelledError(err)) {
            showToast('Impresión cancelada por el usuario', 'warning');
        } else if (isJobStaleError(err)) {
            showToast(err.message || 'La impresión quedó obsoleta y fue detenida', 'warning');
        } else {
            showToast(`Error al preparar impresión: ${err.message || err}`, 'error');
            console.error(err);
        }
    } finally {
        if (jobId === _jobGeneration) {
            hideModal();
            endJob(jobId);
        }
    }
}
