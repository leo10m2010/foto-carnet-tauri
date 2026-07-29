import { describe, expect, it } from 'vitest';

import { loadClassicScripts } from './helpers/load-classic-scripts.js';

// Match index.html: files.js intentionally replaces data.js' upload handler.
const app = loadClassicScripts('src/js/utils.js', 'src/js/data.js', 'src/js/files.js');
const plain = (value) => JSON.parse(JSON.stringify(value));

describe('photo filename parsing', () => {
  it.each([
    [
      '12345678 - PEREZ GOMEZ ANA MARIA.jpg.jpg',
      { dni: '12345678', dniKey: '12345678', apellidos: 'PEREZ GOMEZ', nombres: 'ANA MARIA' }
    ],
    [
      'PEREZ_GOMEZ_ANA - 1234567.png',
      { dni: '1234567', dniKey: '01234567', apellidos: 'PEREZ GOMEZ', nombres: 'ANA' }
    ],
    [
      '12345678 PEREZ GOMEZ ANA.webp',
      { dni: '12345678', dniKey: '12345678', apellidos: 'PEREZ GOMEZ', nombres: 'ANA' }
    ],
    [
      'PEREZ GOMEZ ANA 12345678.jpeg',
      { dni: '12345678', dniKey: '12345678', apellidos: 'PEREZ GOMEZ', nombres: 'ANA' }
    ],
    ['12345678.bmp', { dni: '12345678', dniKey: '12345678', apellidos: '', nombres: '' }]
  ])('parses %s', (filename, expected) => {
    expect(plain(app.parsePhotoFilename(filename))).toEqual(expected);
  });

  it('keeps a name-only file usable as a record', () => {
    expect(plain(app.parsePhotoFilename('Perez Gomez Ana.jpg'))).toEqual({
      dni: 'Perez Gomez Ana',
      dniKey: 'PEREZ GOMEZ ANA',
      apellidos: 'Perez Gomez',
      nombres: 'Ana'
    });
  });
});

describe('spreadsheet column detection', () => {
  const rows = [
    { Nombre: 'Ana', Documento: '12345678', Cargo: 'Docente' },
    { Nombre: 'Luis', Documento: '87654321', Cargo: 'Director' },
    { Nombre: 'Eva', Documento: '', Cargo: 'Apoyo' }
  ];

  it('uses content to validate the DNI column', () => {
    expect(app.dniLikeRatio(rows, 'Documento')).toBeCloseTo(2 / 3);
    expect(app.autoDetectDNIColumn(Object.keys(rows[0]), rows)).toBe('Documento');
  });

  it('detects common extra-data columns', () => {
    expect(app.autoDetectExtraColumn(Object.keys(rows[0]))).toBe('Cargo');
  });

  it('falls back to the column with DNI-like values', () => {
    const uncommonRows = [
      { Persona: 'Ana', Codigo: '12345678' },
      { Persona: 'Eva', Codigo: '23456789' }
    ];
    expect(app.autoDetectDNIColumn(['Persona', 'Codigo'], uncommonRows)).toBe('Codigo');
  });

  it('keeps duplicate diagnostics in the effective upload handler', () => {
    expect(String(app.handleDataUpload)).toContain('reportDuplicateCSVKeys(dniCol)');
  });
});
