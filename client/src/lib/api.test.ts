import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadMedia, MAX_DOWNLOAD_BYTES, resolveMedia, validateMediaUrl,
  type ResolvedMedia,
} from './api';

const source = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const media: ResolvedMedia = {
  id: 'an-opaque-media-token', title: 'Flower', platform: 'direct', kind: 'video',
  formats: [{ id: 'original', label: 'Original quality', extension: 'mp4', mimeType: 'video/mp4' }],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('media input boundaries', () => {
  it.each([
    ['', 'EMPTY_URL'],
    ['not a URL', 'INVALID_URL'],
    ['javascript:alert(1)', 'INVALID_URL'],
    ['http://example.com/image.jpg', 'INVALID_URL'],
    ['https://name:secret@example.com/photo.jpg', 'INVALID_URL'],
  ])('rejects unsafe or incomplete input before any request: %s', async (value, code) => {
    await expect(resolveMedia(value)).rejects.toMatchObject({ code });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves signed query strings while trimming pasted whitespace', () => {
    expect(validateMediaUrl('  https://cdn.example.com/video.mp4?token=a%2Fb&v=2  '))
      .toBe('https://cdn.example.com/video.mp4?token=a%2Fb&v=2');
  });
});

describe('resolver failures', () => {
  it('shows an actionable platform restriction supplied by the backend', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'PLATFORM_RESTRICTED', message: 'This platform requires an authorized API integration.' } }), { status: 422, headers: { 'Content-Type': 'application/json' } }));
    await expect(resolveMedia(source)).rejects.toMatchObject({ code: 'PLATFORM_RESTRICTED', status: 422, message: 'This platform requires an authorized API integration.' });
  });

  it('does not expose a host error page and explains a missing API', async () => {
    fetchMock.mockResolvedValue(new Response('<h1>nginx: internal host detail</h1>', { status: 404 }));
    await expect(resolveMedia(source)).rejects.toMatchObject({ message: expect.stringContaining('media service is unavailable') });
  });

  it.each([null, { ...media, formats: [null] }, { ...media, title: { unexpected: 'object' } }])('rejects malformed success data without rendering it', async (payload) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));
    await expect(resolveMedia(source)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('turns network failure into a useful connection message', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(resolveMedia(source)).rejects.toMatchObject({ code: 'CONNECTION_ERROR', message: expect.stringContaining('Check your connection') });
  });
});

describe('bounded downloads and cancellation', () => {
  it('saves the actual received bytes with a safe server filename and releases the temporary URL', async () => {
    vi.useFakeTimers();
    const OriginalURL = URL;
    const createObjectURL = vi.fn(() => 'blob:mediaflow-download');
    const revokeObjectURL = vi.fn();
    class DownloadURL extends OriginalURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal('URL', DownloadURL);
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    fetchMock.mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': `${bytes.length}`, 'Content-Disposition': 'attachment; filename="flower.mp4"' } }));
    const progress = vi.fn();
    await expect(downloadMedia(media, media.formats[0], new AbortController().signal, progress)).resolves.toBe('flower.mp4');
    expect(save).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ size: bytes.length, type: 'video/mp4' }));
    expect(progress).toHaveBeenLastCalledWith({ received: bytes.length, total: bytes.length });
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mediaflow-download');
  });

  it('rejects oversized declared files before reading the body', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const getReader = vi.fn();
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Length': `${MAX_DOWNLOAD_BYTES + 1}` }), body: { cancel, getReader } } as unknown as Response);
    await expect(downloadMedia(media, media.formats[0], new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
  });

  it('enforces the same limit for streamed responses with no Content-Length', async () => {
    const reader = {
      // Only byteLength is read before rejecting, avoiding a 100 MB test allocation.
      read: vi.fn().mockResolvedValue({ done: false, value: { byteLength: MAX_DOWNLOAD_BYTES + 1 } }),
      cancel: vi.fn().mockResolvedValue(undefined), releaseLock: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'video/mp4' }), body: { getReader: () => reader } } as unknown as Response);
    await expect(downloadMedia(media, media.formats[0], new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('preserves cancellation during a response stream and releases its reader', async () => {
    const controller = new AbortController();
    let signalReading!: () => void;
    const reading = new Promise<void>((resolve) => { signalReading = resolve; });
    const reader = {
      read: vi.fn().mockImplementation(() => new Promise((_, reject) => {
        signalReading();
        controller.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
      })),
      releaseLock: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'video/mp4' }), body: { getReader: () => reader } } as unknown as Response);
    const download = downloadMedia(media, media.formats[0], controller.signal, vi.fn());
    await reading;
    controller.abort();
    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('does not turn a cancelled resolver request into a misleading network error', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    const resolving = resolveMedia(source, controller.signal);
    controller.abort();
    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
  });
});
