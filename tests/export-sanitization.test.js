import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadClassicScripts } from './helpers/load-classic-scripts.js';

const app = loadClassicScripts('src/js/export.js');

function setupExportState(recordCount = 1, sourceForKey = (key) => `C:\\photos\\${key}.jpg`) {
  const records = Array.from({ length: recordCount }, (_, index) => ({
    dni: String(index + 1).padStart(8, '0'),
    nombres: `Nombre ${index + 1}`,
    apellidos: 'Prueba',
    hasPhoto: true
  }));
  const photosMap = {};
  const photoPaths = {};
  const photoMeta = {};

  records.forEach((record) => {
    const source = sourceForKey(record.dni);
    photosMap[record.dni] = source;
    if (!source.startsWith('blob:') && !source.startsWith('data:')) photoPaths[record.dni] = source;
    photoMeta[record.dni] = { width: 1200, height: 1600 };
  });

  app.state = {
    records,
    currentIndex: 0,
    templateImage: { width: 540, height: 850 },
    photosMap,
    photoPaths,
    photoMeta,
    photoOverrides: {},
    globalPhotoConfig: null,
    preflightReport: null,
    exportRevision: 0,
    job: { active: false, cancelRequested: false, label: '' }
  };
  app.clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  app.getRecordKey = (record) => record?.dni || '';
  app.getPhotoConfigForRecord = () => ({ w: 200, h: 300, fit: 'cover', scale: 1 });
  app.validateBarcodeValue = () => '';
  app.renderPreflightReport = vi.fn();
  app.showToast = vi.fn();
  app.setTimeout = setTimeout;
  app.JSON = JSON;
  app.document.getElementById = (id) => ({
    value: id === 'export-dpi' ? '300' : id === 'pdf-width-cm' ? '5.4' : '8.5'
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('export filename sanitization', () => {
  it('removes Windows-reserved characters and control characters', () => {
    expect(app.sanitizeFileComponent('  Ana: Perez/Lopez?\u0000  ')).toBe('Ana_Perez_Lopez');
  });

  it('uses a fallback for an empty component and limits length', () => {
    expect(app.sanitizeFileComponent('***', 'carnet')).toBe('carnet');
    expect(app.sanitizeFileComponent('a'.repeat(200))).toHaveLength(120);
  });
});

describe('print HTML byte budgeting', () => {
  it('counts UTF-8 bytes rather than JavaScript characters', () => {
    expect(app.utf8ByteLength('Carnets — Perú')).toBe(17);
  });

  it('reserves prefix and suffix and rejects additions before the limit', () => {
    const budget = app.createPrintHtmlBudget('é', '</html>', 12);

    expect(budget.usedBytes).toBe(9);
    expect(app.reservePrintHtmlBytes(budget, 'abc')).toBe(true);
    expect(budget.usedBytes).toBe(12);
    expect(app.reservePrintHtmlBytes(budget, 'x')).toBe(false);
    expect(budget.usedBytes).toBe(12);
  });
});

describe('export progress accounting', () => {
  it('advances completed units only within the rendering portion', () => {
    setupExportState();

    expect(app.completedUnitsProgress(0, 4, 5, 80)).toBe(5);
    expect(app.completedUnitsProgress(1, 4, 5, 80)).toBe(23.75);
    expect(app.completedUnitsProgress(4, 4, 5, 80)).toBe(80);
    expect(app.completedUnitsProgress(5, 4, 5, 80)).toBe(80);
  });
});

describe('large-session export state checks', () => {
  it('preflights 1000 path-backed photos from metadata without loading images', async () => {
    setupExportState(1000);
    app.getPhotoImageByKey = vi.fn();
    const snapshot = app.createExportSnapshot();

    const report = await app.runPreflightCheck({ silent: true, snapshot });

    expect(report.total).toBe(1000);
    expect(report.missingPhotos).toHaveLength(0);
    expect(app.getPhotoImageByKey).not.toHaveBeenCalled();
  });

  it('still loads browser-backed photos even when metadata exists', async () => {
    setupExportState(1, () => 'blob:test-photo');
    app.getPhotoImageByKey = vi.fn().mockResolvedValue({ naturalWidth: 1200, naturalHeight: 1600 });

    await app.runPreflightCheck({ silent: true, snapshot: app.createExportSnapshot() });

    expect(app.getPhotoImageByKey).toHaveBeenCalledTimes(1);
  });

  it('asserts snapshots repeatedly without stringifying whole state', () => {
    setupExportState(1000);
    const snapshot = app.createExportSnapshot();
    const stringify = vi.fn(JSON.stringify);
    app.JSON = { stringify };
    const jobId = app.beginJob('snapshot-test');

    for (let i = 0; i < 5000; i++) app.assertExportSnapshot(snapshot, jobId);

    expect(stringify).not.toHaveBeenCalled();
    app.endJob(jobId);
  });

  it('invalidates snapshots through the monotonic export revision', () => {
    setupExportState();
    const snapshot = app.createExportSnapshot();
    const jobId = app.beginJob('snapshot-test');

    app.invalidatePreflightReport();

    expect(app.state.exportRevision).toBe(1);
    expect(() => app.assertExportSnapshot(snapshot, jobId)).toThrow(/datos cambiaron/i);
    app.endJob(jobId);
  });

  it('blocks a lazy export render when its full-quality photo cannot be loaded', async () => {
    setupExportState();
    app.getPhotoImageByKey = vi.fn().mockResolvedValue(null);
    app.renderCarnet = vi.fn();
    const snapshot = app.createExportSnapshot();
    const jobId = app.beginJob('missing-photo');

    await expect(app.renderCarnetAtPhysicalSize(0, 5.4, 8.5, 300, snapshot, jobId)).rejects.toThrow(
      /calidad completa.*00000001.*archivo exista/i
    );
    expect(app.getPhotoImageByKey).toHaveBeenCalledWith('00000001', { variant: 'preview' });
    expect(app.renderCarnet).not.toHaveBeenCalled();
    app.endJob(jobId);
  });

  it('rechecks the snapshot after the save dialog and before writing output', async () => {
    setupExportState();
    const saveFile = vi.fn();
    app.window = {
      electronAPI: {
        pickSavePath: vi.fn().mockResolvedValue('C:\\exports\\carnet.png'),
        saveFile
      }
    };
    const stale = new Error('Los datos cambiaron durante la operación');

    await expect(
      app.downloadBlob({}, 'carnet.png', () => {
        throw stale;
      })
    ).rejects.toBe(stale);
    expect(saveFile).not.toHaveBeenCalled();
  });
});
