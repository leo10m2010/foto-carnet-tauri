// ===================== FILMSTRIP NAVIGATOR =====================

let _filmstripObserver = null;
let _filmstripRefreshTimer = null;

function getRecordDisplayName(record) {
    return [record.apellidos, record.nombres].filter(Boolean).join(' ').trim();
}

function initFilmstrip() {
    const saved = localStorage.getItem('filmstrip_visible');
    state.filmstripVisible = saved !== 'false'; // default: visible
    applyFilmstripVisibility(false);
}

function setupFilmstripControls() {
    const handle = document.querySelector('[data-filmstrip-toggle]');
    if (!handle || handle.dataset.filmstripBound === '1') return;
    handle.dataset.filmstripBound = '1';

    handle.addEventListener('click', (event) => {
        event.preventDefault();
        toggleFilmstrip();
    });

    handle.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleFilmstrip();
    });
}

function toggleFilmstrip() {
    state.filmstripVisible = !state.filmstripVisible;
    localStorage.setItem('filmstrip_visible', String(state.filmstripVisible));
    applyFilmstripVisibility(true);
    if (state.filmstripVisible) {
        setTimeout(scrollFilmstripToActive, 260);
    }
}

function applyFilmstripVisibility(animate) {
    const bar = document.getElementById('filmstrip-bar');
    if (!bar) return;
    // Hide the whole bar when there are no records — nothing useful to show.
    const hasRecords = state.records && state.records.length > 0;
    bar.style.display = hasRecords ? '' : 'none';
    const handle = document.querySelector('[data-filmstrip-toggle]');
    if (handle) handle.setAttribute('aria-expanded', String(hasRecords && !!state.filmstripVisible));
    if (!hasRecords) return;
    if (!animate) bar.classList.add('no-transition');
    bar.classList.toggle('is-open', !!state.filmstripVisible);
    const arrow = document.getElementById('filmstrip-arrow');
    if (arrow) {
        arrow.innerHTML = iconHtml(state.filmstripVisible ? 'chevron-down' : 'chevron-up');
        refreshLucideIcons();
    }
    if (!animate) {
        bar.offsetHeight; // force reflow before re-enabling transitions
        bar.classList.remove('no-transition');
    }
}

function renderFilmstrip() {
    const track = document.getElementById('filmstrip-track');
    if (!track) return;

    if (_filmstripObserver) {
        _filmstripObserver.disconnect();
        _filmstripObserver = null;
    }

    track.innerHTML = '';

    const countEl = document.getElementById('filmstrip-count');
    if (countEl) countEl.textContent = state.records.length ? `${state.records.length} fotos` : '';

    // Keep the bar hidden when empty / visible when there is data
    applyFilmstripVisibility(false);

    if (!state.records.length) return;

    const fragment = document.createDocumentFragment();
    state.records.forEach((record, i) => {
        const card = document.createElement('div');
        card.className = 'filmstrip-thumb' + (i === state.currentIndex ? ' is-active' : '');
        card.dataset.index = i;
        card.title = `${i + 1}. ${getRecordDisplayName(record)}`;
        card.addEventListener('click', () => goToFilmstripIndex(i));

        card.innerHTML =
            `<div class="thumb-img-wrap">` +
                `<canvas class="thumb-canvas" data-index="${i}"></canvas>` +
                `<span class="thumb-num">${i + 1}</span>` +
            `</div>` +
            `<div class="thumb-name">${i + 1}</div>`;

        fragment.appendChild(card);
    });

    track.appendChild(fragment);

    const container = document.getElementById('filmstrip-container');
    _filmstripObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const canvas = entry.target;
                if (canvas.dataset.loaded) return;
                canvas.dataset.loaded = '1';
                _filmstripObserver.unobserve(canvas);
                _loadThumb(canvas);
            });
        },
        { root: container, rootMargin: '0px 320px 0px 320px', threshold: 0 }
    );

    track.querySelectorAll('.thumb-canvas').forEach(canvas => _filmstripObserver.observe(canvas));

    if (state.filmstripVisible) requestAnimationFrame(() => scrollFilmstripToActive(false));
}

function _loadThumb(canvas) {
    const i = Number(canvas.dataset.index);
    if (!state.templateImage || i < 0 || i >= state.records.length) return;

    // Render at ~96px wide (2× display density for sharpness) into the thumb canvas
    const scale = Math.max(0.04, 96 / (state.templateImage.width || 630));
    renderCarnet(i, canvas, scale).catch(() => {});
}

function updateFilmstripActive() {
    const track = document.getElementById('filmstrip-track');
    if (!track || !track.children.length) return;
    const prev = track.querySelector('.filmstrip-thumb.is-active');
    if (prev) prev.classList.remove('is-active');
    const next = track.children[state.currentIndex];
    if (next) next.classList.add('is-active');
}

function scrollFilmstripToActive(smooth = true) {
    const container = document.getElementById('filmstrip-container');
    const track = document.getElementById('filmstrip-track');
    if (!container || !track) return;
    const thumb = track.children[state.currentIndex];
    if (!thumb) return;
    const target = thumb.offsetLeft - container.clientWidth / 2 + thumb.offsetWidth / 2;
    // Avoid jumpy animation for tiny deltas and respect reduced-motion preferences
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const delta = Math.abs(container.scrollLeft - target);
    if (!smooth || prefersReducedMotion || delta < 4) {
        container.scrollLeft = target;
    } else {
        container.scrollTo({ left: target, behavior: 'smooth' });
    }
}

// Re-renders visible thumbnails after a debounce — called from tryRender on any edit.
function refreshFilmstripDebounced() {
    clearTimeout(_filmstripRefreshTimer);
    _filmstripRefreshTimer = setTimeout(_refreshVisibleThumbs, 600);
}

function _refreshVisibleThumbs() {
    const track = document.getElementById('filmstrip-track');
    const container = document.getElementById('filmstrip-container');
    if (!track || !container || !state.filmstripVisible || !state.templateImage) return;
    // Re-render only canvases currently in the scroll viewport (not just historically loaded).
    const { left: cLeft, right: cRight } = container.getBoundingClientRect();
    track.querySelectorAll('.thumb-canvas[data-loaded="1"]').forEach(canvas => {
        const { left, right } = canvas.getBoundingClientRect();
        if (right >= cLeft && left <= cRight) _loadThumb(canvas);
    });
}

function updateFilmstripTooltips() {
    const track = document.getElementById('filmstrip-track');
    if (!track) return;
    Array.from(track.children).forEach((card, i) => {
        const record = state.records[i];
        if (!record) return;
        card.title = `${i + 1}. ${getRecordDisplayName(record)}`;
    });
}

function goToFilmstripIndex(i) {
    if (i < 0 || i >= state.records.length || i === state.currentIndex) return;
    navigateRecord(i - state.currentIndex);
}
