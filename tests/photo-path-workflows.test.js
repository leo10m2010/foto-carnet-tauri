import { describe, expect, it, vi } from 'vitest';

import { loadClassicScripts } from './helpers/load-classic-scripts.js';

function elementStub() {
  const attributes = new Map();
  return {
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
    style: {},
    dataset: {},
    hidden: false,
    textContent: '',
    innerHTML: '',
    setAttribute: vi.fn((name, value) => attributes.set(name, String(value))),
    removeAttribute: vi.fn((name) => attributes.delete(name)),
    getAttribute: vi.fn((name) => attributes.get(name) ?? null),
    addEventListener: vi.fn()
  };
}

function configurePhotoSelectionApp(inspectImageFiles) {
  const app = loadClassicScripts('src/js/utils.js', 'src/js/files.js', 'src/js/ui.js');
  const elements = new Map();
  app.document = {
    getElementById: vi.fn((id) => {
      if (!elements.has(id)) elements.set(id, elementStub());
      return elements.get(id);
    }),
    createElement: vi.fn(() => elementStub())
  };
  app.window = { electronAPI: { inspectImageFiles } };
  app.state = {
    photoImportGeneration: 0,
    photoLoadGeneration: 0,
    lifecycleGeneration: 1,
    reniecGeneration: 0,
    photosMap: { 87654321: 'C:\\old\\87654321.jpg' },
    photoPaths: { 87654321: 'C:\\old\\87654321.jpg' },
    photoMeta: { 87654321: { width: 1, height: 1, sourceVersion: 'old' } },
    photoObjectUrls: [],
    photoImageCache: { clear: vi.fn() },
    photoFaceBoxes: { 87654321: {} },
    photoOverrides: { 87654321: {} },
    records: [{ dni: '87654321', dniKey: '87654321', photoKey: '87654321', hasPhoto: true }],
    currentIndex: 0,
    photosCount: 1,
    globalPhotoConfig: {},
    csvRows: [],
    drag: { selectedId: 'photo' },
    hitboxes: [{}],
    history: { undoStack: [{}], redoStack: [{}], lastSignature: 'old' }
  };
  app.getCurrentRecord = () => app.state.records[app.state.currentIndex] || null;
  app.readPhotoConfigFromInputs = () => ({ fit: 'cover' });
  app.invalidatePreflightReport = vi.fn();
  app.showDataPreview = vi.fn();
  app.updatePhotoInputsForCurrentRecord = vi.fn();
  app.updateNavigation = vi.fn();
  app.updateStatusBar = vi.fn();
  app.updateHistoryButtons = vi.fn();
  app.showToast = vi.fn();
  app.saveSessionDebounced = vi.fn();
  app.tryRender = vi.fn();
  app.renderFilmstrip = vi.fn();
  app.enrichWithRENIEC = vi.fn();
  app.__elements = elements;
  return app;
}

describe('native photo path selection', () => {
  it('keeps the previous session atomically when any inspected image is invalid', async () => {
    const inspectImageFiles = vi.fn().mockResolvedValue([
      { ok: true, width: 600, height: 800, sourceBytes: 100, sourceVersion: 'a' },
      { ok: false, filePath: 'C:\\new\\bad.jpg', error: 'invalid image' }
    ]);
    const app = configurePhotoSelectionApp(inspectImageFiles);
    const previous = {
      photosMap: app.state.photosMap,
      photoPaths: app.state.photoPaths,
      photoMeta: app.state.photoMeta,
      records: app.state.records,
      currentIndex: app.state.currentIndex
    };

    await expect(
      app.handlePhotoPathSelection(['C:\\new\\12345678.jpg', 'C:\\new\\bad.jpg'])
    ).resolves.toBe(false);

    expect(app.state.photosMap).toBe(previous.photosMap);
    expect(app.state.photoPaths).toBe(previous.photoPaths);
    expect(app.state.photoMeta).toBe(previous.photoMeta);
    expect(app.state.records).toBe(previous.records);
    expect(app.state.currentIndex).toBe(previous.currentIndex);
    expect(app.state.photoImageCache.clear).not.toHaveBeenCalled();
  });

  it('uses the last path and metadata for duplicate parsed keys', async () => {
    const paths = ['C:\\new\\12345678 - PEREZ ANA.jpg', 'C:\\new\\12345678 - GOMEZ EVA.png'];
    const app = configurePhotoSelectionApp(
      vi.fn().mockResolvedValue([
        { ok: true, width: 600, height: 800, sourceBytes: 100, sourceVersion: 'first' },
        { ok: true, width: 900, height: 1200, sourceBytes: 200, sourceVersion: 'second' }
      ])
    );

    await expect(app.handlePhotoPathSelection(paths)).resolves.toBe(true);

    expect(app.state.records).toHaveLength(1);
    expect(app.state.photosMap['12345678']).toBe(paths[1]);
    expect(app.state.photoPaths['12345678']).toBe(paths[1]);
    expect(app.state.photoMeta['12345678']).toEqual({
      source: paths[1],
      filePath: paths[1],
      width: 900,
      height: 1200,
      sourceBytes: 200,
      sourceVersion: 'second'
    });
    expect(app.state.photoObjectUrls).toEqual([]);
    expect(app.__elements.get('photo-import-status').dataset.state).toBe('ready');
    expect(app.__elements.get('photo-import-title').textContent).toBe(
      '1 foto indexada · 1 duplicada omitida · carga bajo demanda'
    );
  });

  it('invalidates an active import and ignores its late inspection results', async () => {
    let resolveInspection;
    const inspection = new Promise((resolve) => {
      resolveInspection = resolve;
    });
    const app = configurePhotoSelectionApp(vi.fn(() => inspection));
    const previousRecords = app.state.records;
    const previousPhotos = app.state.photosMap;

    const selection = app.handlePhotoPathSelection(['C:\\new\\12345678 - PEREZ ANA.jpg']);
    expect(app.__elements.get('photo-import-status').dataset.state).toBe('active');

    app.cancelPhotoImport();
    resolveInspection([
      { ok: true, width: 600, height: 800, sourceBytes: 100, sourceVersion: 'new' }
    ]);

    await expect(selection).resolves.toBe(false);
    expect(app.state.records).toBe(previousRecords);
    expect(app.state.photosMap).toBe(previousPhotos);
    expect(app.__elements.get('photo-import-status').dataset.state).toBe('cancelled');
    expect(app.__elements.get('photo-import-cancel').hidden).toBe(true);
  });
});

describe('photo import status cleanup', () => {
  it('supports indeterminate modal progress before measured work begins', () => {
    const app = loadClassicScripts('src/js/utils.js', 'src/js/ui.js');
    const elements = new Map();
    app.document = {
      getElementById: vi.fn((id) => {
        if (!elements.has(id)) elements.set(id, elementStub());
        return elements.get(id);
      })
    };
    app.window = { matchMedia: vi.fn(() => ({ matches: true })) };
    elements.set('modal-loading', { ...elementStub(), dataset: { cancellable: 'true' } });

    app.updateModal('Preparando exportación', null);

    const progress = elements.get('modal-progress');
    const fill = elements.get('progress-fill');
    const percent = elements.get('progress-percent');
    expect(progress.getAttribute('aria-valuenow')).toBeNull();
    expect(progress.dataset.progressState).toBe('indeterminate');
    expect(fill.style.width).toBe('0%');
    expect(percent.style.display).toBe('none');
    expect(percent.textContent).toBe('');

    app.updateModal('Unidad completada', 40);

    expect(progress.getAttribute('aria-valuenow')).toBe('40');
    expect(progress.dataset.progressState).toBe('determinate');
    expect(fill.style.width).toBe('40%');
    expect(percent.textContent).toBe('40%');
  });

  it('keeps inspection indeterminate and exposes preparation progress accessibly', () => {
    const app = loadClassicScripts('src/js/utils.js', 'src/js/ui.js');
    const elements = new Map();
    app.document = {
      getElementById: vi.fn((id) => {
        if (!elements.has(id)) elements.set(id, elementStub());
        return elements.get(id);
      })
    };
    app.window = {
      matchMedia: vi.fn(() => ({ matches: true }))
    };

    app.showPhotoImportProgress('Inspeccionando fotos', '100 fotos seleccionadas', 20);

    const progress = elements.get('photo-import-progress');
    const fill = elements.get('photo-import-progress-fill');
    expect(progress.getAttribute('aria-valuenow')).toBeNull();
    expect(progress.getAttribute('aria-valuetext')).toBe('En curso: Inspeccionando fotos');
    expect(progress.dataset.progressState).toBe('indeterminate');
    expect(fill.style.transform).toBe('scaleX(0)');
    expect(fill.style.transition).toBe('none');

    app.showPhotoImportProgress('Preparando registros', '100 fotos validadas', 75);

    expect(progress.getAttribute('aria-valuenow')).toBe('75');
    expect(progress.dataset.progressState).toBe('determinate');
    expect(fill.style.transform).toBe('scaleX(0.75)');
  });

  it('resets the inline panel after clearAll completes', async () => {
    const app = loadClassicScripts('src/js/utils.js', 'src/js/ui.js');
    const elements = new Map();
    app.document = {
      getElementById: vi.fn((id) => {
        if (!elements.has(id)) elements.set(id, elementStub());
        return elements.get(id);
      }),
      querySelectorAll: vi.fn(() => [])
    };
    app.state = {
      templateImage: {},
      records: [{ dni: '12345678' }],
      csvRows: [],
      photosCount: 1,
      photoImportGeneration: 0
    };
    app.clearAll = vi.fn(async () => {
      app.state.templateImage = null;
      app.state.records = [];
    });
    app.showPhotoImportReady(1);

    app.setupPhotoImportStatusControls();
    await app.clearAll();

    expect(elements.get('photo-import-status').hidden).toBe(true);
    expect(elements.get('photo-import-status').dataset.state).toBe('idle');
  });
});

describe('watcher path ingestion', () => {
  it('stores inspected paths and metadata without blobs or base64', async () => {
    const app = loadClassicScripts('src/js/utils.js', 'src/js/files.js', 'src/js/watcher.js');
    const path = 'C:\\watched\\12345678 - PEREZ ANA.jpg';
    app.window = {
      electronAPI: {
        inspectImageFiles: vi.fn().mockResolvedValue([
          {
            ok: true,
            filePath: path,
            width: 600,
            height: 800,
            sourceBytes: 1234,
            sourceVersion: 'v1',
            error: null
          }
        ])
      }
    };
    app.state = {
      watchedFolderPath: 'C:\\watched',
      records: [],
      currentIndex: 0,
      photosMap: {},
      photoPaths: {},
      photoMeta: {},
      photoObjectUrls: [],
      photoImageCache: { _map: new Map(), clear: vi.fn() },
      photoFaceBoxes: {},
      globalPhotoConfig: null,
      csvRows: [],
      photosCount: 0,
      photoImportGeneration: 0,
      photoLoadGeneration: 0,
      reniecGeneration: 0
    };
    app.state.exportRevision = 0;
    app.document = {
      getElementById: vi.fn(() => elementStub()),
      createElement: vi.fn(() => elementStub())
    };
    app.readPhotoConfigFromInputs = () => ({ fit: 'cover' });
    app.showToast = vi.fn();
    app.showDataPreview = vi.fn();
    app.updatePhotoInputsForCurrentRecord = vi.fn();
    app.updateNavigation = vi.fn();
    app.updateStatusBar = vi.fn();
    app.renderFilmstrip = vi.fn();
    app.tryRender = vi.fn();
    app.saveSessionDebounced = vi.fn();
    app.enrichWithRENIEC = vi.fn();
    app.mergeCSVData = vi.fn();
    app.clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    app.setFileStatus = vi.fn();
    app.setStepBadgeCompleted = vi.fn();
    app.invalidatePhotoCachesForKey = vi.fn();
    app.invalidatePreflightReport = vi.fn(() => {
      app.state.exportRevision++;
    });

    await expect(app.ingestNewPhotoPaths([path])).resolves.toBe(1);

    expect(app.state.photosMap['12345678']).toBe(path);
    expect(app.state.photoPaths['12345678']).toBe(path);
    expect(app.state.photoMeta['12345678']).toEqual({
      source: path,
      filePath: path,
      width: 600,
      height: 800,
      sourceBytes: 1234,
      sourceVersion: 'v1'
    });
    expect(app.state.photoObjectUrls).toEqual([]);
    expect(app.window.electronAPI.inspectImageFiles).toHaveBeenCalledWith([path]);
    expect(app.invalidatePhotoCachesForKey).toHaveBeenCalledWith('12345678');
    expect(app.invalidatePreflightReport).toHaveBeenCalledOnce();
    expect(app.state.exportRevision).toBe(1);

    await expect(app.ingestNewPhotoPaths([path])).resolves.toBe(0);
    expect(app.invalidatePhotoCachesForKey).toHaveBeenCalledOnce();
    expect(app.state.photoLoadGeneration).toBe(1);
  });

  it('uses the inline phases for an initial watcher scan and finishes ready', async () => {
    const app = loadClassicScripts('src/js/utils.js', 'src/js/files.js', 'src/js/watcher.js');
    const path = 'C:\\watched\\12345678 - PEREZ ANA.jpg';
    app.window = {
      electronAPI: {
        inspectImageFiles: vi
          .fn()
          .mockResolvedValue([
            { ok: true, width: 600, height: 800, sourceBytes: 1234, sourceVersion: 'v1' }
          ])
      }
    };
    app.state = {
      watchedFolderPath: 'C:\\watched',
      records: [],
      currentIndex: 0,
      photosMap: {},
      photoPaths: {},
      photoMeta: {},
      photoObjectUrls: [],
      photoImageCache: { clear: vi.fn() },
      photoFaceBoxes: {},
      globalPhotoConfig: null,
      csvRows: [],
      photosCount: 0,
      photoImportGeneration: 0,
      photoLoadGeneration: 0,
      reniecGeneration: 0
    };
    app.document = {
      getElementById: vi.fn(() => elementStub()),
      createElement: vi.fn(() => elementStub())
    };
    app.readPhotoConfigFromInputs = () => ({ fit: 'cover' });
    app.formatPhotoImportCount = String;
    app.showPhotoImportProgress = vi.fn();
    app.showPhotoImportReady = vi.fn();
    app.showPhotoImportError = vi.fn();
    app.showToast = vi.fn();
    app.showDataPreview = vi.fn();
    app.updatePhotoInputsForCurrentRecord = vi.fn();
    app.updateNavigation = vi.fn();
    app.updateStatusBar = vi.fn();
    app.renderFilmstrip = vi.fn();
    app.tryRender = vi.fn();
    app.saveSessionDebounced = vi.fn();
    app.enrichWithRENIEC = vi.fn();
    app.mergeCSVData = vi.fn();
    app.clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    app.setFileStatus = vi.fn();
    app.setStepBadgeCompleted = vi.fn();
    app.invalidatePhotoCachesForKey = vi.fn();
    app.invalidatePreflightReport = vi.fn();

    await expect(
      app.ingestNewPhotoPaths([path], true, 0, 'C:\\watched', { showImportStatus: true })
    ).resolves.toBe(1);

    expect(app.showPhotoImportProgress).toHaveBeenNthCalledWith(
      1,
      'Inspeccionando carpeta vinculada',
      '1 foto encontrada',
      20
    );
    expect(app.showPhotoImportProgress).toHaveBeenNthCalledWith(
      2,
      'Preparando registros',
      '1 foto inspeccionada',
      75
    );
    expect(app.showPhotoImportReady).toHaveBeenCalledWith(1, 0);
  });
});
