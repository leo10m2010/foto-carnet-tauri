// ===================== RENDERING ENGINE =====================

function getFieldConfig(fieldName) {
    const get = (suffix, fallback) => {
        const el = document.getElementById(`field-${fieldName}-${suffix}`);
        return el ? el.value : fallback;
    };
    return {
        x: Math.max(0, toInt(get('x', 0), 0)),
        y: Math.max(0, toInt(get('y', 0), 0)),
        size: Math.max(6, toInt(get('size', 16), 16)),
        color: get('color', '#000000'),
        font: get('font', 'Poppins'),
        align: get('align', 'center'),
        bold: get('bold', ''),
        maxWidth: Math.max(50, toInt(get('maxw', 300), 300))
    };
}

function getPhotoConfig() {
    return getPhotoConfigForRecord(getCurrentRecord() || {});
}

function getPhotoConfigForRecord(record) {
    const key = getRecordKey(record);
    const override = key ? state.photoOverrides[key] : null;
    if (override) return normalizePhotoConfig({ ...override });
    if (state.globalPhotoConfig) return normalizePhotoConfig({ ...state.globalPhotoConfig });
    return normalizePhotoConfig(readPhotoConfigFromInputs());
}

function getBarcodeConfig() {
    const v = (id, fb) => document.getElementById(id)?.value ?? fb;
    return {
        x: Math.max(0, toInt(v('field-barcode-x', 0), 0)),
        y: Math.max(0, toInt(v('field-barcode-y', 0), 0)),
        w: Math.max(40, toInt(v('field-barcode-w', 40), 40)),
        h: Math.max(20, toInt(v('field-barcode-h', 20), 20)),
        format: v('field-barcode-format', 'CODE128'),
        showText: v('field-barcode-showtext', 'false') === 'true'
    };
}

function tryRender() {
    if (!state.templateImage || state.records.length === 0) return;
    renderCarnet(state.currentIndex).then(rendered => {
        if (!rendered) return;
        if (!state.drag.active) drawSelectionOverlay();
        updateEditorHud();
    });
    if (!state.job.active) refreshFilmstripDebounced();
}

function getCurrentRecord() {
    if (!state.records.length) return null;
    return state.records[state.currentIndex] || null;
}

function getCurrentPhotoImage() {
    const record = getCurrentRecord();
    if (!record) return Promise.resolve(null);
    const key = getRecordKey(record);
    return getPhotoImageByKey(key);
}

function _isBrowserPhotoSource(source) {
    return typeof source === 'string' && (source.startsWith('blob:') || source.startsWith('data:'));
}

function _photoCacheKey(key, sourceVersion, variant) {
    return JSON.stringify([String(key), sourceVersion, variant]);
}

function _cacheKeyMatchesPhoto(cacheKey, key) {
    try {
        return JSON.parse(cacheKey)[0] === String(key);
    } catch (_) {
        return false;
    }
}

function _nextPhotoSourceVersion(sourceVersion) {
    return Number.isSafeInteger(sourceVersion)
        ? sourceVersion + 1
        : `${sourceVersion || 'source'}#invalidated`;
}

function _getPhotoMeta(key) {
    if (!state.photoMeta) state.photoMeta = {};
    const source = state.photosMap?.[key] || '';
    const filePath = state.photoPaths?.[key] || '';
    const previous = state.photoMeta[key];
    if (previous && (previous.source !== source || previous.filePath !== filePath)) {
        invalidatePhotoCachesForKey(key);
        return state.photoMeta[key];
    }
    if (!previous) {
        state.photoMeta[key] = { source, filePath, sourceVersion: 1 };
    }
    return state.photoMeta[key];
}

function invalidatePhotoCachesForKey(key) {
    if (!key) return;
    if (!state.photoMeta) state.photoMeta = {};
    const previous = state.photoMeta[key] || {};
    state.photoMeta[key] = {
        ...previous,
        source: state.photosMap?.[key] || '',
        filePath: state.photoPaths?.[key] || '',
        sourceVersion: _nextPhotoSourceVersion(previous.sourceVersion)
    };
    state.photoImageCache?.deleteWhere((_, cacheKey) => _cacheKeyMatchesPhoto(cacheKey, key));
    state.photoThumbnailCache?.deleteWhere((_, cacheKey) => _cacheKeyMatchesPhoto(cacheKey, key));
    [state.photoImageInflight, state.photoThumbnailInflight].forEach(inflight => {
        if (!inflight) return;
        Array.from(inflight.keys()).forEach(cacheKey => {
            if (_cacheKeyMatchesPhoto(cacheKey, key)) inflight.delete(cacheKey);
        });
    });
    if (state.photoFaceBoxes) delete state.photoFaceBoxes[key];
}

function clearPhotoCaches() {
    state.photoImageCache?.clear();
    state.photoThumbnailCache?.clear();
    state.photoImageInflight?.clear();
    state.photoThumbnailInflight?.clear();
    state.photoMeta = {};
    state.photoImageInflight = new Map();
    state.photoThumbnailInflight = new Map();
}

function _createCacheOwnedObjectUrl(dataUrl) {
    if (!dataUrl || typeof URL.createObjectURL !== 'function') {
        return { source: dataUrl, objectUrl: null };
    }
    try {
        const commaIndex = dataUrl.indexOf(',');
        const header = dataUrl.slice(0, commaIndex);
        const payload = dataUrl.slice(commaIndex + 1);
        const mime = header.match(/^data:([^;,]+)/)?.[1] || 'application/octet-stream';
        const decoded = header.includes(';base64') ? atob(payload) : decodeURIComponent(payload);
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        return { source: objectUrl, objectUrl };
    } catch (_) {
        return { source: dataUrl, objectUrl: null };
    }
}

function _estimateDecodedImageBytes(img) {
    const width = img.naturalWidth || img.width || 1;
    const height = img.naturalHeight || img.height || 1;
    return Math.max(4, width * height * 4);
}

function _releasePhotoObjectUrl(img) {
    const objectUrl = img?._cacheObjectUrl;
    if (!objectUrl) return;
    try { URL.revokeObjectURL(objectUrl); } catch (_) {}
    img._cacheObjectUrl = null;
}

async function _createBrowserThumbnailSource(img, maxSize = 200) {
    const sourceW = img.naturalWidth || img.width;
    const sourceH = img.naturalHeight || img.height;
    if (!sourceW || !sourceH || typeof document?.createElement !== 'function' ||
        typeof URL.createObjectURL !== 'function') return null;

    const scale = Math.min(1, maxSize / Math.max(sourceW, sourceH));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceW * scale));
    canvas.height = Math.max(1, Math.round(sourceH * scale));
    const ctx = canvas.getContext?.('2d');
    if (!ctx || typeof canvas.toBlob !== 'function') return null;

    try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
        if (!blob) return null;
        const objectUrl = URL.createObjectURL(blob);
        return { source: objectUrl, objectUrl };
    } catch (_) {
        return null;
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

function _isPhotoRequestStale(key, meta, photoLoadGeneration, lifecycleGeneration) {
    return state.photoLoadGeneration !== photoLoadGeneration ||
        state.lifecycleGeneration !== lifecycleGeneration ||
        state.photoMeta?.[key]?.sourceVersion !== meta.sourceVersion ||
        state.photosMap?.[key] !== meta.source ||
        (state.photoPaths?.[key] || '') !== meta.filePath;
}

async function _resolvePhotoLoadSource(meta, variant) {
    const api = window.electronAPI;
    const sourceIsPath = meta.source && !_isBrowserPhotoSource(meta.source);
    const nativePath = variant === 'thumbnail'
        ? (meta.filePath || (sourceIsPath ? meta.source : ''))
        : (sourceIsPath ? meta.source : '');
    const readNative = variant === 'thumbnail' ? api?.readAsThumbnail : api?.readFileAsDataURL;

    if (nativePath && readNative) {
        try {
            const result = variant === 'thumbnail'
                ? await readNative(nativePath, 200)
                : await readNative(nativePath);
            if (result?.ok && result.dataUrl) return _createCacheOwnedObjectUrl(result.dataUrl);
        } catch (_) {}

        if (!_isBrowserPhotoSource(meta.source)) {
            if (window.__TAURI__) return { source: null, objectUrl: null };
            return {
                source: 'file:///' + nativePath.replace(/\\/g, '/').replace(/^\/+/, ''),
                objectUrl: null
            };
        }
    }

    return { source: meta.source || null, objectUrl: null };
}

function _loadResolvedPhotoImage(key, resolved, isStale) {
    return new Promise(resolve => {
        const img = new Image();
        img._cacheObjectUrl = resolved.objectUrl;
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            console.warn('[Photo] Timeout cargando imagen para key', key);
            disposeCachedPhotoImage(img);
            finish(null);
        }, 10000);
        img.onload = () => {
            if (isStale()) {
                disposeCachedPhotoImage(img);
                finish(null);
                return;
            }
            img.onload = null;
            img.onerror = null;
            finish(img);
        };
        img.onerror = () => {
            disposeCachedPhotoImage(img);
            finish(null);
        };
        img.src = resolved.source;
    });
}

async function _loadPhotoImage(key, meta, variant, cache, cacheKey) {
    const photoLoadGeneration = state.photoLoadGeneration;
    const lifecycleGeneration = state.lifecycleGeneration;
    const resolved = await _resolvePhotoLoadSource(meta, variant);
    const isStale = () => _isPhotoRequestStale(
        key,
        meta,
        photoLoadGeneration,
        lifecycleGeneration
    );
    if (isStale() || !resolved.source) {
        if (resolved.objectUrl) URL.revokeObjectURL(resolved.objectUrl);
        return null;
    }

    let img = await _loadResolvedPhotoImage(key, resolved, isStale);
    if (!img) return null;

    if (variant === 'thumbnail' && _isBrowserPhotoSource(meta.source) && !meta.filePath) {
        const thumbnailSource = await _createBrowserThumbnailSource(img);
        if (isStale()) {
            disposeCachedPhotoImage(img);
            if (thumbnailSource?.objectUrl) URL.revokeObjectURL(thumbnailSource.objectUrl);
            return null;
        }
        if (thumbnailSource) {
            const thumbnailImg = await _loadResolvedPhotoImage(key, thumbnailSource, isStale);
            if (thumbnailImg) {
                disposeCachedPhotoImage(img);
                img = thumbnailImg;
            }
        }
    }

    if (isStale()) {
        disposeCachedPhotoImage(img);
        return null;
    }
    const cached = cache.set(cacheKey, img, _estimateDecodedImageBytes(img));
    if (cached && variant === 'preview') cache.setAlias(String(key), cacheKey);
    if (!cached) _releasePhotoObjectUrl(img);
    return img;
}

function getPhotoImageByKey(key, options = {}) {
    if (!key) return Promise.resolve(null);
    const variant = options.variant === 'thumbnail' ? 'thumbnail' : 'preview';
    const meta = _getPhotoMeta(key);
    if (!meta.source && !meta.filePath) return Promise.resolve(null);
    const cache = variant === 'thumbnail' ? state.photoThumbnailCache : state.photoImageCache;
    const inflight = variant === 'thumbnail'
        ? state.photoThumbnailInflight
        : state.photoImageInflight;
    const cacheKey = _photoCacheKey(key, meta.sourceVersion, variant);
    const cached = cache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);

    const request = _loadPhotoImage(key, meta, variant, cache, cacheKey)
        .finally(() => {
            if (inflight.get(cacheKey) === request) inflight.delete(cacheKey);
        });
    inflight.set(cacheKey, request);
    return request;
}

async function detectPrimaryFace(photoImg, cacheKey = '') {
    if (!photoImg) return null;
    if (cacheKey && Object.prototype.hasOwnProperty.call(state.photoFaceBoxes, cacheKey)) {
        return state.photoFaceBoxes[cacheKey];
    }

    if (typeof FaceDetector === 'undefined') {
        if (cacheKey) state.photoFaceBoxes[cacheKey] = null;
        return null;
    }

    const photoLoadGeneration = state.photoLoadGeneration;
    const cacheResult = value => {
        if (cacheKey && state.photoLoadGeneration === photoLoadGeneration) {
            state.photoFaceBoxes[cacheKey] = value;
        }
        return value;
    };

    try {
        const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
        const faces = await detector.detect(photoImg);
        if (!faces || !faces.length || !faces[0].boundingBox) {
            return cacheResult(null);
        }

        const box = faces[0].boundingBox;
        const normalized = {
            x: toFloat(box.x, 0),
            y: toFloat(box.y, 0),
            width: Math.max(1, toFloat(box.width, 1)),
            height: Math.max(1, toFloat(box.height, 1))
        };
        return cacheResult(normalized);
    } catch (_) {
        return cacheResult(null);
    }
}

function getPhotoDrawRect(photoImg, photoConfig) {
    const px = photoConfig.x;
    const py = photoConfig.y;
    const pw = photoConfig.w;
    const ph = photoConfig.h;

    const sourceW = photoImg.naturalWidth || photoImg.width;
    const sourceH = photoImg.naturalHeight || photoImg.height;
    if (!sourceW || !sourceH) return;

    const scaleX = pw / sourceW;
    const scaleY = ph / sourceH;
    const baseScale = photoConfig.fit === 'contain' ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
    const finalScale = baseScale * photoConfig.scale;

    const drawW = sourceW * finalScale;
    const drawH = sourceH * finalScale;
    const drawX = px + (pw - drawW) / 2 + photoConfig.offsetX;
    const drawY = py + (ph - drawH) / 2 + photoConfig.offsetY;

    return {
        frameX: px,
        frameY: py,
        frameW: pw,
        frameH: ph,
        drawX,
        drawY,
        drawW,
        drawH,
        sourceW,
        sourceH
    };
}

function drawPhotoInFrame(ctx, photoImg, photoConfig) {
    const rect = getPhotoDrawRect(photoImg, photoConfig);
    if (!rect) return;

    const angleDeg = photoConfig.rotation || 0;
    const cx = rect.frameX + rect.frameW / 2;
    const cy = rect.frameY + rect.frameH / 2;

    ctx.save();
    // Clip to frame first so rotation stays inside the frame boundary
    ctx.beginPath();
    ctx.rect(rect.frameX, rect.frameY, rect.frameW, rect.frameH);
    ctx.clip();

    if (angleDeg !== 0) {
        ctx.translate(cx, cy);
        ctx.rotate(angleDeg * Math.PI / 180);
        ctx.translate(-cx, -cy);
    }

    ctx.drawImage(photoImg, rect.drawX, rect.drawY, rect.drawW, rect.drawH);
    ctx.restore();
}

function samplePhotoPixel(photoImg, x, y) {
    const sourceW = photoImg.naturalWidth || photoImg.width;
    const sourceH = photoImg.naturalHeight || photoImg.height;
    if (!sourceW || !sourceH) return null;

    // Sample at reduced resolution — color accuracy is fine at 256px and avoids
    // allocating a full multi-megapixel canvas for a single pixel read.
    const sampleSize = 256;
    const scale = Math.min(1, sampleSize / Math.max(sourceW, sourceH));
    const sw = Math.max(1, Math.round(sourceW * scale));
    const sh = Math.max(1, Math.round(sourceH * scale));

    const off = document.createElement('canvas');
    off.width  = sw;
    off.height = sh;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(photoImg, 0, 0, sw, sh);

    const sx = clamp(Math.floor(x * scale), 0, sw - 1);
    const sy = clamp(Math.floor(y * scale), 0, sh - 1);
    const rgba = octx.getImageData(sx, sy, 1, 1).data;
    return rgbToHex(rgba[0], rgba[1], rgba[2]);
}

// Sample multiple relative points [rx, ry] from a photo in one canvas draw pass.
function samplePhotoColors(photoImg, points) {
    const sourceW = photoImg.naturalWidth || photoImg.width;
    const sourceH = photoImg.naturalHeight || photoImg.height;
    if (!sourceW || !sourceH) return points.map(() => '#d9dee8');

    const sampleSize = 256;
    const scale = Math.min(1, sampleSize / Math.max(sourceW, sourceH));
    const sw = Math.max(1, Math.round(sourceW * scale));
    const sh = Math.max(1, Math.round(sourceH * scale));

    const off = document.createElement('canvas');
    off.width = sw;
    off.height = sh;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(photoImg, 0, 0, sw, sh);

    return points.map(([rx, ry]) => {
        const sx = clamp(Math.floor(sw * rx), 0, sw - 1);
        const sy = clamp(Math.floor(sh * ry), 0, sh - 1);
        const rgba = octx.getImageData(sx, sy, 1, 1).data;
        return normalizeHexColor(rgbToHex(rgba[0], rgba[1], rgba[2]), '#d9dee8');
    });
}

function getPhotoColorFromCanvasPoint(mx, my, photoImg, photoConfig) {
    const rect = getPhotoDrawRect(photoImg, photoConfig);
    if (!rect) return null;

    const insideFrame = mx >= rect.frameX && mx <= rect.frameX + rect.frameW &&
        my >= rect.frameY && my <= rect.frameY + rect.frameH;
    if (!insideFrame) return null;

    const sourceX = ((mx - rect.drawX) / rect.drawW) * rect.sourceW;
    const sourceY = ((my - rect.drawY) / rect.drawH) * rect.sourceH;
    return samplePhotoPixel(photoImg, sourceX, sourceY);
}

function setPhotoBgColor(color) {
    pushUndoSnapshot('photo-bg-color');
    const normalized = normalizeHexColor(color, '#d9dee8');
    const colorInput = document.getElementById('field-photo-bg-color');
    const enabledInput = document.getElementById('field-photo-bg-enable');
    const hudColor = document.getElementById('hud-photo-bg-color');
    const hudEnabled = document.getElementById('hud-photo-bg-enable');

    if (colorInput) colorInput.value = normalized;
    if (hudColor) hudColor.value = normalized;
    if (enabledInput) enabledInput.checked = true;
    if (hudEnabled) hudEnabled.checked = true;

    invalidatePreflightReport();
    savePhotoConfigFromDOM();
    syncHudPhotoControls(getPhotoConfig());
    saveSessionDebounced();
    tryRender();
}

function togglePhotoBgFromHud(enabled) {
    pushUndoSnapshot('photo-bg-toggle');
    const input = document.getElementById('field-photo-bg-enable');
    if (!input) return;
    input.checked = !!enabled;
    invalidatePreflightReport();
    savePhotoConfigFromDOM();
    syncHudPhotoControls(getPhotoConfig());
    saveSessionDebounced();
    tryRender();
}

function stopPhotoColorPickMode() {
    state.photoColorPicker.active = false;
    const canvas = document.getElementById('carnet-canvas');
    if (canvas) canvas.style.cursor = 'default';
    updateEditorHud();
}

function startPhotoColorPick() {
    if (state.drag.selectedId !== 'photo') {
        state.drag.selectedId = 'photo';
        tryRender();
    }
    state.photoColorPicker.active = true;
    const canvas = document.getElementById('carnet-canvas');
    if (canvas) canvas.style.cursor = 'crosshair';
    showToast('Haz clic dentro de la foto para tomar un color', 'info');
    updateEditorHud();
}

async function autoPickPhotoBgColor() {
    const record = getCurrentRecord();
    if (!record) return;
    const recordId = getRecordIdentity(record);
    const lifecycleGeneration = state.lifecycleGeneration;
    const photoImg = await getCurrentPhotoImage();
    if (!isCurrentRecordIdentity(recordId, lifecycleGeneration)) return;
    if (!photoImg) {
        showToast('No se pudo leer la foto actual para muestrear color', 'error');
        return;
    }

    const colors = samplePhotoColors(photoImg, [
        [0.12, 0.10], [0.5, 0.08], [0.88, 0.10],
        [0.18, 0.22], [0.82, 0.22], [0.5, 0.18]
    ]);
    let r = 0, g = 0, b = 0;
    colors.forEach(c => {
        r += Number.parseInt(c.slice(1, 3), 16);
        g += Number.parseInt(c.slice(3, 5), 16);
        b += Number.parseInt(c.slice(5, 7), 16);
    });

    const picked = rgbToHex(r / colors.length, g / colors.length, b / colors.length);
    setPhotoBgColor(picked);
    showToast('Color sugerido aplicado desde la foto', 'success');
}

async function autoFrameCurrentPhoto() {
    if (state.drag.selectedId !== 'photo') {
        state.drag.selectedId = 'photo';
    }

    const record = getCurrentRecord();
    if (!record) return;
    const recordId = getRecordIdentity(record);
    const lifecycleGeneration = state.lifecycleGeneration;
    const key = getRecordKey(record);
    const photoImg = await getPhotoImageByKey(key);
    if (!isCurrentRecordIdentity(recordId, lifecycleGeneration)) return;
    if (!photoImg) {
        showToast('No se pudo abrir la foto para auto-encuadre', 'error');
        return;
    }

    const cfg = getPhotoConfig();
    const sourceW = photoImg.naturalWidth || photoImg.width;
    const sourceH = photoImg.naturalHeight || photoImg.height;
    if (!sourceW || !sourceH) {
        showToast('La foto actual no tiene dimensiones válidas', 'error');
        return;
    }

    const fitInput = document.getElementById('field-photo-fit');
    const scaleInput = document.getElementById('field-photo-scale');
    const offsetXInput = document.getElementById('field-photo-offset-x');
    const offsetYInput = document.getElementById('field-photo-offset-y');
    const bgEnableInput = document.getElementById('field-photo-bg-enable');
    if (!fitInput || !scaleInput || !offsetXInput || !offsetYInput) return;

    const face = await detectPrimaryFace(photoImg, key);
    if (!isCurrentRecordIdentity(recordId, lifecycleGeneration)) return;
    pushUndoSnapshot('photo-auto-frame');
    fitInput.value = 'cover';
    if (face) {
        const baseScale = Math.max(cfg.w / sourceW, cfg.h / sourceH);
        const targetFaceWidth = cfg.w * 0.38;
        const desiredFinalScale = clamp(targetFaceWidth / face.width, baseScale * 0.75, baseScale * 5);
        const scaleValue = clamp(desiredFinalScale / baseScale, 0.2, 5);

        const drawW = sourceW * baseScale * scaleValue;
        const drawH = sourceH * baseScale * scaleValue;
        const baseX = (cfg.w - drawW) / 2;
        const baseY = (cfg.h - drawH) / 2;
        const faceCenterX = (face.x + face.width / 2) * baseScale * scaleValue;
        const faceCenterY = (face.y + face.height / 2) * baseScale * scaleValue;

        const targetCenterX = cfg.w / 2;
        // Target: face center at 42% from top of the photo slot (lower = face more centered)
        const targetCenterY = cfg.h * 0.42;
        const offsetX = Math.round(targetCenterX - (baseX + faceCenterX));
        const offsetY = Math.round(targetCenterY - (baseY + faceCenterY));

        scaleInput.value = scaleValue.toFixed(2);
        offsetXInput.value = offsetX;
        offsetYInput.value = offsetY;
        showToast('Auto-encuadre de rostro aplicado', 'success');
    } else {
        // Fallback if face detector is unavailable or no face was detected.
        const currentScale = toFloat(scaleInput.value, 1);
        scaleInput.value = clamp(Math.max(currentScale, 1.12), 0.2, 5).toFixed(2);
        offsetXInput.value = '0';
        offsetYInput.value = '0';
        showToast('Auto-encuadre aplicado (modo estándar)', 'info');
    }

    if (bgEnableInput && !bgEnableInput.checked) {
        bgEnableInput.checked = true;
        const colors = samplePhotoColors(photoImg, [
            [0.12, 0.10], [0.5, 0.08], [0.88, 0.10],
            [0.18, 0.22], [0.82, 0.22], [0.5, 0.18]
        ]);
        let r = 0, g = 0, b = 0;
        colors.forEach(color => {
            r += Number.parseInt(color.slice(1, 3), 16);
            g += Number.parseInt(color.slice(3, 5), 16);
            b += Number.parseInt(color.slice(5, 7), 16);
        });
        const colorInput = document.getElementById('field-photo-bg-color');
        if (colorInput) colorInput.value = rgbToHex(r / colors.length, g / colors.length, b / colors.length);
    }

    savePhotoConfigFromDOM();
    syncHudPhotoControls(getPhotoConfig());
    invalidatePreflightReport();
    saveSessionDebounced();
    tryRender();
}

async function updatePhotoSwatches() {
    const container = document.getElementById('editor-hud-swatches');
    if (!container) return;
    const record = getCurrentRecord();
    const recordId = record ? getRecordIdentity(record) : '';
    const lifecycleGeneration = state.lifecycleGeneration;
    const swatchGeneration = ++state.swatchGeneration;
    const isStale = () => state.swatchGeneration !== swatchGeneration ||
        !isCurrentRecordIdentity(recordId, lifecycleGeneration);

    container.innerHTML = '';
    const photoImg = await getCurrentPhotoImage();
    if (isStale()) return;
    if (!photoImg) {
        return;
    }

    const points = [
        [0.1, 0.1], [0.5, 0.08], [0.9, 0.1], [0.25, 0.2], [0.75, 0.2], [0.5, 0.3]
    ];
    const colors = samplePhotoColors(photoImg, points);
    const unique = colors.filter((c, i, arr) => arr.indexOf(c) === i);

    container.innerHTML = '';
    unique.slice(0, 6).forEach(color => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'swatch-btn';
        btn.style.background = color;
        btn.title = color;
        btn.addEventListener('click', () => setPhotoBgColor(color));
        container.appendChild(btn);
    });
}

// Draws a text field on ctx, applying truncation and registering a hitbox.
function drawTextField(ctx, text, cfg, id, hitboxes) {
    const fontStr = `${cfg.bold} ${cfg.size}px ${cfg.font}`.trim();
    ctx.font = fontStr;
    ctx.fillStyle = cfg.color;
    ctx.textAlign = cfg.align;
    ctx.textBaseline = 'top';

    let displayText = text;
    let textW = ctx.measureText(displayText).width;
    if (textW > cfg.maxWidth) {
        while (ctx.measureText(displayText + '…').width > cfg.maxWidth && displayText.length > 0) {
            displayText = displayText.slice(0, -1);
        }
        displayText += '…';
        textW = ctx.measureText(displayText).width;
    }
    let hitX = cfg.x;
    if (cfg.align === 'center') hitX = cfg.x - textW / 2;
    else if (cfg.align === 'right') hitX = cfg.x - textW;

    ctx.fillText(displayText, cfg.x, cfg.y);

    if (hitboxes) {
        hitboxes.push({ id, x: hitX, y: cfg.y, w: textW, h: cfg.size });
    }
}

let _photoPrefetchIdleHandle = null;

function _scheduleAdjacentPhotoPrefetch(index) {
    if (typeof window.requestIdleCallback !== 'function') return;
    if (_photoPrefetchIdleHandle !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(_photoPrefetchIdleHandle);
    }
    const lifecycleGeneration = state.lifecycleGeneration;
    _photoPrefetchIdleHandle = window.requestIdleCallback(() => {
        _photoPrefetchIdleHandle = null;
        if (state.lifecycleGeneration !== lifecycleGeneration || state.currentIndex !== index) return;
        [index - 1, index + 1].forEach(adjacentIndex => {
            const record = state.records[adjacentIndex];
            if (!record) return;
            getPhotoImageByKey(getRecordKey(record), { variant: 'preview' }).catch(() => {});
        });
    }, { timeout: 1200 });
}

function renderCarnet(index, targetCanvas, exportScale = 1, options = {}) {
    return new Promise((resolve) => {
        const record = state.records[index];
        if (!record) { resolve(null); return; }

        const template = state.templateImage;
        if (!template) { resolve(null); return; }
        const canvas = targetCanvas || document.getElementById('carnet-canvas');
        if (!canvas) { resolve(null); return; }
        const isPreview = !targetCanvas;
        const previewGeneration = isPreview ? ++state.previewGeneration : 0;
        const lifecycleGeneration = state.lifecycleGeneration;
        const recordId = getRecordIdentity(record);
        const localHitboxes = isPreview ? [] : null;
        const isStale = () => state.lifecycleGeneration !== lifecycleGeneration ||
            (isPreview && state.previewGeneration !== previewGeneration) ||
            state.records[index] !== record || getRecordIdentity(record) !== recordId ||
            state.templateImage !== template;
        const ctx = canvas.getContext('2d');

        const newW = template.width * exportScale;
        const newH = template.height * exportScale;
        if (canvas.width !== newW || canvas.height !== newH) {
            canvas.width  = newW;  // assigning either dimension resets the context
            canvas.height = newH;
        } else {
            ctx.clearRect(0, 0, newW, newH);
        }

        ctx.resetTransform();
        if (exportScale !== 1) {
            ctx.scale(exportScale, exportScale);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
        }

        const photoConfig = getPhotoConfigForRecord(record);
        const photoKey = getRecordKey(record);

        const drawTextsAndBarcode = () => {
            // --- PHOTO hitbox (for drag-and-drop) ---
            if (localHitboxes) {
                localHitboxes.push({
                    id: 'photo',
                    x: photoConfig.x, y: photoConfig.y,
                    w: photoConfig.w, h: photoConfig.h
                });
            }

            drawTextField(ctx, record.nombres  || 'SIN NOMBRE',   getFieldConfig('nombres'),   'nombres',   localHitboxes);
            drawTextField(ctx, record.apellidos || 'SIN APELLIDO', getFieldConfig('apellidos'), 'apellidos', localHitboxes);
            if (record.dni) {
                const prefix = document.getElementById('field-dni-prefix')?.value || '';
                drawTextField(ctx, prefix + record.dni, getFieldConfig('dni'), 'dni', localHitboxes);
            }
            if (record.extra)    drawTextField(ctx, record.extra,    getFieldConfig('extra'),    'extra',    localHitboxes);

            // --- BARCODE ---
            if (record.dni) {
                drawBarcode(ctx, record.dni);
                if (localHitboxes) {
                    const bcfg = getBarcodeConfig();
                    const bcCenteredX = Math.round((ctx.canvas.width / (ctx.getTransform().a || 1) - bcfg.w) / 2);
                    localHitboxes.push({
                        id: 'barcode',
                        x: bcCenteredX, y: bcfg.y,
                        w: bcfg.w, h: bcfg.h
                    });
                }
            }

            if (isStale()) {
                resolve(null);
                return;
            }
            if (localHitboxes) state.hitboxes = localHitboxes;

            // Show canvas
            canvas.style.display = 'block';
            if (document.getElementById('preview-placeholder')) {
                document.getElementById('preview-placeholder').style.display = 'none';
            }

            // Apply zoom
            if (isPreview) {
                canvas.style.transform = `scale(${state.zoom})`;
                canvas.style.transformOrigin = 'center center';
            }

            if (isPreview) {
                updateNavigation();
                _scheduleAdjacentPhotoPrefetch(index);
            }
            resolve(canvas);
        };


        // Photo renders behind the template so transparent areas show through.
        const drawPhotoThenTemplate = (photoImg) => {
            if (isStale()) {
                resolve(null);
                return;
            }
            if (photoConfig.bgEnabled) {
                ctx.save();
                ctx.fillStyle = photoConfig.bgColor;
                ctx.fillRect(photoConfig.x, photoConfig.y, photoConfig.w, photoConfig.h);
                ctx.restore();
            }

            if (photoImg) {
                drawPhotoInFrame(ctx, photoImg, photoConfig);
            } else {
                ctx.save();
                ctx.fillStyle = 'rgba(200, 200, 200, 0.3)';
                ctx.fillRect(photoConfig.x, photoConfig.y, photoConfig.w, photoConfig.h);
                ctx.fillStyle = '#999';
                ctx.font = '14px Poppins, Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Sin foto', photoConfig.x + photoConfig.w / 2, photoConfig.y + photoConfig.h / 2);
                ctx.restore();
            }

            ctx.drawImage(template, 0, 0);
            drawTextsAndBarcode();
        };

        // Export passes its already validated full-resolution image directly.
        const photoRequest = Object.prototype.hasOwnProperty.call(options, 'photoImage')
            ? Promise.resolve(options.photoImage)
            : getPhotoImageByKey(photoKey, { variant: options.photoVariant });
        photoRequest.then(photoImg => {
            drawPhotoThenTemplate(photoImg);
        }).catch(() => {
            // On any unexpected error, render without photo (avoids hanging Promise)
            if (isStale()) resolve(null);
            else drawPhotoThenTemplate(null);
        });
    });
}

function drawBarcode(ctx, dniValue) {
    const cfg = getBarcodeConfig();
    // ctx.canvas.width is the physical pixel size; divide by the context's scale
    // factor to get the logical width (same coordinate space as drawing commands).
    const ctxScaleX = ctx.getTransform().a || 1;
    const logicalWidth = ctx.canvas.width / ctxScaleX;
    const centeredX = Math.round((logicalWidth - cfg.w) / 2);

    try {
        const barcodeCanvas = document.createElement('canvas');
        JsBarcode(barcodeCanvas, dniValue, {
            format: cfg.format,
            width: 2,
            height: cfg.h - (cfg.showText ? 18 : 0),
            displayValue: cfg.showText,
            fontSize: 12,
            margin: 0,
            background: 'transparent',
            lineColor: '#000000'
        });
        ctx.drawImage(barcodeCanvas, centeredX, cfg.y, cfg.w, cfg.h);
    } catch (err) {
        ctx.save();
        ctx.fillStyle = '#cc0000';
        ctx.font = '10px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Error código barras', centeredX + cfg.w / 2, cfg.y + cfg.h / 2);
        ctx.restore();
    }
}

