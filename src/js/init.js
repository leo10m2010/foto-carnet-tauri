// ===================== INIT =====================

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof lucide !== 'undefined') lucide.createIcons();

    setupFileHandlers();
    setupLivePreview();
    setupCanvasDrag();
    initializeEditorState();
    setupHistoryControls();
    setupMenuHandlers();
    setupAppControls();
    setupSidebarActionControls();
    setupReniecControls();
    setupModalControls();
    setupKeyboardShortcuts();
    setupExportToolbarHandlers();
    initFilmstrip();
    setupFilmstripControls();
    restoreCollapsedSections();
    applyFontPreviewToSelects();
    refreshExportStatsDisplay();
    const savedMode = localStorage.getItem('carnet-ui-mode') || 'simple';
    setUIMode(savedMode);
    const savedToken = reniecTokenStore.get();
    if (savedToken) {
        const tokenInput = document.getElementById('field-reniec-token');
        if (tokenInput) tokenInput.value = savedToken;
    }
    updateReniecTokenStatus();
    setupFolderWatcher();
    await restoreSession();
    setupUpdateControls();
    setupUpdateBanner();
});

function manualCheckForUpdates() {
    if (!window.electronAPI?.checkForUpdates) return;
    const btn = document.getElementById('btn-check-updates');
    const banner = document.getElementById('update-banner');
    const bannerAlreadyVisible = banner?.style.display !== 'none';

    function resetBtn() {
        if (!btn) return;
        btn.disabled = false;
        btn.classList.remove('is-checking');
        btn.innerHTML = '<i data-lucide="refresh-cw"></i><span class="sr-only">Buscar actualizaciones</span>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    if (btn) {
        btn.disabled = true;
        btn.classList.add('is-checking');
        btn.innerHTML = '<i data-lucide="refresh-cw"></i><span class="sr-only">Buscando actualizaciones</span>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    const result = window.electronAPI.checkForUpdates();

    if (result && typeof result.then === 'function') {
        // Tauri: Promise-based, resolves with true/false
        result.then(found => {
            resetBtn();
            if (!found && !bannerAlreadyVisible) showToast('Ya tienes la última versión instalada ✓', 'success');
        }).catch(resetBtn);
    } else {
        // Electron: fire-and-forget via IPC; check banner state after timeout
        setTimeout(() => {
            resetBtn();
            if (banner?.style.display === 'none' && !bannerAlreadyVisible) {
                showToast('Ya tienes la última versión instalada ✓', 'success');
            }
        }, 5000);
    }
}

function setupUpdateBanner() {
    if (!window.electronAPI?.onUpdateAvailable) return;
    window.electronAPI.onUpdateAvailable(({ version, url }) => {
        const banner = document.getElementById('update-banner');
        const text   = document.getElementById('update-banner-text');
        const link   = document.getElementById('update-banner-link');
        if (!banner || !text || !link) return;
        text.textContent = `Nueva versión v${version} disponible`;
        link.dataset.updateUrl = url || '';
        link.setAttribute('href', url || '#');
        banner.style.display = 'flex';
        if (typeof lucide !== 'undefined') lucide.createIcons();
    });
}

function openUpdateUrl(url) {
    if (!url) return;
    if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(url).catch(() => window.open(url, '_blank'));
    } else {
        window.open(url, '_blank');
    }
}

function setupUpdateControls() {
    const checkBtn = document.querySelector('[data-update-check]');
    if (checkBtn && checkBtn.dataset.updateBound !== '1') {
        checkBtn.dataset.updateBound = '1';
        checkBtn.addEventListener('click', (event) => {
            event.preventDefault();
            manualCheckForUpdates();
        });
    }

    const closeBtn = document.querySelector('[data-update-banner-close]');
    if (closeBtn && closeBtn.dataset.updateBound !== '1') {
        closeBtn.dataset.updateBound = '1';
        closeBtn.addEventListener('click', (event) => {
            event.preventDefault();
            const banner = document.getElementById('update-banner');
            if (banner) banner.style.display = 'none';
        });
    }

    const link = document.getElementById('update-banner-link');
    if (link && link.dataset.updateBound !== '1') {
        link.dataset.updateBound = '1';
        link.addEventListener('click', (event) => {
            event.preventDefault();
            openUpdateUrl(link.dataset.updateUrl || link.getAttribute('href'));
        });
    }
}

window.addEventListener('beforeunload', () => {
    revokePhotoObjectUrls();
});
