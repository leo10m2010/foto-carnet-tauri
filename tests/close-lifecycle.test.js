import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('Tauri close lifecycle', () => {
  it('prevents close, awaits the queued save, and destroys exactly once', async () => {
    let closeHandler;
    let resolveSave;
    const pendingSave = new Promise((resolve) => {
      resolveSave = resolve;
    });
    const appWindow = {
      onCloseRequested: vi.fn((handler) => {
        closeHandler = handler;
        return Promise.resolve(vi.fn());
      }),
      destroy: vi.fn().mockResolvedValue(undefined)
    };
    const document = { addEventListener: vi.fn() };
    const window = {
      __TAURI__: { window: { getCurrentWindow: () => appWindow } },
      addEventListener: vi.fn()
    };
    const context = vm.createContext({ console, document, window });
    new vm.Script(readFileSync('src/js/init.js', 'utf8')).runInContext(context);
    context.flushPendingSessionSave = vi.fn(() => pendingSave);
    context.revokePhotoObjectUrls = vi.fn();
    context.clearPhotoCaches = vi.fn();
    context.setupTauriCloseRequestHandling();
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    const firstClose = closeHandler(firstEvent);
    const secondClose = closeHandler(secondEvent);
    await Promise.resolve();

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(context.flushPendingSessionSave).toHaveBeenCalledOnce();
    expect(appWindow.destroy).not.toHaveBeenCalled();

    resolveSave();
    await Promise.all([firstClose, secondClose]);

    expect(appWindow.destroy).toHaveBeenCalledOnce();
    expect(context.clearPhotoCaches).toHaveBeenCalledOnce();
    expect(context.revokePhotoObjectUrls).toHaveBeenCalledOnce();
  });
});
