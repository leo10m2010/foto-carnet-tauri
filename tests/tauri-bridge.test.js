import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadBridge(invoke, { document = { getElementById: vi.fn() } } = {}) {
  const window = {
    __TAURI__: { core: { invoke } },
    addEventListener: vi.fn()
  };
  const context = vm.createContext({
    console,
    document,
    window,
    setTimeout,
    fetch
  });
  new vm.Script(readFileSync('src/js/tauri-bridge.js', 'utf8')).runInContext(context);
  return window;
}

function loadDropBridge(invoke) {
  const tauriListeners = new Map();
  const domListeners = new Map();
  let activeInput = null;
  const zone = {
    querySelector: vi.fn(() => activeInput),
    classList: { add: vi.fn(), remove: vi.fn() }
  };
  const document = {
    getElementById: vi.fn(),
    elementFromPoint: vi.fn(() => ({ closest: vi.fn(() => zone) })),
    querySelectorAll: vi.fn(() => [])
  };

  class FakeFile {
    constructor(parts, name, options = {}) {
      this.name = name;
      this.type = options.type || '';
      this.size = parts.reduce((total, part) => total + (part.size || 0), 0);
    }
  }

  class FakeDataTransfer {
    constructor() {
      this.files = [];
      this.items = { add: (file) => this.files.push(file) };
    }
  }

  class FakeEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = !!options.bubbles;
    }
  }

  const window = {
    __TAURI__: {
      core: { invoke },
      event: {
        listen: vi.fn((name, callback) => {
          tauriListeners.set(name, callback);
          return Promise.resolve(() => {});
        })
      }
    },
    devicePixelRatio: 1,
    addEventListener: vi.fn((name, callback) => {
      const callbacks = domListeners.get(name) || [];
      callbacks.push(callback);
      domListeners.set(name, callbacks);
    })
  };
  const context = vm.createContext({
    console,
    DataTransfer: FakeDataTransfer,
    document,
    Event: FakeEvent,
    fetch,
    File: FakeFile,
    setTimeout,
    window
  });
  new vm.Script(readFileSync('src/js/tauri-bridge.js', 'utf8')).runInContext(context);
  domListeners.get('DOMContentLoaded').at(-1)();

  return {
    window,
    async drop(input, paths) {
      activeInput = input;
      await tauriListeners.get('tauri://drag-drop')({
        payload: { type: 'drop', paths, position: { x: 1, y: 1 } }
      });
    }
  };
}

describe('Tauri batch bridge', () => {
  it('reads 205 items in chunks of at most 100 and preserves exact result order', async () => {
    const calls = [];
    const invoke = vi.fn(async (command, { filePaths }) => {
      expect(command).toBe('read_files_batch');
      calls.push(filePaths.slice());
      return filePaths.map((filePath) => ({ ok: true, dataUrl: `data:${filePath}` }));
    });
    const window = loadBridge(invoke);
    const paths = Array.from({ length: 205 }, (_, index) => `photo-${index}`);

    const results = await window.electronAPI.readFilesBatch(paths);

    expect(calls.map((call) => call.length)).toEqual([100, 100, 5]);
    expect(calls.every((call) => call.length <= 100)).toBe(true);
    expect(results.map((result) => result.dataUrl)).toEqual(paths.map((path) => `data:${path}`));
  });

  it('routes a 1000-path photo picker directly without reading photo bytes', async () => {
    const paths = Array.from({ length: 1000 }, (_, index) => `C:\\photos\\${index}.jpg`);
    const invoke = vi.fn(async (command, args) => {
      if (command === 'pick_photo_files') return paths;
      if (command === 'inspect_image_files') {
        return args.filePaths.map((filePath) => ({
          ok: true,
          filePath,
          width: 600,
          height: 800,
          sourceBytes: 100,
          sourceVersion: 'v1',
          error: null
        }));
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const input = { id: 'input-photos-files' };
    const window = loadBridge(invoke, {
      document: { getElementById: vi.fn(() => input) }
    });
    window.handlePhotoPathSelection = vi.fn((selectedPaths) =>
      window.electronAPI.inspectImageFiles(selectedPaths)
    );

    await window.openFileInputById('input-photos-files');

    expect(window.handlePhotoPathSelection).toHaveBeenCalledOnce();
    expect(window.handlePhotoPathSelection.mock.calls[0][0]).toEqual(paths);
    expect(invoke).toHaveBeenCalledWith('inspect_image_files', { filePaths: paths });
    expect(invoke).not.toHaveBeenCalledWith('read_files_batch', expect.anything());
    expect(invoke.mock.calls.filter(([command]) => command === 'read_files_batch')).toHaveLength(0);
  });

  it('materializes only the first compatible template and data path from native drops', async () => {
    const invoke = vi.fn(async (command, { filePaths }) => {
      if (command !== 'read_files_batch') throw new Error(`unexpected command: ${command}`);
      return filePaths.map((filePath) => ({
        ok: true,
        dataUrl: `data:application/octet-stream;base64,${btoa(filePath)}`
      }));
    });
    const { drop } = loadDropBridge(invoke);
    const templateInput = { id: 'input-template', dispatchEvent: vi.fn() };
    const dataInput = { id: 'input-data', dispatchEvent: vi.fn() };

    await drop(templateInput, [
      'C:\\drop\\notes.txt',
      'C:\\drop\\first.jpg',
      'C:\\drop\\second.png'
    ]);
    await drop(dataInput, ['C:\\drop\\photo.jpg', 'C:\\drop\\first.csv', 'C:\\drop\\second.xlsx']);

    const readCalls = invoke.mock.calls.filter(([command]) => command === 'read_files_batch');
    expect(readCalls.map(([, args]) => args.filePaths)).toEqual([
      ['C:\\drop\\first.jpg'],
      ['C:\\drop\\first.csv']
    ]);
    expect(templateInput.files).toHaveLength(1);
    expect(templateInput.files[0].name).toBe('first.jpg');
    expect(dataInput.files).toHaveLength(1);
    expect(dataInput.files[0].name).toBe('first.csv');
  });

  it('keeps native photo drops path-lazy and limits them to 1000 paths', async () => {
    const invoke = vi.fn();
    const { window, drop } = loadDropBridge(invoke);
    const input = { id: 'input-photos-files', dispatchEvent: vi.fn() };
    const paths = Array.from({ length: 1005 }, (_, index) => `C:\\photos\\${index}.jpg`);
    window.handlePhotoPathSelection = vi.fn().mockResolvedValue(true);

    await drop(input, paths);

    expect(window.handlePhotoPathSelection).toHaveBeenCalledOnce();
    expect(window.handlePhotoPathSelection.mock.calls[0][0]).toEqual(paths.slice(0, 1000));
    expect(invoke).not.toHaveBeenCalled();
    expect(input.files).toBeUndefined();
  });

  it('exposes metadata-only image inspection', async () => {
    const metadata = {
      ok: true,
      filePath: 'C:\\photos\\123.jpg',
      width: 600,
      height: 800,
      sourceBytes: 12345,
      sourceVersion: 'v1',
      error: null
    };
    const invoke = vi.fn().mockResolvedValue([metadata]);
    const window = loadBridge(invoke);

    await expect(window.electronAPI.inspectImageFiles([metadata.filePath])).resolves.toEqual([
      metadata
    ]);
    expect(invoke).toHaveBeenCalledWith('inspect_image_files', { filePaths: [metadata.filePath] });
  });

  it('returns an actionable aligned error for every item in a failed chunk', async () => {
    const window = loadBridge(vi.fn().mockRejectedValue(new Error('IPC desconectado')));

    const results = await window.electronAPI.readFilesBatch(['A.jpg', 'B.jpg']);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: false, filePath: 'A.jpg' });
    expect(results[0].error).toContain('A.jpg');
    expect(results[0].error).toContain('IPC desconectado');
    expect(results[1].filePath).toBe('B.jpg');
  });
});

describe('Tauri update bridge', () => {
  it('uses the detailed command and distinguishes current, available, and error', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, update: null, error: null })
      .mockResolvedValueOnce({
        ok: true,
        update: { version: '2.0.0', url: 'https://example.test/release' },
        error: null
      })
      .mockResolvedValueOnce({ ok: false, update: null, error: { message: 'sin red' } });
    const window = loadBridge(invoke);
    const updateCallback = vi.fn();
    window.electronAPI.onUpdateAvailable(updateCallback);

    await expect(window.electronAPI.checkForUpdates()).resolves.toEqual({ status: 'current' });
    await expect(window.electronAPI.checkForUpdates()).resolves.toMatchObject({
      status: 'available',
      update: { version: '2.0.0' }
    });
    await expect(window.electronAPI.checkForUpdates()).resolves.toEqual({
      status: 'error',
      error: 'sin red'
    });
    expect(updateCallback).toHaveBeenCalledWith({
      version: '2.0.0',
      url: 'https://example.test/release'
    });
    expect(invoke).toHaveBeenCalledWith('check_for_updates_detailed');
  });
});
