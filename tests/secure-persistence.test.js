import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(resolve(path), 'utf8');

describe('secure persistence wiring', () => {
  it('keeps RENIEC token plaintext out of localStorage', () => {
    const source = read('src/js/reniec.js');

    expect(source).not.toMatch(/localStorage\.setItem\(RENIEC_TOKEN_KEY/);
    expect(source).not.toMatch(/localStorage\.getItem\(RENIEC_TOKEN_KEY/);
    expect(source).toContain('window.electronAPI.setReniecToken');
  });

  it('routes official Tauri sessions through native secure commands', () => {
    const session = read('src/js/session.js');
    const bridge = read('src/js/tauri-bridge.js');

    expect(session).toContain('window.electronAPI.saveSecureSession');
    expect(session).toContain('window.electronAPI.loadSecureSession');
    expect(bridge).toContain("invoke('clear_secure_session')");
    expect(bridge).toContain("invoke('clear_backend_caches')");
  });

  it('renders both persistence choices unchecked', () => {
    const html = read('src/index.html');
    const sessionInput = html.match(/<input type="checkbox" id="session-persist"[^>]*>/)?.[0];
    const tokenInput = html.match(/<input type="checkbox" id="reniec-token-persist"[^>]*>/)?.[0];

    expect(sessionInput).toBeTruthy();
    expect(tokenInput).toBeTruthy();
    expect(sessionInput).not.toContain('checked');
    expect(tokenInput).not.toContain('checked');
  });
});
