const RENIEC_TOKEN_KEY = 'reniec-token';

const reniecTokenStore = {
    get() {
        try {
            return localStorage.getItem(RENIEC_TOKEN_KEY) || '';
        } catch (_) {
            return '';
        }
    },
    set(token) {
        try {
            if (token) localStorage.setItem(RENIEC_TOKEN_KEY, token);
            else localStorage.removeItem(RENIEC_TOKEN_KEY);
        } catch (_) {}
    },
    clear() {
        try {
            localStorage.removeItem(RENIEC_TOKEN_KEY);
        } catch (_) {}
    }
};

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
            if (persistInput?.checked !== false) {
                reniecTokenStore.set(token);
            } else {
                reniecTokenStore.clear();
            }
            updateReniecTokenStatus();
        });
    }

    if (persistInput && persistInput.dataset.bound !== '1') {
        persistInput.dataset.bound = '1';
        persistInput.addEventListener('change', () => {
            const token = tokenInput?.value?.trim() || '';
            if (persistInput.checked) {
                reniecTokenStore.set(token);
                showToast('Token RENIEC se guardara localmente', 'info');
            } else {
                reniecTokenStore.clear();
                showToast('Token RENIEC no se guardara en este equipo', 'info');
            }
            updateReniecTokenStatus();
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
        statusEl.textContent = token ? '✓ Configurado' : '';
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
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
}

function clearReniecToken() {
    reniecTokenStore.clear();
    const input = document.getElementById('field-reniec-token');
    if (input) input.value = '';
    updateReniecTokenStatus();
    const result = document.getElementById('reniec-test-result');
    if (result) result.innerHTML = '';
    showToast('Token RENIEC eliminado', 'info');
}

// Test-probe the token with a well-known public DNI so the user can verify it works.
// Uses "12345678" which apisperu returns a sample record for; even a 404 confirms the token is valid.
async function testReniecToken() {
    const btn    = document.getElementById('btn-test-reniec');
    const result = document.getElementById('reniec-test-result');
    const token  = getReniecToken();

    if (!token) {
        if (result) result.innerHTML = '<span style="color:#f87171;">Pega tu token primero.</span>';
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Probando…'; }
    if (result) result.innerHTML = '<span style="color:var(--text-muted);">Consultando RENIEC…</span>';

    try {
        let json, httpStatus = 0, ok = false;
        if (window.electronAPI?.queryRENIEC) {
            const r = await window.electronAPI.queryRENIEC('12345678', token);
            ok   = r.ok;
            json = r.body;
            if (!ok) throw new Error(r.error || 'Falló la consulta');
        } else {
            const resp = await fetch(`https://dniruc.apisperu.com/api/v1/dni/12345678?token=${encodeURIComponent(token)}`);
            httpStatus = resp.status;
            if (resp.status === 401 || resp.status === 403) throw new Error('Token inválido o sin permisos');
            if (resp.status === 429) throw new Error('Límite de consultas superado');
            json = await resp.json().catch(() => ({}));
        }

        // apisperu returns { success:false, message:"DNI no encontrado" } for unknown DNIs with a valid token —
        // that still proves the token works.
        const tokenWorks = (json && json.success !== false) || (json && json.message && !/token/i.test(json.message));
        if (tokenWorks) {
            if (result) result.innerHTML = '<span style="color:#34d399;font-weight:600;">✓ Token válido — RENIEC responde correctamente.</span>';
            showToast('Token RENIEC verificado', 'success');
        } else {
            const msg = json?.message || 'Respuesta inesperada';
            if (/token/i.test(msg)) throw new Error(msg);
            if (result) result.innerHTML = `<span style="color:#34d399;font-weight:600;">✓ Token válido</span> <span style="color:var(--text-muted);">(respuesta: ${escapeHtml(msg)})</span>`;
        }
    } catch (err) {
        const msg = err?.message || 'Error al probar el token';
        if (result) result.innerHTML = `<span style="color:#f87171;font-weight:600;">✗ ${escapeHtml(msg)}</span>`;
        showToast(`Token RENIEC: ${msg}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Probar'; }
    }
}

async function enrichWithRENIEC() {
    // Capture the generation token at the moment this query starts.
    // If the user reloads photos, state.reniecGeneration increments and
    // every check below will abort — preventing stale data from being written.
    const myGeneration = state.reniecGeneration;
    const isStale = () => state.reniecGeneration !== myGeneration;

    const toEnrich = state.records.filter(r => /^\d{8}$/.test(getRecordKey(r)) && !r.reniecOk);
    if (toEnrich.length === 0) return;

    // Build a fast lookup: dniKey -> index in state.records (avoids O(n²) findIndex)
    const dniIndexMap = new Map(state.records.map((r, i) => [getRecordKey(r), i]));

    showToast(`Verificando ${toEnrich.length} DNI${toEnrich.length > 1 ? 's' : ''} en RENIEC…`, 'info');
    updateReniecStatChip(`0/${toEnrich.length}`);

    let ok = 0, notFound = 0, errors = 0;
    let firstError = '';

    for (let i = 0; i < toEnrich.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 200)); // ≈ 5 req/s, skip on first
        if (isStale()) return;

        const record = toEnrich[i];
        const dni = getRecordKey(record);
        // Resolve index outside try/catch so it's accessible in both blocks
        const idx = dniIndexMap.get(dni);
        if (idx === undefined) continue;

        try {
            let json;

            const token = getReniecToken();
            if (!token) {
                throw new Error('Configura tu token RENIEC en la sección de datos.');
            }

            if (window.electronAPI?.queryRENIEC) {
                const result = await window.electronAPI.queryRENIEC(dni, token);
                if (!result.ok) throw new Error(result.error);
                json = result.body;
            } else {
                const resp = await fetch(
                    `https://dniruc.apisperu.com/api/v1/dni/${dni}?token=${token}`
                );
                if (!resp.ok) {
                    const code = resp.status;
                    if (code === 401 || code === 403) throw new Error('Token RENIEC inválido o sin permisos');
                    if (code === 404) throw new Error('DNI no encontrado');
                    if (code === 429) throw new Error('Límite de consultas superado — espera unos segundos');
                    if (code >= 500)  throw new Error(`Error del servidor RENIEC (${code})`);
                    throw new Error(`Respuesta HTTP inesperada (${code})`);
                }
                json = await resp.json();
            }

            // Check again after the await — a reload could have happened during the request
            if (isStale()) return;
            // Guard against undo/redo replacing state.records between awaits:
            // if the record at idx no longer matches our DNI, skip to avoid a wrong write
            if (idx >= state.records.length || getRecordKey(state.records[idx]) !== dni) continue;

            // apisperu.com: success response has `nombres` field directly; failure has success:false
            if (json && json.nombres && json.success !== false) {
                const nombres   = (json.nombres || '').trim();
                const apellidos = `${(json.apellidoPaterno || '')} ${(json.apellidoMaterno || '')}`.trim();
                if (!state.records[idx].filenameNombres)   state.records[idx].filenameNombres   = state.records[idx].nombres;
                if (!state.records[idx].filenameApellidos) state.records[idx].filenameApellidos = state.records[idx].apellidos;
                if (nombres)   state.records[idx].nombres   = nombres;
                if (apellidos) state.records[idx].apellidos = apellidos;
                state.records[idx].reniecNombres   = nombres;
                state.records[idx].reniecApellidos = apellidos;
                state.records[idx].reniecOk = true;
                ok++;
            } else {
                state.records[idx].reniecOk = false;
                notFound++;
            }
        } catch (err) {
            if (isStale()) return;
            state.records[idx].reniecOk = false;
            errors++;
            const msg = err?.message || '';
            if (!firstError) firstError = msg;
            // Token/rate-limit errors will repeat for every remaining DNI — stop early.
            if (msg.includes('Token RENIEC') || msg.includes('Límite de consultas')) break;
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
    if (firstError)    msg += ` — ${firstError}`;

    showToast(msg, ok > 0 ? 'success' : (errors > 0 ? 'error' : 'warning'));

    // After enrichment: detect if filename parser had nombres/apellidos swapped
    // and auto-repair unverified records if the swap pattern is consistent.
    detectAndFixNameSwap();
    updateFilmstripTooltips(); // Update card titles without rebuilding the DOM

    saveSession(); // Persist RENIEC-enriched names
}

// ---- Detect & fix nombres↔apellidos swap ----
// Compares what the filename parser produced vs what RENIEC says is correct.
// If ≥50% of RENIEC-verified records had the fields inverted, fixes all unverified ones.
function detectAndFixNameSwap() {
    const verified = state.records.filter(r =>
        r.reniecOk === true &&
        r.filenameNombres !== undefined &&
        r.reniecNombres   !== undefined &&
        r.reniecApellidos !== undefined
    );
    if (verified.length < 2) return; // Not enough data to detect a pattern

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
    for (const r of verified) {
        // A "swap" means: what was stored as nombres ≈ RENIEC's apellidos (and vice versa)
        const nombresWasApellidos = matchScore(r.filenameNombres,   r.reniecApellidos) >= 0.5;
        const apellidosWasNombres = matchScore(r.filenameApellidos, r.reniecNombres)   >= 0.5;
        if (nombresWasApellidos && apellidosWasNombres) swapCount++;
    }

    if (swapCount / verified.length < 0.5) return; // No consistent pattern — don't touch anything

    // Consistent swap detected: fix all records that RENIEC didn't verify
    let fixed = 0;
    state.records.forEach(r => {
        if (r.reniecOk !== true) {
            const tmp  = r.nombres;
            r.nombres  = r.apellidos;
            r.apellidos = tmp;
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
