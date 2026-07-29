import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { loadClassicScripts } from './helpers/load-classic-scripts.js';

describe('accessibility DOM contract', () => {
  const html = readFileSync('src/index.html', 'utf8');

  it('exposes upload zones and section headers to the keyboard', () => {
    expect(html.match(/class="upload-zone"[^>]*role="button"[^>]*tabindex="0"/g)).toHaveLength(3);
    expect(
      html.match(/class="section-header"[^>]*role="button"[^>]*tabindex="0"[^>]*aria-expanded=/g)
    ).toHaveLength(7);
  });

  it('labels the editor, dialogs, and progress indicator', () => {
    expect(html).toContain('id="carnet-canvas" style="display:none;" role="group" tabindex="0"');
    expect(html).toContain('id="modal-loading" role="dialog" aria-modal="true"');
    expect(html).toContain('id="modal-help" data-help-overlay role="dialog" aria-modal="true"');
    expect(html).toContain('id="modal-progress" role="progressbar"');
    expect(html).toContain('id="photo-import-status" class="photo-import-status" role="status"');
    expect(html).toContain(
      'id="photo-import-progress" class="photo-import-progress" role="progressbar"'
    );
    expect(html).toMatch(
      /id="photo-import-cancel"[^>]*data-photo-import-cancel[^>]*aria-label="Cancelar importación de fotos"/
    );
    expect(html).toMatch(/id="hud-photo-zoom"[^>]*aria-label="Zoom de la foto"/);
  });
});

describe('section accessibility synchronization', () => {
  it('keeps expanded, hidden, and inert state aligned', () => {
    const app = loadClassicScripts('src/js/config.js');
    const attributes = new Map();
    const body = {
      id: 'section-test-body',
      inert: false,
      setAttribute: (name, value) => attributes.set(name, value)
    };
    const section = {
      classList: { contains: vi.fn(() => true) },
      querySelector: vi.fn(() => body)
    };
    const header = {
      dataset: { toggleSection: 'section-test' },
      setAttribute: (name, value) => attributes.set(`header:${name}`, value)
    };
    app.document = { getElementById: vi.fn(() => section) };

    app.syncSectionAccessibility(header);

    expect(attributes.get('header:aria-expanded')).toBe('false');
    expect(attributes.get('header:aria-controls')).toBe('section-test-body');
    expect(attributes.get('aria-hidden')).toBe('true');
    expect(body.inert).toBe(true);
  });
});

describe('filmstrip keyboard navigation', () => {
  it('supports arrow, Home, and End navigation with focus movement', () => {
    const app = loadClassicScripts('src/js/filmstrip.js');
    const focus = vi.fn();
    app.state = { records: [{}, {}, {}], currentIndex: 1 };
    app.navigateRecord = (delta) => {
      app.state.currentIndex += delta;
    };
    app.document = {
      getElementById: () => ({ children: [{ focus }, { focus }, { focus }] })
    };
    const event = { key: 'End', preventDefault: vi.fn(), stopPropagation: vi.fn() };

    app.handleFilmstripKeydown(event, 1);

    expect(app.state.currentIndex).toBe(2);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });
});
