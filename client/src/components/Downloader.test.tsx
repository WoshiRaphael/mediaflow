import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Downloader from './Downloader';
import { downloadMedia, resolveMedia, type DownloadProgress, type ResolvedMedia } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, resolveMedia: vi.fn(), downloadMedia: vi.fn() };
});

const resolveMock = vi.mocked(resolveMedia);
const sample: ResolvedMedia = {
  id: 'public-domain-sample', title: 'Flower', platform: 'direct', kind: 'video',
  formats: [{ id: 'original', label: 'Original quality', extension: 'mp4', mimeType: 'video/mp4', size: 1128375 }],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

beforeEach(() => {
  resolveMock.mockReset();
  vi.mocked(downloadMedia).mockReset();
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockImplementation((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('downloader interaction', () => {
  it('downloads the chosen returned format and clearly marks a video-only stream', async () => {
    resolveMock.mockResolvedValue({
      ...sample, platform: 'youtube', title: 'A public creator video',
      formats: [
        { id: 'combined-720', label: '720p MP4', extension: 'mp4', mimeType: 'video/mp4', hasAudio: true },
        { id: 'video-1080', label: '1080p WebM', extension: 'webm', mimeType: 'video/webm', hasAudio: false },
      ],
    });
    vi.mocked(downloadMedia).mockResolvedValue('creator-video.webm');
    render(<Downloader />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://www.youtube.com/watch?v=public-example' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Media downloader' }));
    expect(await screen.findByRole('heading', { name: 'A public creator video' })).toBeTruthy();
    expect(screen.getByText('YouTube')).toBeTruthy();
    expect(screen.getByText('2 available formats')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Available formats' }), { target: { value: 'video-1080' } });
    expect(screen.getByText('Video only · this format has no audio track.')).toBeTruthy();
    expect(screen.getByLabelText('Video preview: A public creator video').getAttribute('src')).toContain('format=video-1080');
    fireEvent.click(screen.getByRole('button', { name: 'Download WEBM' }));
    await waitFor(() => expect(downloadMedia).toHaveBeenCalledWith(expect.objectContaining({ platform: 'youtube' }), expect.objectContaining({ id: 'video-1080', hasAudio: false }), expect.any(AbortSignal), expect.any(Function)));
  });

  it('prepares public-page video only on user action and switches to real transfer progress', async () => {
    resolveMock.mockResolvedValue({ ...sample, platform: 'archiveorg', title: 'Big Buck Bunny' });
    let report!: (progress: DownloadProgress) => void;
    let finish!: (filename: string) => void;
    vi.mocked(downloadMedia).mockImplementation((_, __, ___, onProgress) => {
      report = onProgress;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    render(<Downloader />);
    fireEvent.click(screen.getByRole('button', { name: /Try a sample/ }));
    const preview = await screen.findByLabelText('Video preview: Big Buck Bunny');
    expect(preview.getAttribute('preload')).toBe('none');
    expect(downloadMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download MP4' }));
    expect(await screen.findByRole('button', { name: 'Preparing video…' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Preparing video' }).getAttribute('aria-valuenow')).toBeNull();
    act(() => report({ received: 2048, total: 4096 }));
    expect(screen.getByRole('button', { name: 'Downloading…' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Downloading media' }).getAttribute('aria-valuenow')).toBe('50');
    await act(async () => finish('big-buck-bunny.mp4'));
    expect(screen.getByRole('button', { name: 'Download again' })).toBeTruthy();
  });

  it('guides an empty submission without contacting the media service', async () => {
    render(<Downloader />);
    fireEvent.submit(screen.getByRole('form', { name: 'Media downloader' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Paste a public image or video link'));
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('keeps clipboard denial recoverable and focuses manual entry', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')) } });
    render(<Downloader />);
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('Paste your link into the field'));
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('rejects a six-link batch before making requests', async () => {
    render(<Downloader />);
    fireEvent.click(screen.getByRole('button', { name: /Batch links/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: Array.from({ length: 6 }, (_, index) => `https://media.w3.org/${index}.mp4`).join('\n') } });
    fireEvent.click(screen.getByRole('button', { name: 'Find all media' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('up to 5 unique links'));
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('explains a backend error and lets a retry resolve the same real URL', async () => {
    resolveMock.mockRejectedValueOnce(new Error('This source is not in the approved media domain list.')).mockResolvedValueOnce(sample);
    render(<Downloader />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://example.com/flower.mp4' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Media downloader' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('approved media domain list'));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Flower' })).toBeTruthy();
    expect(resolveMock).toHaveBeenCalledTimes(2);
    expect(resolveMock.mock.calls[1][0]).toBe('https://example.com/flower.mp4');
  });

  it('requests a real video-page sample and shows attribution and only returned quality options', async () => {
    resolveMock.mockResolvedValue({ ...sample, title: 'Big Buck Bunny', platform: 'archiveorg' });
    render(<Downloader />);
    fireEvent.click(screen.getByRole('button', { name: /Try a sample/ }));
    expect(await screen.findByRole('heading', { name: 'Big Buck Bunny' })).toBeTruthy();
    expect(resolveMock).toHaveBeenCalledWith('https://archive.org/details/BigBuckBunny_328', expect.any(AbortSignal));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Original quality']);
    expect(screen.getByText(/Real page sample · Big Buck Bunny/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /CC BY 3.0/ }).getAttribute('href')).toBe('https://creativecommons.org/licenses/by/3.0/');
    expect(screen.getByRole('button', { name: 'Download MP4' })).toBeTruthy();
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('continues a batch after a source error and never downloads files automatically', async () => {
    resolveMock.mockRejectedValueOnce(new Error('First source is restricted.')).mockResolvedValueOnce(sample);
    render(<Downloader />);
    fireEvent.click(screen.getByRole('button', { name: /Batch links/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://example.com/restricted.mp4\nhttps://media.w3.org/flower.mp4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find all media' }));
    expect(await screen.findByRole('heading', { name: 'Flower' })).toBeTruthy();
    expect(screen.getByText('First source is restricted.')).toBeTruthy();
    expect(screen.getByText('1 of 2 links ready')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download MP4' })).toBeTruthy();
  });

  it('cancels a resolving request and returns the form to an editable state', async () => {
    let receivedSignal: AbortSignal | undefined;
    resolveMock.mockImplementation((_, signal) => new Promise((_, reject) => {
      receivedSignal = signal;
      signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    render(<Downloader />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://media.w3.org/flower.mp4' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Media downloader' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(false));
    expect(receivedSignal?.aborted).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
