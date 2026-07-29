import { describe, expect, it } from 'vitest';

import { loadClassicScripts } from './helpers/load-classic-scripts.js';

const utils = loadClassicScripts('src/js/utils.js');

describe('DNI normalization', () => {
  it.each([
    [null, ''],
    ['', ''],
    ['1234567', '01234567'],
    [' 12.345.678 ', '12345678'],
    ['123456789', '123456789'],
    ['sin dni', 'SIN DNI']
  ])('normalizes %j to %j', (input, expected) => {
    expect(utils.normalizeDNI(input)).toBe(expected);
  });
});

describe('input normalization and sanitization', () => {
  it('normalizes short colors and rejects malformed colors', () => {
    expect(utils.normalizeHexColor(' #AbC ')).toBe('#aabbcc');
    expect(utils.normalizeHexColor('#ABCDEF')).toBe('#abcdef');
    expect(utils.normalizeHexColor('red', '#000000')).toBe('#000000');
  });

  it('bounds photo configuration and restricts fit modes', () => {
    expect({ ...utils.normalizePhotoConfig({ x: -2, w: 4, fit: 'fill', scale: 99 }) }).toEqual({
      x: 0,
      y: 0,
      w: 20,
      h: 20,
      fit: 'cover',
      scale: 5,
      offsetX: 0,
      offsetY: 0,
      bgEnabled: false,
      bgColor: '#d9dee8',
      rotation: 0
    });
  });

  it('escapes all characters that can break an HTML attribute', () => {
    expect(utils.escapeHtmlAttr(`a&<b>\"'`)).toBe('a&amp;&lt;b&gt;&quot;&#39;');
    expect(utils.iconHtml('x\" onload=\"bad', 'a<b', 'quoted \"label\"')).not.toContain(
      ' onload="bad"'
    );
  });
});
