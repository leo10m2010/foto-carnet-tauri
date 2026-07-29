
// ===================== MODAL =====================

let _activeModal = null;
let _modalReturnFocus = null;
let _modalTrapsFocus = false;

function getModalFocusableElements(modal) {
    return Array.from(modal.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

function setModalBackgroundInert(inert) {
    const app = document.querySelector('.app-container');
    if (app && 'inert' in app) app.inert = inert;
}

function activateModal(modal, { trapFocus = true, initialFocus = null } = {}) {
    if (!modal) return;
    if (_activeModal && _activeModal !== modal) deactivateModal(_activeModal, false);
    if (_activeModal !== modal) _modalReturnFocus = document.activeElement;

    _activeModal = modal;
    _modalTrapsFocus = trapFocus;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    setModalBackgroundInert(trapFocus);

    if (trapFocus) {
        const target = initialFocus || getModalFocusableElements(modal)[0] || modal;
        target.focus();
    }
}

function deactivateModal(modal, restoreFocus = true) {
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    if (_activeModal !== modal) return;

    _activeModal = null;
    _modalTrapsFocus = false;
    setModalBackgroundInert(false);
    const returnFocus = _modalReturnFocus;
    _modalReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected && typeof returnFocus.focus === 'function') {
        returnFocus.focus();
    }
}

function showModal(title, text, cancellable = false) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-text').textContent = text;
    const fill = document.getElementById('progress-fill');
    fill.style.width = '0%';
    const reducedMotion = typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    fill.style.transition = reducedMotion ? 'none' : '';
    const progress = document.getElementById('modal-progress');
    if (progress) {
        progress.removeAttribute('aria-valuenow');
        progress.setAttribute('aria-valuetext', `En curso: ${title}`);
        progress.dataset.progressState = 'indeterminate';
    }
    const pctEl = document.getElementById('progress-percent');
    if (pctEl) {
        pctEl.style.display = 'none';
        pctEl.textContent = '';
    }
    const cancelBtn = document.getElementById('modal-cancel-btn');
    if (cancelBtn) {
        cancelBtn.style.display = cancellable ? 'inline-flex' : 'none';
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancelar exportación';
    }
    const modal = document.getElementById('modal-loading');
    modal.dataset.cancellable = String(cancellable);
    activateModal(modal, {
        trapFocus: cancellable,
        initialFocus: cancellable ? cancelBtn : null
    });
}

function updateModal(text, percent) {
    document.getElementById('modal-text').textContent = text;
    const isDeterminate = typeof percent === 'number' && Number.isFinite(percent);
    const progress = document.getElementById('modal-progress');
    const pctEl = document.getElementById('progress-percent');
    if (!isDeterminate) {
        document.getElementById('progress-fill').style.width = '0%';
        if (progress) {
            progress.removeAttribute('aria-valuenow');
            progress.setAttribute('aria-valuetext', `En curso: ${text}`);
            progress.dataset.progressState = 'indeterminate';
        }
        if (pctEl) {
            pctEl.style.display = 'none';
            pctEl.textContent = '';
        }
        return;
    }
    const pct = clamp(toFloat(percent, 0), 0, 100);
    document.getElementById('progress-fill').style.width = `${pct}%`;
    if (progress) {
        progress.setAttribute('aria-valuenow', String(Math.round(pct)));
        progress.setAttribute('aria-valuetext', `${Math.round(pct)} por ciento`);
        progress.dataset.progressState = 'determinate';
    }
    if (pctEl) {
        const modal = document.getElementById('modal-loading');
        pctEl.style.display = modal?.dataset.cancellable === 'true' ? '' : 'none';
        pctEl.textContent = `${Math.round(pct)}%`;
    }
}

function hideModal() {
    const cancelBtn = document.getElementById('modal-cancel-btn');
    if (cancelBtn) {
        cancelBtn.style.display = 'none';
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancelar exportación';
    }
    deactivateModal(document.getElementById('modal-loading'));
}

// ===================== PHOTO IMPORT STATUS =====================

function formatPhotoImportCount(count) {
    return new Intl.NumberFormat('es-ES').format(Math.max(0, toInt(count, 0)));
}

function setPhotoImportStatus({ kind, title, detail, percent = null, note = '' }) {
    const panel = document.getElementById('photo-import-status');
    if (!panel) return;

    const isDeterminate = typeof percent === 'number' && Number.isFinite(percent);
    const progressValue = isDeterminate ? Math.round(clamp(percent, 0, 100)) : null;
    const titleEl = document.getElementById('photo-import-title');
    const detailEl = document.getElementById('photo-import-detail');
    const noteEl = document.getElementById('photo-import-note');
    const progress = document.getElementById('photo-import-progress');
    const fill = document.getElementById('photo-import-progress-fill');
    const cancel = document.getElementById('photo-import-cancel');

    panel.hidden = false;
    panel.dataset.state = kind;
    panel.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    panel.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    panel.setAttribute('aria-busy', String(kind === 'active'));
    if (titleEl) titleEl.textContent = title;
    if (detailEl) detailEl.textContent = detail;
    if (noteEl) {
        noteEl.textContent = note;
        noteEl.hidden = !note;
    }
    if (progress) {
        if (isDeterminate) {
            progress.setAttribute('aria-valuenow', String(progressValue));
            progress.setAttribute('aria-valuetext', `${progressValue} por ciento: ${title}`);
            progress.dataset.progressState = 'determinate';
        } else {
            progress.removeAttribute('aria-valuenow');
            progress.setAttribute('aria-valuetext', `En curso: ${title}`);
            progress.dataset.progressState = 'indeterminate';
        }
    }
    if (fill) {
        fill.style.transform = `scaleX(${isDeterminate ? progressValue / 100 : 0})`;
        const reducedMotion = typeof window !== 'undefined' &&
            window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        fill.style.transition = reducedMotion ? 'none' : '';
    }
    if (cancel) cancel.hidden = kind !== 'active';
}

function showPhotoImportProgress(title, detail, percent) {
    const isInspection = /^Inspeccionando\b/i.test(String(title || ''));
    setPhotoImportStatus({ kind: 'active', title, detail, percent: isInspection ? null : percent });
}

function showPhotoImportReady(count, duplicateCount = 0) {
    const photoCount = Math.max(0, toInt(count, 0));
    const duplicates = Math.max(0, toInt(duplicateCount, 0));
    const duplicateText = duplicates
        ? ` · ${formatPhotoImportCount(duplicates)} duplicada${duplicates !== 1 ? 's' : ''} omitida${duplicates !== 1 ? 's' : ''}`
        : '';
    setPhotoImportStatus({
        kind: 'ready',
        title: `${formatPhotoImportCount(photoCount)} foto${photoCount !== 1 ? 's' : ''} indexada${photoCount !== 1 ? 's' : ''}${duplicateText} · carga bajo demanda`,
        detail: 'La importación está lista.',
        percent: 100,
        note: 'Solo las fotos visibles y la foto actual entran en memoria; el resto permanece en disco.'
    });
}

function showPhotoImportError(detail) {
    const preserved = state?.photosCount > 0
        ? ` Se conservan las ${formatPhotoImportCount(state.photosCount)} fotos anteriores.`
        : ' No se aplicaron cambios.';
    setPhotoImportStatus({
        kind: 'error',
        title: 'No se completó la importación',
        detail: `${detail}${preserved}`
    });
}

function showPhotoImportCancelled() {
    const detail = state?.photosCount > 0
        ? `Se conservan las ${formatPhotoImportCount(state.photosCount)} fotos anteriores.`
        : 'No se aplicaron cambios.';
    setPhotoImportStatus({
        kind: 'cancelled',
        title: 'Importación cancelada',
        detail
    });
}

function cancelPhotoImport() {
    const panel = document.getElementById('photo-import-status');
    if (!panel || panel.dataset.state !== 'active') return;
    state.photoImportGeneration++;
    showPhotoImportCancelled();
}

function resetPhotoImportStatus() {
    const panel = document.getElementById('photo-import-status');
    if (!panel) return;
    panel.hidden = true;
    panel.dataset.state = 'idle';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.setAttribute('aria-busy', 'false');
    const progress = document.getElementById('photo-import-progress');
    const fill = document.getElementById('photo-import-progress-fill');
    const cancel = document.getElementById('photo-import-cancel');
    const note = document.getElementById('photo-import-note');
    if (progress) {
        progress.removeAttribute('aria-valuenow');
        progress.removeAttribute('aria-valuetext');
        progress.dataset.progressState = 'indeterminate';
    }
    if (fill) fill.style.transform = 'scaleX(0)';
    if (cancel) cancel.hidden = true;
    if (note) {
        note.hidden = true;
        note.textContent = '';
    }
}

function setupPhotoImportStatusControls() {
    document.querySelectorAll('[data-photo-import-cancel]').forEach(button => {
        if (button.dataset.photoImportBound === '1') return;
        button.dataset.photoImportBound = '1';
        button.addEventListener('click', cancelPhotoImport);
    });

    if (typeof clearAll === 'function' && !clearAll._photoImportStatusWrapped) {
        const clearAllBase = clearAll;
        clearAll = async function clearAllWithPhotoImportCleanup() {
            await clearAllBase();
            const wasCleared = !state.templateImage && state.records.length === 0 &&
                (!Array.isArray(state.csvRows) || state.csvRows.length === 0);
            if (wasCleared) resetPhotoImportStatus();
        };
        clearAll._photoImportStatusWrapped = true;
    }
}

// ===================== HELP MODAL =====================

function openHelpModal() {
    const m = document.getElementById('modal-help');
    const loading = document.getElementById('modal-loading');
    if (loading?.classList.contains('active')) return;
    activateModal(m, { initialFocus: m?.querySelector('[data-help-action="close"]') });
}

function closeHelpModal() {
    const m = document.getElementById('modal-help');
    deactivateModal(m);
}

function toggleHelpModal() {
    const m = document.getElementById('modal-help');
    if (!m) return;
    if (m.classList.contains('active')) closeHelpModal();
    else openHelpModal();
}

function setupModalControls() {
    if (document.body.dataset.modalA11yBound !== '1') {
        document.body.dataset.modalA11yBound = '1';
        document.addEventListener('keydown', event => {
            if (!_activeModal) return;
            if (event.key === 'Escape') {
                if (_activeModal.id === 'modal-help') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    closeHelpModal();
                } else if (_activeModal.dataset.cancellable === 'true') {
                    const cancelBtn = document.getElementById('modal-cancel-btn');
                    if (!cancelBtn?.disabled) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        cancelCurrentJob();
                        _activeModal.focus();
                    }
                }
                return;
            }
            if (event.key !== 'Tab' || !_modalTrapsFocus) return;

            const focusable = getModalFocusableElements(_activeModal);
            if (!focusable.length) {
                event.preventDefault();
                _activeModal.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }, true);
    }

    document.querySelectorAll('[data-modal-action]').forEach(btn => {
        if (btn.dataset.modalBound === '1') return;
        btn.dataset.modalBound = '1';
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            if (btn.dataset.modalAction === 'cancel-job') cancelCurrentJob();
        });
    });

    document.querySelectorAll('[data-help-action]').forEach(btn => {
        if (btn.dataset.helpBound === '1') return;
        btn.dataset.helpBound = '1';
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            const action = btn.dataset.helpAction;
            if (action === 'open') openHelpModal();
            if (action === 'close') closeHelpModal();
        });
    });

    document.querySelectorAll('[data-help-overlay]').forEach(overlay => {
        if (overlay.dataset.helpBound === '1') return;
        overlay.dataset.helpBound = '1';
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeHelpModal();
        });
    });
}

// ===================== EXPORT STATS =====================

const EXPORT_STATS_KEY = 'export-stats';

function getExportStats() {
    try {
        return JSON.parse(localStorage.getItem(EXPORT_STATS_KEY) || '{}');
    } catch (_) { return {}; }
}

function recordExport(kind) {
    const stats = getExportStats();
    stats[kind] = (stats[kind] || 0) + 1;
    localStorage.setItem(EXPORT_STATS_KEY, JSON.stringify(stats));
    refreshExportStatsDisplay();
}

function refreshExportStatsDisplay() {
    const el = document.getElementById('status-export-stats');
    if (!el) return;
    const s = getExportStats();
    const total = (s.png || 0) + (s.pdf || 0) + (s.zip || 0) + (s.print || 0);
    if (total === 0) { el.textContent = ''; return; }
    const parts = [];
    if (s.pdf)   parts.push(`${s.pdf} PDF`);
    if (s.zip)   parts.push(`${s.zip} ZIP`);
    if (s.png)   parts.push(`${s.png} PNG`);
    if (s.print) parts.push(`${s.print} impr.`);
    el.innerHTML = iconTextHtml('bar-chart-3', parts.join(' · '), 'status-export-icon');
    refreshLucideIcons();
}

// ===================== FONT PREVIEW =====================

// Apply each option's value as font-family style so the dropdown renders each font in its own face.
function applyFontPreviewToSelects() {
    document.querySelectorAll('select[id$="-font"]').forEach(sel => {
        Array.from(sel.options).forEach(opt => {
            if (opt.value) opt.style.fontFamily = `'${opt.value}', sans-serif`;
        });
        // Also reflect the currently selected font on the closed select
        const apply = () => { sel.style.fontFamily = `'${sel.value}', sans-serif`; };
        apply();
        sel.addEventListener('change', apply);
    });
}

// ===================== TOAST =====================

const TOAST_MAX = 4;

function dismissToast(toast) {
    if (!toast || toast.dataset.dismissing) return;
    toast.dataset.dismissing = '1';
    toast.classList.add('toast-leaving');
    setTimeout(() => toast.remove(), 260);
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // Enforce stack cap: drop the oldest non-dismissing toast if over the limit
    const existing = Array.from(container.querySelectorAll('.toast:not(.toast-leaving)'));
    while (existing.length >= TOAST_MAX) {
        dismissToast(existing.shift());
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-atomic', 'true');
    const icons = { success: 'check-circle-2', error: 'x-circle', info: 'info', warning: 'triangle-alert' };
    toast.innerHTML = `${iconHtml(icons[type] || 'info', 'toast-icon')}<span class="toast-message">${escapeHtml(message)}</span>`;
    toast.addEventListener('click', () => dismissToast(toast));
    container.appendChild(toast);
    refreshLucideIcons();

    const duration = type === 'error' ? Math.max(4000, message.length * 55) : 3000;
    setTimeout(() => dismissToast(toast), duration);
}
