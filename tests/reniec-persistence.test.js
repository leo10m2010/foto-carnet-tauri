import { describe, expect, it, vi } from 'vitest';

import { loadClassicScripts } from './helpers/load-classic-scripts.js';

describe('RENIEC credential deletion', () => {
  it('keeps the token and reports no success when native deletion fails', async () => {
    const app = loadClassicScripts('src/js/reniec.js');
    const tokenInput = { value: '' };
    const persistInput = { checked: false };
    const elements = {
      'field-reniec-token': tokenInput,
      'reniec-token-persist': persistInput,
      'reniec-token-status': { innerHTML: '' },
      'badge-reniec': { style: {} },
      'reniec-test-result': { innerHTML: '' },
      'btn-test-reniec': { disabled: false, textContent: '' }
    };
    app.localStorage = {
      getItem: vi.fn((key) => (key === 'fotocarnet_reniec_token_persist' ? 'true' : null)),
      setItem: vi.fn(),
      removeItem: vi.fn()
    };
    app.window = {
      __TAURI__: {},
      electronAPI: {
        getReniecToken: vi.fn().mockResolvedValue('secret-token'),
        clearReniecToken: vi.fn().mockRejectedValue(new Error('credential locked'))
      }
    };
    app.document = { getElementById: (id) => elements[id] || null };
    app.clearTimeout = clearTimeout;
    app.showToast = vi.fn();
    app.iconTextHtml = () => '';
    await app.initializeReniecTokenPersistence();

    const result = await app.clearReniecToken();

    expect(result).toBe(false);
    expect(tokenInput.value).toBe('secret-token');
    expect(app.getReniecToken()).toBe('secret-token');
    expect(app.showToast).toHaveBeenCalledWith(
      'No se pudo eliminar el token RENIEC guardado',
      'error'
    );
    expect(app.showToast).not.toHaveBeenCalledWith('Token RENIEC eliminado', 'info');
  });
});

describe('RENIEC export revision', () => {
  it('invalidates the active export snapshot before applying verified names', async () => {
    const app = loadClassicScripts('src/js/reniec.js');
    const record = { dni: '12345678', nombres: 'ANA', apellidos: 'PEREZ' };
    app.state = {
      records: [record],
      photoPaths: { 12345678: 'C:\\photos\\12345678.jpg' },
      photosMap: {},
      reniecGeneration: 0,
      exportRevision: 0
    };
    app.window = {
      electronAPI: {
        queryRENIEC: vi.fn().mockResolvedValue({
          ok: true,
          body: {
            success: true,
            nombres: 'MARIA',
            apellidoPaterno: 'GOMEZ',
            apellidoMaterno: 'DIAZ'
          }
        })
      }
    };
    app.document = {
      getElementById: vi.fn((id) => (id === 'field-reniec-token' ? { value: 'token' } : null))
    };
    app.getRecordKey = (value) => value?.dni || '';
    app.invalidatePreflightReport = vi.fn(() => {
      app.state.exportRevision++;
    });
    app.showToast = vi.fn();
    app.showDataPreview = vi.fn();
    app.tryRender = vi.fn();
    app.updateStatusBar = vi.fn();
    app.updateFilmstripTooltips = vi.fn();
    app.saveSession = vi.fn();

    await app.enrichWithRENIEC();

    expect(app.invalidatePreflightReport).toHaveBeenCalledOnce();
    expect(app.state.exportRevision).toBe(1);
    expect(record.nombres).toBe('MARIA');
    expect(record.apellidos).toBe('GOMEZ DIAZ');
  });
});
