
// ===================== MODAL =====================

function showModal(title, text, cancellable = false) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-text').textContent = text;
    document.getElementById('progress-fill').style.width = '0%';
    const pctEl = document.getElementById('progress-percent');
    if (pctEl) {
        // Only show a live percentage for batch jobs (which are cancellable); hide for single-shot ops
        pctEl.style.display = cancellable ? '' : 'none';
        pctEl.textContent = '0%';
    }
    const cancelBtn = document.getElementById('modal-cancel-btn');
    if (cancelBtn) {
        cancelBtn.style.display = cancellable ? 'inline-flex' : 'none';
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancelar exportación';
    }
    document.getElementById('modal-loading').classList.add('active');
}

function updateModal(text, percent) {
    document.getElementById('modal-text').textContent = text;
    const pct = clamp(toFloat(percent, 0), 0, 100);
    document.getElementById('progress-fill').style.width = `${pct}%`;
    const pctEl = document.getElementById('progress-percent');
    if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
}

function hideModal() {
    const cancelBtn = document.getElementById('modal-cancel-btn');
    if (cancelBtn) {
        cancelBtn.style.display = 'none';
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancelar exportación';
    }
    document.getElementById('modal-loading').classList.remove('active');
}

// ===================== HELP MODAL =====================

function openHelpModal() {
    const m = document.getElementById('modal-help');
    if (m) m.classList.add('active');
}

function closeHelpModal() {
    const m = document.getElementById('modal-help');
    if (m) m.classList.remove('active');
}

function toggleHelpModal() {
    const m = document.getElementById('modal-help');
    if (!m) return;
    m.classList.toggle('active');
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
    el.textContent = `📊 ${parts.join(' · ')}`;
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
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> ${escapeHtml(message)}`;
    toast.addEventListener('click', () => dismissToast(toast));
    container.appendChild(toast);

    const duration = type === 'error' ? Math.max(4000, message.length * 55) : 3000;
    setTimeout(() => dismissToast(toast), duration);
}

