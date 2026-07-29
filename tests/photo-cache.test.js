import { describe, expect, it, vi } from 'vitest';

import { loadClassicScripts } from './helpers/load-classic-scripts.js';

const DATA_URL = 'data:image/png;base64,AA==';

function loadPhotoApp({ width = 320, height = 240 } = {}) {
  const app = loadClassicScripts('src/js/state.js', 'src/js/render.js');
  let objectUrlId = 0;
  const createObjectURL = vi.fn(() => `blob:cache-${++objectUrlId}`);
  const revokeObjectURL = vi.fn();

  class FakeImage {
    constructor() {
      this.naturalWidth = width;
      this.naturalHeight = height;
      this.width = width;
      this.height = height;
      this._src = '';
    }

    get src() {
      return this._src;
    }

    set src(value) {
      this._src = value;
      if (value) queueMicrotask(() => this.onload?.());
    }
  }

  app.URL = { createObjectURL, revokeObjectURL };
  app.Blob = Blob;
  app.atob = atob;
  app.Image = FakeImage;
  app.setTimeout = setTimeout;
  app.clearTimeout = clearTimeout;
  app.window = { __TAURI__: {}, electronAPI: {} };

  return { app, createObjectURL, revokeObjectURL };
}

describe('lazy photo image caches', () => {
  it('coalesces concurrent preview reads into one native call and keeps the path immutable', async () => {
    const { app } = loadPhotoApp();
    const path = 'C:\\photos\\12345678.jpg';
    const readFileAsDataURL = vi.fn().mockResolvedValue({ ok: true, dataUrl: DATA_URL });
    app.window.electronAPI.readFileAsDataURL = readFileAsDataURL;
    app.state.photosMap['12345678'] = path;
    app.state.photoPaths['12345678'] = path;

    const [first, second] = await Promise.all([
      app.getPhotoImageByKey('12345678'),
      app.getPhotoImageByKey('12345678')
    ]);

    expect(readFileAsDataURL).toHaveBeenCalledOnce();
    expect(first).toBe(second);
    expect(app.state.photosMap['12345678']).toBe(path);
  });

  it('uses the native thumbnail endpoint for the thumbnail variant', async () => {
    const { app } = loadPhotoApp();
    const path = 'C:\\photos\\87654321.jpg';
    const readAsThumbnail = vi.fn().mockResolvedValue({ ok: true, dataUrl: DATA_URL });
    const readFileAsDataURL = vi.fn();
    app.window.electronAPI = { readAsThumbnail, readFileAsDataURL };
    app.state.photosMap['87654321'] = 'blob:browser-photo';
    app.state.photoPaths['87654321'] = path;

    await app.getPhotoImageByKey('87654321', { variant: 'thumbnail' });

    expect(readAsThumbnail).toHaveBeenCalledWith(path, 200);
    expect(readFileAsDataURL).not.toHaveBeenCalled();
  });

  it('downscales a browser thumbnail to a canvas-backed blob before caching', async () => {
    const { app, createObjectURL } = loadPhotoApp({ width: 800, height: 600 });
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: ''
      })),
      toBlob: vi.fn((callback) => callback(new Blob(['thumb'], { type: 'image/jpeg' })))
    };
    app.document.createElement = vi.fn(() => canvas);
    app.state.photosMap.browser = 'blob:browser-photo';

    const thumbnail = await app.getPhotoImageByKey('browser', { variant: 'thumbnail' });

    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 200, 150);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(thumbnail.src).toBe('blob:cache-1');
    expect(app.state.photoThumbnailCache.size).toBe(1);
  });

  it('returns an oversized browser photo intact instead of disposing it on admission', async () => {
    const { app } = loadPhotoApp({ width: 6000, height: 6000 });
    app.state.photosMap.browser = 'blob:oversized-browser-photo';

    const photo = await app.getPhotoImageByKey('browser');

    expect(photo).not.toBeNull();
    expect(photo.src).toBe('blob:oversized-browser-photo');
    expect(app.state.photoImageCache.size).toBe(0);
    expect(app.state.photoImageCache.totalBytes).toBe(0);
  });

  it('revokes cache-owned URLs without clearing images held by callers on byte-budget eviction', async () => {
    const { app, revokeObjectURL } = loadPhotoApp({ width: 4096, height: 4096 });
    app.window.electronAPI.readFileAsDataURL = vi
      .fn()
      .mockResolvedValue({ ok: true, dataUrl: DATA_URL });
    app.state.photosMap.first = 'C:\\photos\\first.jpg';
    app.state.photosMap.second = 'C:\\photos\\second.jpg';

    const first = await app.getPhotoImageByKey('first');
    await app.getPhotoImageByKey('second');

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:cache-1');
    expect(first.src).toBe('blob:cache-1');
    expect(app.state.photoImageCache.totalBytes).toBeLessThanOrEqual(
      app.state.photoImageCache.maxBytes
    );
  });

  it('invalidates only the changed key and reloads its new source version', async () => {
    const { app, revokeObjectURL } = loadPhotoApp();
    const readFileAsDataURL = vi.fn().mockResolvedValue({ ok: true, dataUrl: DATA_URL });
    app.window.electronAPI.readFileAsDataURL = readFileAsDataURL;
    app.state.photosMap.changed = 'C:\\photos\\before.jpg';

    const previous = await app.getPhotoImageByKey('changed');
    app.state.photosMap.changed = 'C:\\photos\\after.jpg';
    app.invalidatePhotoCachesForKey('changed');
    await app.getPhotoImageByKey('changed');

    expect(readFileAsDataURL).toHaveBeenNthCalledWith(1, 'C:\\photos\\before.jpg');
    expect(readFileAsDataURL).toHaveBeenNthCalledWith(2, 'C:\\photos\\after.jpg');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:cache-1');
    expect(previous.src).toBe('blob:cache-1');
    expect(app.state.photoMeta.changed.sourceVersion).toBe(2);
  });

  it('clears cache references and owned URLs without destructively clearing held images', async () => {
    const { app, revokeObjectURL } = loadPhotoApp();
    app.window.electronAPI = {
      readFileAsDataURL: vi.fn().mockResolvedValue({ ok: true, dataUrl: DATA_URL }),
      readAsThumbnail: vi.fn().mockResolvedValue({ ok: true, dataUrl: DATA_URL })
    };
    app.state.photosMap.photo = 'C:\\photos\\photo.jpg';
    app.state.photoPaths.photo = 'C:\\photos\\photo.jpg';

    const preview = await app.getPhotoImageByKey('photo');
    const thumbnail = await app.getPhotoImageByKey('photo', { variant: 'thumbnail' });
    app.clearPhotoCaches();

    expect(preview.src).toBe('blob:cache-1');
    expect(thumbnail.src).toBe('blob:cache-2');
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(app.state.photoImageCache.size).toBe(0);
    expect(app.state.photoThumbnailCache.size).toBe(0);
    expect(app.state.photoMeta).toEqual({});
    expect(app.state.photoImageInflight.size).toBe(0);
    expect(app.state.photoThumbnailInflight.size).toBe(0);
  });

  it('supports destructive source clearing for full lifecycle teardown', async () => {
    const { app, revokeObjectURL } = loadPhotoApp();
    app.window.electronAPI.readFileAsDataURL = vi
      .fn()
      .mockResolvedValue({ ok: true, dataUrl: DATA_URL });
    app.state.photosMap.photo = 'C:\\photos\\photo.jpg';

    const preview = await app.getPhotoImageByKey('photo');
    app.state.photoImageCache.clear({ destructive: true });

    expect(preview.src).toBe('');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:cache-1');
    expect(app.state.photoImageCache.size).toBe(0);
  });
});
