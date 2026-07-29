import { describe, expect, it, vi } from 'vitest';

import { loadClassicScripts } from './helpers/load-classic-scripts.js';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
    value: (key) => values.get(key) ?? null
  };
}

function loadSession({ storage, saveSecureSession, clearSecureSession = vi.fn() }) {
  const app = loadClassicScripts('src/js/session.js');
  const persistInput = { checked: false, dataset: {}, addEventListener: vi.fn() };
  const detail = { textContent: '' };
  app.localStorage = storage;
  app.window = {
    __TAURI__: {},
    electronAPI: { saveSecureSession, clearSecureSession }
  };
  app.document = {
    getElementById: vi.fn((id) => {
      if (id === 'session-persist') return persistInput;
      if (id === 'session-persistence-detail') return detail;
      return null;
    })
  };
  app.showToast = vi.fn();
  return { app, persistInput, detail };
}

function configureSessionState(app) {
  app.state = {
    records: [{ dni: '12345678' }],
    currentIndex: 0,
    templatePath: null,
    templateDataUrl: null,
    templateFileName: '',
    templateImage: null,
    photoPaths: {},
    photoOverrides: {},
    globalPhotoConfig: null,
    csvRows: [],
    csvFileName: '',
    watchedFolderPath: null
  };
  app.ensureRecordIdentities = vi.fn();
  app.getRecordIdentity = (record) => record.dni;
  app.readTrackedInputState = () => ({});
}

describe('legacy session migration', () => {
  const legacy = JSON.stringify({
    v: 2,
    savedAt: Date.now(),
    records: [{ dni: '12345678' }],
    templateDataUrl: 'data:image/png;base64,AA=='
  });

  it('enables persistence and removes plaintext only after encrypted storage succeeds', async () => {
    const storage = createStorage({ fotocarnet_session_v2: legacy });
    const saveSecureSession = vi.fn().mockResolvedValue(undefined);
    const { app, persistInput } = loadSession({ storage, saveSecureSession });

    await app.initializeSessionPersistence();

    expect(saveSecureSession).toHaveBeenCalledWith(legacy);
    expect(storage.value('fotocarnet_session_v2')).toBeNull();
    expect(storage.value('fotocarnet_session_persist')).toBe('true');
    expect(persistInput.checked).toBe(true);
  });

  it('preserves plaintext and leaves fresh opt-in disabled when secure migration fails', async () => {
    const storage = createStorage({ fotocarnet_session_v2: legacy });
    const saveSecureSession = vi.fn().mockRejectedValue(new Error('credential store unavailable'));
    const { app, persistInput } = loadSession({ storage, saveSecureSession });

    await app.initializeSessionPersistence();

    expect(storage.value('fotocarnet_session_v2')).toBe(legacy);
    expect(storage.value('fotocarnet_session_persist')).toBeNull();
    expect(persistInput.checked).toBe(false);
  });
});

describe('session photo validation', () => {
  it('restores path metadata without creating data or object URLs', async () => {
    const app = loadClassicScripts('src/js/session.js');
    app.state = {
      photoLoadGeneration: 1,
      lifecycleGeneration: 1,
      photosMap: { 12345678: 'C:\\photos\\12345678.jpg' },
      photoPaths: { 12345678: 'C:\\photos\\12345678.jpg' },
      photoMeta: {},
      photoObjectUrls: [],
      records: [{ dni: '12345678', hasPhoto: true }]
    };
    app.window = {
      electronAPI: {
        inspectImageFiles: vi.fn().mockResolvedValue([
          {
            ok: true,
            filePath: 'C:\\photos\\12345678.jpg',
            width: 600,
            height: 800,
            sourceBytes: 24000,
            sourceVersion: 'v1',
            error: null
          }
        ]),
        readFilesBatch: vi.fn()
      }
    };
    app.getRecordKey = (record) => record.dni;

    await app._preloadSessionPhotos(1, 1);

    expect(app.state.photoPaths['12345678']).toBe('C:\\photos\\12345678.jpg');
    expect(app.state.photosMap['12345678']).toBe('C:\\photos\\12345678.jpg');
    expect(app.state.photoMeta['12345678']).toEqual({
      source: 'C:\\photos\\12345678.jpg',
      filePath: 'C:\\photos\\12345678.jpg',
      width: 600,
      height: 800,
      sourceBytes: 24000,
      sourceVersion: 'v1'
    });
    expect(app.state.photoObjectUrls).toEqual([]);
    expect(app.state.records[0].hasPhoto).toBe(true);
    expect(app.window.electronAPI.readFilesBatch).not.toHaveBeenCalled();
  });
});

describe('session save activation', () => {
  it('returns failure and reverts opt-in UI and preference when initial secure storage fails', async () => {
    const storage = createStorage({ fotocarnet_session_persist: 'false' });
    const saveSecureSession = vi.fn().mockRejectedValue(new Error('disk full'));
    const { app, persistInput } = loadSession({
      storage,
      saveSecureSession,
      clearSecureSession: vi.fn().mockResolvedValue(undefined)
    });
    configureSessionState(app);
    await app.initializeSessionPersistence();
    const changeHandler = persistInput.addEventListener.mock.calls.find(
      ([name]) => name === 'change'
    )[1];
    persistInput.checked = true;

    await changeHandler();

    expect(saveSecureSession).toHaveBeenCalledOnce();
    expect(persistInput.checked).toBe(false);
    expect(storage.value('fotocarnet_session_persist')).toBe('false');
    expect(app.showToast).not.toHaveBeenCalledWith('Guardado seguro de sesión activado', 'info');
  });

  it('flush waits for an already queued native storage operation', async () => {
    const app = loadClassicScripts('src/js/session.js');
    let resolveNativeSave;
    const pendingNativeSave = new Promise((resolve) => {
      resolveNativeSave = resolve;
    });
    app.window = { __TAURI__: {} };
    app.state = { records: [] };
    app.queueSessionStorageOperation(() => pendingNativeSave);
    let flushed = false;

    const flush = app.flushPendingSessionSave().then(() => {
      flushed = true;
    });
    await Promise.resolve();

    expect(flushed).toBe(false);
    resolveNativeSave();
    await flush;
    expect(flushed).toBe(true);
  });
});
