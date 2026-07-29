// ===================== LIVE PREVIEW & CONFIG STATE =====================

const _inputHistoryCaptured = new WeakSet();

function captureInputHistoryBaseline(input) {
    if (!input || !state.records.length || state.history.suspend || state.drag.active ||
            _inputHistoryCaptured.has(input)) return;
    pushUndoSnapshot(`input:${input.id}`);
    _inputHistoryCaptured.add(input);
}

function setupLivePreview() {
    setupAccessibilityControls();
    const allInputs = document.querySelectorAll('.section-body input, .section-body select');
    allInputs.forEach(input => {
        input.addEventListener('beforeinput', () => captureInputHistoryBaseline(input));
        input.addEventListener('pointerdown', () => {
            if (input.type === 'checkbox' || input.type === 'range' || input.type === 'color' || input.tagName === 'SELECT') {
                captureInputHistoryBaseline(input);
            }
        });
        input.addEventListener('keydown', () => {
            if (input.type === 'checkbox' || input.tagName === 'SELECT') captureInputHistoryBaseline(input);
        });
        input.addEventListener('input', (e) => handleInputChange(e));
        input.addEventListener('change', (e) => {
            handleInputChange(e);
            _inputHistoryCaptured.delete(input);
        });
        input.addEventListener('blur', () => _inputHistoryCaptured.delete(input));
    });
}

function syncSectionAccessibility(header) {
    const section = document.getElementById(header?.dataset.toggleSection);
    const body = section?.querySelector('.section-body');
    if (!section || !body) return;

    const expanded = !section.classList.contains('collapsed');
    if (!body.id) body.id = `${section.id}-body`;
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-controls', body.id);
    header.setAttribute('aria-expanded', String(expanded));
    body.setAttribute('aria-hidden', String(!expanded));
    if ('inert' in body) body.inert = !expanded;
}

function setupAccessibilityControls() {
    document.querySelectorAll('[data-toggle-section]').forEach(header => {
        if (header.dataset.a11yBound === '1') return;
        header.dataset.a11yBound = '1';
        syncSectionAccessibility(header);
        header.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            header.click();
        });

        const section = document.getElementById(header.dataset.toggleSection);
        if (section && typeof MutationObserver !== 'undefined') {
            new MutationObserver(() => syncSectionAccessibility(header))
                .observe(section, { attributes: true, attributeFilter: ['class'] });
        }
    });

    const syncModeButtons = () => {
        document.querySelectorAll('[data-ui-mode]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.classList.contains('is-active')));
        });
    };
    syncModeButtons();
    if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncModeButtons)
            .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
}

function handleInputChange(e) {
    if (!state.records.length) return;
    invalidatePreflightReport();
    saveSessionDebounced();
    const isPhotoInput = String(e.target.id || '').startsWith('field-photo-');
    const isIndividualCheckbox = e.target.id === 'photo-individual-mode' || e.target.id === 'hud-photo-individual';
    const shouldTrack = !state.history.suspend && !state.drag.active && !_inputHistoryCaptured.has(e.target) &&
        (e.type === 'change' || isIndividualCheckbox);
    if (shouldTrack) {
        pushUndoSnapshot(`input:${e.target.id}`);
    }
    const record = state.records[state.currentIndex];
    const recordKey = getRecordKey(record);

    // If a coordinate/size input changed directly via typing
    if (isPhotoInput && !isIndividualCheckbox) {
        savePhotoConfigFromDOM();
        syncHudPhotoControls(getPhotoConfig());
        updatePhotoSwatches();
    }

    // If they checked or unchecked the box
    if (isIndividualCheckbox) {
        const isIndividual = !!e.target.checked;
        setPhotoIndividualModeControlValue(isIndividual);
        if (isIndividual) {
            if (!state.photoOverrides[recordKey]) {
                if (!state.globalPhotoConfig) {
                    state.globalPhotoConfig = getPhotoConfig();
                }
                state.photoOverrides[recordKey] = { ...state.globalPhotoConfig };
            }
        } else {
            // Reverting to global for this record
            delete state.photoOverrides[recordKey];
        }
        updatePhotoInputsForCurrentRecord(); // Sync DOM
    }

    tryRender();
}

function setPhotoIndividualModeControlValue(enabled) {
    const sidebar = document.getElementById('photo-individual-mode');
    const hud = document.getElementById('hud-photo-individual');
    if (sidebar) sidebar.checked = !!enabled;
    if (hud) hud.checked = !!enabled;
}

function syncHudPhotoControls(config) {
    const normalized = normalizePhotoConfig(config);
    const hudIndividual = document.getElementById('hud-photo-individual');
    const hudBgEnable = document.getElementById('hud-photo-bg-enable');
    const hudBgColor = document.getElementById('hud-photo-bg-color');
    const hudZoom = document.getElementById('hud-photo-zoom');
    const hudZoomValue = document.getElementById('hud-photo-zoom-value');
    const fitCover = document.getElementById('hud-fit-cover');
    const fitContain = document.getElementById('hud-fit-contain');
    const cropBtn = document.getElementById('hud-crop-mode');
    const photoIndividual = document.getElementById('photo-individual-mode');
    const goteroBtn = document.getElementById('hud-gotero-btn');
    const rotationVal = document.getElementById('hud-rotation-value');

    if (hudIndividual && photoIndividual) hudIndividual.checked = !!photoIndividual.checked;
    if (hudBgEnable) hudBgEnable.checked = !!normalized.bgEnabled;
    if (hudBgColor) hudBgColor.value = normalized.bgColor;
    if (hudZoom) hudZoom.value = normalized.scale.toFixed(2);
    if (hudZoomValue) hudZoomValue.textContent = `${normalized.scale.toFixed(2)}x`;
    if (fitCover) fitCover.classList.toggle('is-active', normalized.fit === 'cover');
    if (fitContain) fitContain.classList.toggle('is-active', normalized.fit === 'contain');
    if (cropBtn) cropBtn.classList.toggle('is-active', state.photoCropMode.active);
    if (goteroBtn) goteroBtn.classList.toggle('is-active', state.photoColorPicker.active);
    const rot = normalized.rotation || 0;
    if (rotationVal) rotationVal.textContent = `${rot}°`;
    const hudRotSlider = document.getElementById('hud-photo-rotation');
    if (hudRotSlider) hudRotSlider.value = rot;
    const hud = document.getElementById('editor-hud');
    if (hud) {
        hud.classList.toggle('crop-mode', state.photoCropMode.active);
        hud.classList.toggle('individual-mode', !!(hudIndividual && hudIndividual.checked));
    }
}

function updatePhotoInputsForCurrentRecord() {
    if (!state.records.length) return;
    const record = state.records[state.currentIndex];
    const recordKey = getRecordKey(record);
    const hasOverride = !!state.photoOverrides[recordKey];
    
    setPhotoIndividualModeControlValue(hasOverride);
    
    if (!state.globalPhotoConfig) {
        state.globalPhotoConfig = getPhotoConfig();
    }

    const baseConfig = state.globalPhotoConfig || readPhotoConfigFromInputs();
    const mergedConfig = hasOverride ? { ...baseConfig, ...state.photoOverrides[recordKey] } : baseConfig;
    const config = normalizePhotoConfig(mergedConfig);

    document.getElementById('field-photo-x').value = config.x;
    document.getElementById('field-photo-y').value = config.y;
    document.getElementById('field-photo-w').value = config.w;
    document.getElementById('field-photo-h').value = config.h;
    document.getElementById('field-photo-fit').value = config.fit;
    document.getElementById('field-photo-scale').value = config.scale.toFixed(2);
    document.getElementById('field-photo-offset-x').value = config.offsetX;
    document.getElementById('field-photo-offset-y').value = config.offsetY;
    document.getElementById('field-photo-bg-enable').checked = !!config.bgEnabled;
    document.getElementById('field-photo-bg-color').value = config.bgColor;
    const rotInput = document.getElementById('field-photo-rotation');
    if (rotInput) rotInput.value = config.rotation || 0;

    syncHudPhotoControls(config);

    updatePhotoSwatches();
    updateEditorHud();
}

function savePhotoConfigFromDOM() {
    if (!state.records.length) return;
    const isIndividual = !!document.getElementById('photo-individual-mode')?.checked;
    const record = state.records[state.currentIndex];
    const recordKey = getRecordKey(record);
    const config = normalizePhotoConfig(readPhotoConfigFromInputs());
    if (isIndividual) {
        state.photoOverrides[recordKey] = config;
    } else {
        state.globalPhotoConfig = config;
    }
}

