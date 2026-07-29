const RENIEC_TOKEN_KEY = 'reniec-token';
const RENIEC_TOKEN_PERSISTENCE_KEY = 'fotocarnet_reniec_token_persist';
let _reniecRunGeneration = 0;
let _reniecTestGeneration = 0;
let _reniecRetryTimer = null;
let _reniecPersistTimer = null;
let _reniecTokenMemory = '';
let _reniecPersistenceEnabled = false;
let _reniecCredentialQueue = Promise.resolve();

function queueReniecCredentialOperation(operation) {
    const result = _reniecCredentialQueue.then(operation, operation);
    _reniecCredentialQueue = result.catch(() => {});
    return result;
}

function setReniecPersistencePreference(enabled) {
    try {
        localStorage.setItem(RENIEC_TOKEN_PERSISTENCE_KEY, String(enabled));
    } catch (_) {}
}

function persistReniecTokenDebounced(token) {
    clearTimeout(_reniecPersistTimer);
    _reniecPersistTimer = setTimeout(async () => {
        _reniecPersistTimer = null;
        if (!_reniecPersistenceEnabled) return;
        try {
            await reniecTokenStore.set(token);
        } catch (err) {
            console.warn('[RENIEC] No se pudo guardar el token:', err);
            showToast('No se pudo guardar el token RENIEC de forma segura', 'error');
        }
    }, 300);
}

function createReniecError(code, message, options = {}) {
    const err = new Error(message);
    err.code = code;
    err.status = options.status || 0;
    err.retryable = !!options.retryable;
    return err;
}

function classifyReniecError(value, status = 0) {
    const message = String(value?.message || value || 'No se pudo consultar RENIEC');
    const normalized = message.toLowerCase();
    if (status === 404 || /no encontrado/.test(normalized)) return createReniecError('not_found', 'DNI no encontrado', { status: 404 });
    if (status === 401 || status === 403 || /token|sin permisos|unauthorized|forbidden/.test(normalized)) {
        return createReniecError('auth', 'Token RENIEC inválido o sin permisos', { status });
    }
    if (status === 429 || /límite|limite|rate/.test(normalized)) {
        return createReniecError('rate_limit', 'Límite de consultas superado; espera unos segundos', { status: 429, retryable: true });
    }
    if (status >= 500) return createReniecError('server', `Error del servidor RENIEC (${status})`, { status, retryable: true });
    if (/fetch|network|conex|timeout|timed out|dns|offline|sending request|tcp|tls/.test(normalized)) {
        return createReniecError('network', 'No se pudo conectar con RENIEC', { retryable: true });
    }
    return createReniecError('response', message, { status, retryable: status >= 500 });
}

async function queryReniecRecord(dni, token) {
    if (window.electronAPI?.queryRENIEC) {
        let result;
        try {
            result = await window.electronAPI.queryRENIEC(dni, token);
        } catch (err) {
            throw classifyReniecError(err);
        }
        if (!result?.ok) throw classifyReniecError(result?.error || 'Falló la consulta');
        return result.body || {};
    }

    let response;
    try {
        response = await fetch(`https://dniruc.apisperu.com/api/v1/dni/${encodeURIComponent(dni)}?token=${encodeURIComponent(token)}`);
    } catch (err) {
        throw classifyReniecError(err);
    }
    if (!response.ok) throw classifyReniecError(`HTTP ${response.status}`, response.status);
    try {
        return await response.json();
    } catch (_) {
        throw createReniecError('response', 'RENIEC devolvió una respuesta inválida');
    }
}

function scheduleReniecEnrichment() {
    clearTimeout(_reniecRetryTimer);
    if (!getReniecToken()) return;
    _reniecRetryTimer = setTimeout(() => {
        _reniecRetryTimer = null;
        enrichWithRENIEC().catch(err => console.warn('[RENIEC] No se pudo reintentar:', err));
    }, 500);
}

const reniecTokenStore = {
    get() {
        return _reniecTokenMemory;
    },
    async load() {
        if (!_reniecPersistenceEnabled || !window.__TAURI__) return '';
        if (!window.electronAPI?.getReniecToken) {
            throw new Error('El almacenamiento seguro no está disponible');
        }
        const token = await queueReniecCredentialOperation(() => window.electronAPI.getReniecToken());
        _reniecTokenMemory = typeof token === 'string' ? token : '';
        return _reniecTokenMemory;
    },
    async set(token) {
        _reniecTokenMemory = token?.trim() || '';
        if (!_reniecPersistenceEnabled || !window.__TAURI__) return;
        if (!_reniecTokenMemory) return this.clear();
        if (!window.electronAPI?.setReniecToken) {
            throw new Error('El almacenamiento seguro no está disponible');
        }
        const value = _reniecTokenMemory;
        return queueReniecCredentialOperation(() => window.electronAPI.setReniecToken(value));
    },
    async clear() {
        _reniecTokenMemory = '';
        if (!window.__TAURI__) return;
        if (!window.electronAPI?.clearReniecToken) {
            throw new Error('El almacenamiento seguro no está disponible');
        }
        return queueReniecCredentialOperation(() => window.electronAPI.clearReniecToken());
    }
};

async function initializeReniecTokenPersistence() {
    // Remove credentials left by older builds; token plaintext is never read back.
    try { localStorage.removeItem(RENIEC_TOKEN_KEY); } catch (_) {}
    try {
        _reniecPersistenceEnabled = localStorage.getItem(RENIEC_TOKEN_PERSISTENCE_KEY) === 'true';
    } catch (_) {
        _reniecPersistenceEnabled = false;
    }

    const persistInput = document.getElementById('reniec-token-persist');
    if (!window.__TAURI__) {
        _reniecPersistenceEnabled = false;
        setReniecPersistencePreference(false);
        if (persistInput) {
            persistInput.checked = false;
            persistInput.disabled = true;
            persistInput.title = 'En el navegador, el token solo se mantiene en memoria.';
        }
    } else if (persistInput) {
        persistInput.checked = _reniecPersistenceEnabled;
    }

    try {
        if (_reniecPersistenceEnabled) await reniecTokenStore.load();
        else await reniecTokenStore.clear();
    } catch (err) {
        _reniecTokenMemory = '';
        console.warn('[RENIEC] No se pudo inicializar el almacenamiento seguro:', err);
        showToast('No se pudo leer el token RENIEC guardado', 'error');
    }

    const tokenInput = document.getElementById('field-reniec-token');
    if (tokenInput) tokenInput.value = _reniecTokenMemory;
}

function getReniecToken() {
    return reniecTokenStore.get() ||
        document.getElementById('field-reniec-token')?.value?.trim() || '';
}

function setupReniecControls() {
    const tokenInput = document.getElementById('field-reniec-token');
    const persistInput = document.getElementById('reniec-token-persist');

    if (tokenInput && tokenInput.dataset.bound !== '1') {
        tokenInput.dataset.bound = '1';
        tokenInput.addEventListener('input', () => {
            const token = tokenInput.value.trim();
            _reniecTokenMemory = token;
            if (_reniecPersistenceEnabled) persistReniecTokenDebounced(token);
            _reniecRunGeneration++;
            updateReniecTokenStatus();
            scheduleReniecEnrichment();
        });
    }

    if (persistInput && persistInput.dataset.bound !== '1') {
        persistInput.dataset.bound = '1';
        persistInput.addEventListener('change', async () => {
            clearTimeout(_reniecPersistTimer);
            _reniecPersistTimer = null;
            const token = tokenInput?.value?.trim() || '';
            if (persistInput.checked) {
                _reniecPersistenceEnabled = true;
                try {
                    await reniecTokenStore.set(token);
                    setReniecPersistencePreference(true);
                    showToast('Token RENIEC guardado en el almacén seguro de Windows', 'info');
                } catch (err) {
                    _reniecPersistenceEnabled = false;
                    persistInput.checked = false;
                    setReniecPersistencePreference(false);
                    console.warn('[RENIEC] No se pudo guardar el token:', err);
                    showToast('No se pudo guardar el token RENIEC de forma segura', 'error');
                }
            } else {
                _reniecTokenMemory = token;
                try {
                    await reniecTokenStore.clear();
                    _reniecTokenMemory = token;
                    _reniecPersistenceEnabled = false;
                    setReniecPersistencePreference(false);
                    showToast('Token RENIEC eliminado del almacén seguro', 'info');
                } catch (err) {
                    _reniecTokenMemory = token;
                    _reniecPersistenceEnabled = true;
                    persistInput.checked = true;
                    setReniecPersistencePreference(true);
                    console.warn('[RENIEC] No se pudo eliminar el token guardado:', err);
                    showToast('No se pudo eliminar el token RENIEC guardado', 'error');
                }
            }
            _reniecRunGeneration++;
            updateReniecTokenStatus();
            scheduleReniecEnrichment();
        });
    }

    document.querySelectorAll('[data-reniec-action]').forEach(btn => {
        if (btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (btn.dataset.reniecAction === 'toggle-token') toggleReniecTokenVisibility();
            if (btn.dataset.reniecAction === 'test-token') testReniecToken();
            if (btn.dataset.reniecAction === 'clear-token') clearReniecToken();
        });
    });
}

function updateReniecTokenStatus() {
    const token = getReniecToken();
    const statusEl = document.getElementById('reniec-token-status');
    const badgeEl  = document.getElementById('badge-reniec');
    if (statusEl) {
        statusEl.innerHTML = token ? iconTextHtml('check', 'Configurado', 'section-status-icon') : '';
    }
    if (badgeEl) {
        badgeEl.style.borderColor = token ? '#34d399' : '';
        badgeEl.style.color       = token ? '#34d399' : '';
    }
}

function toggleReniecTokenVisibility() {
    const input = document.getElementById('field-reniec-token');
    if (!input) return;
    const hide = input.type === 'text';
    input.type = hide ? 'password' : 'text';
    const icon = document.getElementById('icon-toggle-token');
    if (icon) {
        icon.setAttribute('data-lucide', hide ? 'eye' : 'eye-off');
        refreshLucideIcons();
    }
}

async function clearReniecToken() {
    _reniecRunGeneration++;
    _reniecTestGeneration++;
    clearTimeout(_reniecRetryTimer);
    clearTimeout(_reniecPersistTimer);
    _reniecPersistTimer = null;
    const token = getReniecToken();
    try {
        await reniecTokenStore.clear();
    } catch (err) {
        _reniecTokenMemory = token;
        const input = document.getElementById('field-reniec-token');
        if (input) input.value = token;
        updateReniecTokenStatus();
        console.warn('[RENIEC] No se pudo eliminar el token guardado:', err);
        showToast('No se pudo eliminar el token RENIEC guardado', 'error');
        return false;
    }
    const input = document.getElementById('field-reniec-token');
    if (input) input.value = '';
    updateReniecTokenStatus();
    const result = document.getElementById('reniec-test-result');
    if (result) result.innerHTML = '';
    const testButton = document.getElementById('btn-test-reniec');
    if (testButton) { testButton.disabled = false; testButton.textContent = 'Probar'; }
    showToast('Token RENIEC eliminado', 'info');
    return true;
}

// Test-probe the token with a well-known public DNI so the user can verify it works.
// Uses "12345678" which apisperu returns a sample record for; even a 404 confirms the token is valid.
async function testReniecToken() {
    const btn    = document.getElementById('btn-test-reniec');
    const result = document.getElementById('reniec-test-result');
    const token  = getReniecToken();
    const testGeneration = ++_reniecTestGeneration;

    if (!token) {
        if (result) result.innerHTML = `<span class="inline-result-row inline-result-error">${iconHtml('x-circle', 'inline-result-icon')}<span>Pega tu token primero.</span></span>`;
        refreshLucideIcons();
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Probando...'; }
    if (result) result.innerHTML = `<span class="inline-result-row">${iconHtml('loader-circle', 'inline-result-icon inline-result-spin')}<span>Consultando RENIEC...</span></span>`;
    refreshLucideIcons();

    try {
        const json = await queryReniecRecord('12345678', token);
        if (testGeneration !== _reniecTestGeneration || token !== getReniecToken()) return;

        // apisperu returns { success:false, message:"DNI no encontrado" } for unknown DNIs with a valid token —
        // that still proves the token works.
        const tokenWorks = (json && json.success !== false) || (json && json.message && !/token/i.test(json.message));
        if (tokenWorks) {
            if (result) result.innerHTML = `<span class="inline-result-row inline-result-success">${iconHtml('check-circle-2', 'inline-result-icon')}<span>Token válido — RENIEC responde correctamente.</span></span>`;
            showToast('Token RENIEC verificado', 'success');
            scheduleReniecEnrichment();
        } else {
            const msg = json?.message || 'Respuesta inesperada';
            if (/token/i.test(msg)) throw new Error(msg);
            if (result) result.innerHTML = `<span class="inline-result-row inline-result-success">${iconHtml('check-circle-2', 'inline-result-icon')}<span>Token válido <span class="inline-result-muted">(respuesta: ${escapeHtml(msg)})</span></span></span>`;
        }
    } catch (rawError) {
        if (testGeneration !== _reniecTestGeneration || token !== getReniecToken()) return;
        const err = rawError?.code ? rawError : classifyReniecError(rawError);
        if (err.code === 'not_found') {
            if (result) result.innerHTML = `<span class="inline-result-row inline-result-success">${iconHtml('check-circle-2', 'inline-result-icon')}<span>Token válido — RENIEC respondió sin encontrar el DNI de prueba.</span></span>`;
            showToast('Token RENIEC verificado', 'success');
            scheduleReniecEnrichment();
            return;
        }
        const msg = err?.message || 'Error al probar el token';
        if (result) result.innerHTML = `<span class="inline-result-row inline-result-error">${iconHtml('x-circle', 'inline-result-icon')}<span>${escapeHtml(msg)}</span></span>`;
        showToast(`Token RENIEC: ${msg}`, 'error');
    } finally {
        if (testGeneration === _reniecTestGeneration) {
            if (btn) { btn.disabled = false; btn.textContent = 'Probar'; }
            refreshLucideIcons();
        }
    }
}

async function enrichWithRENIEC() {
    const token = getReniecToken();
    if (!token) return;

    const runGeneration = ++_reniecRunGeneration;
    const dataGeneration = state.reniecGeneration;
    const recordsRef = state.records;
    const isStale = () => runGeneration !== _reniecRunGeneration ||
        dataGeneration !== state.reniecGeneration || recordsRef !== state.records || token !== getReniecToken();

    const toEnrich = state.records
        .filter(record => /^\d{8}$/.test(getRecordKey(record)) && record.reniecOk !== true && record.reniecStatus !== 'not_found')
        .map(record => {
            if (record.filenameNombres === undefined) record.filenameNombres = record.nombres || '';
            if (record.filenameApellidos === undefined) record.filenameApellidos = record.apellidos || '';
            return {
                record,
                dni: getRecordKey(record),
                nombres: record.nombres || '',
                apellidos: record.apellidos || '',
                photoSource: state.photoPaths[getRecordKey(record)] || state.photosMap[getRecordKey(record)] || ''
            };
        });
    if (toEnrich.length === 0) return;

    showToast(`Verificando ${toEnrich.length} DNI${toEnrich.length > 1 ? 's' : ''} en RENIEC…`, 'info');
    updateReniecStatChip(`0/${toEnrich.length}`);

    let ok = 0, notFound = 0, errors = 0, skipped = 0;
    let consecutiveTransientErrors = 0;
    let firstError = '';
    let exportInvalidated = false;

    for (let i = 0; i < toEnrich.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 200)); // ≈ 5 req/s, skip on first
        if (isStale()) return;

        const candidate = toEnrich[i];
        const { record, dni } = candidate;

        try {
            const json = await queryReniecRecord(dni, token);

            if (isStale()) return;
            const currentPhotoSource = state.photoPaths[dni] || state.photosMap[dni] || '';
            const provenanceMatches = state.records.includes(record) && getRecordKey(record) === dni &&
                record.nombres === candidate.nombres && record.apellidos === candidate.apellidos &&
                currentPhotoSource === candidate.photoSource;
            if (!provenanceMatches) {
                skipped++;
                continue;
            }

            if (json && json.nombres && json.success !== false) {
                if (!exportInvalidated) {
                    invalidatePreflightReport();
                    exportInvalidated = true;
                }
                const nombres   = (json.nombres || '').trim();
                const apellidos = `${(json.apellidoPaterno || '')} ${(json.apellidoMaterno || '')}`.trim();
                if (record.filenameNombres === undefined) record.filenameNombres = candidate.nombres;
                if (record.filenameApellidos === undefined) record.filenameApellidos = candidate.apellidos;
                if (nombres) record.nombres = nombres;
                if (apellidos) record.apellidos = apellidos;
                record.reniecNombres = nombres;
                record.reniecApellidos = apellidos;
                record.reniecOk = true;
                record.reniecStatus = 'verified';
                delete record.reniecError;
                ok++;
                consecutiveTransientErrors = 0;
            } else {
                throw classifyReniecError(json?.message || 'DNI no encontrado');
            }
        } catch (rawError) {
            if (isStale()) return;
            if (!state.records.includes(record) || getRecordKey(record) !== dni) continue;
            const err = rawError?.code ? rawError : classifyReniecError(rawError);
            const msg = err?.message || '';
            if (err.code === 'not_found') {
                record.reniecOk = false;
                record.reniecStatus = 'not_found';
                delete record.reniecError;
                notFound++;
                consecutiveTransientErrors = 0;
            } else {
                delete record.reniecOk;
                record.reniecStatus = err.code || 'error';
                record.reniecError = { code: err.code || 'error', message: msg, retryable: !!err.retryable };
                errors++;
                consecutiveTransientErrors = err.retryable ? consecutiveTransientErrors + 1 : 0;
                if (!firstError) firstError = msg;
                if (err.code === 'auth' || err.code === 'rate_limit' || consecutiveTransientErrors >= 3) break;
            }
        }

        // Update chip counter every record (cheap text update) so large batches show live progress
        if (isStale()) return;
        const processed = i + 1;
        const suffix = processed < toEnrich.length ? ` (${ok} ok)` : '';
        updateReniecStatChip(`${processed}/${toEnrich.length}${suffix}`);
    }

    if (isStale()) return;

    showDataPreview();
    tryRender();
    updateReniecStatChip(`${ok}/${toEnrich.length}`);
    updateStatusBar();

    const corrected = state.records.filter(r => r.reniecOk && r.filenameNombres &&
        (r.filenameNombres.toUpperCase() !== r.reniecNombres?.toUpperCase() ||
         r.filenameApellidos?.toUpperCase() !== r.reniecApellidos?.toUpperCase())).length;

    let msg = `RENIEC: ${ok} verificados`;
    if (corrected > 0) msg += `, ${corrected} nombre${corrected > 1 ? 's' : ''} corregido${corrected > 1 ? 's' : ''}`;
    if (notFound > 0)  msg += `, ${notFound} no encontrado${notFound > 1 ? 's' : ''}`;
    if (errors > 0)    msg += `, ${errors} con error`;
    if (skipped > 0)   msg += `, ${skipped} omitido${skipped > 1 ? 's' : ''} por cambios locales`;
    if (firstError)    msg += ` — ${firstError}`;

    showToast(msg, ok > 0 ? 'success' : (errors > 0 ? 'error' : 'warning'));

    // After enrichment: detect if filename parser had nombres/apellidos swapped
    // and auto-repair unverified records if the swap pattern is consistent.
    detectAndFixNameSwap(runGeneration);
    updateFilmstripTooltips(); // Update card titles without rebuilding the DOM

    saveSession(); // Persist RENIEC-enriched names
}

// ---- Detect & fix nombres↔apellidos swap ----
// Compares what the filename parser produced vs what RENIEC says is correct.
// Requires a strong, repeated inversion pattern before touching unverified records.
function detectAndFixNameSwap(runGeneration = _reniecRunGeneration) {
    const verified = state.records.filter(r =>
        r.reniecOk === true &&
        r.filenameNombres !== undefined &&
        r.reniecNombres   !== undefined &&
        r.reniecApellidos !== undefined
    );
    if (verified.length < 4 || runGeneration !== _reniecRunGeneration) return;

    function norm(s) {
        return (s || '').toUpperCase().trim().replace(/\s+/g, ' ');
    }

    // Word-intersection score (0–1): how many words of 'a' appear in 'b'
    function matchScore(a, b) {
        const wa = norm(a).split(' ').filter(Boolean);
        const wb = norm(b).split(' ').filter(Boolean);
        if (!wa.length || !wb.length) return 0;
        const common = wa.filter(w => wb.includes(w)).length;
        return common / Math.max(wa.length, wb.length);
    }

    let swapCount = 0;
    let directCount = 0;
    for (const r of verified) {
        const swapScore = Math.min(
            matchScore(r.filenameNombres, r.reniecApellidos),
            matchScore(r.filenameApellidos, r.reniecNombres)
        );
        const directScore = Math.min(
            matchScore(r.filenameNombres, r.reniecNombres),
            matchScore(r.filenameApellidos, r.reniecApellidos)
        );
        if (swapScore >= 0.75 && swapScore >= directScore + 0.25) swapCount++;
        if (directScore >= 0.75) directCount++;
    }

    if (swapCount / verified.length < 0.75 || swapCount <= directCount || runGeneration !== _reniecRunGeneration) return;

    // Consistent swap detected: fix all records that RENIEC didn't verify
    let fixed = 0;
    let exportInvalidated = false;
    state.records.forEach(r => {
        const hasUntouchedProvenance = r.filenameNombres !== undefined && r.filenameApellidos !== undefined &&
            r.nombres === r.filenameNombres && r.apellidos === r.filenameApellidos;
        if (r.reniecOk !== true && hasUntouchedProvenance && r.nameSwapAutoFixed !== true) {
            if (!exportInvalidated) {
                invalidatePreflightReport();
                exportInvalidated = true;
            }
            const tmp  = r.nombres;
            r.nombres  = r.apellidos;
            r.apellidos = tmp;
            r.nameSwapAutoFixed = true;
            fixed++;
        }
    });

    if (fixed > 0) {
        showDataPreview();
        tryRender();
        saveSessionDebounced();
        showToast(
            `Se detectó formato invertido: nombres↔apellidos corregidos en ${fixed} registro${fixed !== 1 ? 's' : ''}.`,
            'info'
        );
    }
}

function updateReniecStatChip(text) {
    const chip = document.getElementById('chip-reniec');
    const el   = document.getElementById('stat-reniec');
    if (chip) chip.style.display = '';
    if (el)   el.textContent = text;
}

// ---- CSV / Excel (OPTIONAL — for extra fields like cargo) ----
