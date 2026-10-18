export type MediaKind = 'photo' | 'image' | 'video';

export interface MediaFormat {
  id: string;
  label: string;
  extension: string;
  mimeType: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface ResolvedMedia {
  id: string;
  title: string;
  platform: string;
  kind: MediaKind;
  thumbnail?: string;
  formats: MediaFormat[];
  expiresAt: string;
}

export interface DownloadProgress {
  received: number;
  total?: number;
}

const environment = (import.meta as ImportMeta & {
  env?: Record<string, string | undefined>;
}).env;

// The API is a separately deployed service in production. Never put credentials here.
const API_BASE_URL = (environment?.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export function validateMediaUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ApiError('Paste a public image or video link to get started.', 'EMPTY_URL');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiError('That link looks incomplete. Include the full https:// address.', 'INVALID_URL');
  }
  if (url.protocol !== 'https:') {
    throw new ApiError('Use a secure link beginning with https://.', 'INVALID_URL');
  }
  if (url.username || url.password) {
    throw new ApiError('Links containing sign-in details are not supported.', 'INVALID_URL');
  }
  if (trimmed.length > 2048) throw new ApiError('That link is too long. Please use the direct media URL.', 'INVALID_URL');
  return url.href;
}

async function responseError(response: Response, resolving = false): Promise<ApiError> {
  try {
    const data = await response.json() as { error?: { code?: string; message?: string } };
    if (typeof data.error?.message === 'string' && data.error.message) {
      return new ApiError(data.error.message, data.error.code || 'REQUEST_FAILED', response.status);
    }
  } catch {
    // A host's generic HTML error page should never appear in the interface.
  }
  const message = resolving && response.status === 404
    ? 'The media service is unavailable at this address. If you are running MediaFlow locally, start the backend too.'
    : response.status === 429
    ? 'A little too fast. Wait a moment, then try again.'
    : response.status === 404 || response.status === 410
      ? 'This media link has expired. Resolve the original link again.'
      : 'The media service could not complete this request. Please try again.';
  return new ApiError(message, 'REQUEST_FAILED', response.status);
}

function connectionError(error: unknown): never {
  if (error instanceof ApiError || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')) throw error;
  throw new ApiError(
    'Could not reach the media service. Check your connection. If you are running MediaFlow locally, start the backend too.',
    'CONNECTION_ERROR',
  );
}

export async function resolveMedia(value: string, signal?: AbortSignal): Promise<ResolvedMedia> {
  const url = validateMediaUrl(value);
  try {
    const response = await fetch(`${API_BASE_URL}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) throw await responseError(response, true);
    const result = await response.json() as ResolvedMedia | null;
    if (!result || typeof result.id !== 'string' || !result.id || typeof result.title !== 'string' || typeof result.platform !== 'string' || !['photo', 'image', 'video'].includes(result.kind) || !Array.isArray(result.formats) || !result.formats.length || result.formats.some((format) => !format || typeof format.id !== 'string' || !format.id || typeof format.extension !== 'string' || typeof format.mimeType !== 'string' || typeof format.label !== 'string')) {
      throw new ApiError('The media service returned an incomplete preview. Please try again.', 'INVALID_RESPONSE');
    }
    return result;
  } catch (error) {
    return connectionError(error);
  }
}

export function mediaUrl(id: string, format: string, disposition: 'inline' | 'attachment' = 'inline'): string {
  const query = new URLSearchParams({ format, disposition });
  return `${API_BASE_URL}/media/${encodeURIComponent(id)}?${query.toString()}`;
}

function safeFilename(disposition: string | null, media: ResolvedMedia, format: MediaFormat): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const simple = disposition?.match(/filename="([^"]+)"|filename=([^;]+)/i);
  let candidate = simple?.[1] || simple?.[2] || `${media.title || 'mediaflow-download'}.${format.extension}`;
  if (encoded) {
    try { candidate = decodeURIComponent(encoded); } catch { /* Use the plain filename when encoding is malformed. */ }
  }
  return candidate.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/^\.+/, '').trim().slice(0, 180) || `mediaflow-download.${format.extension}`;
}

/** Stream the actual file, enforce a browser-side limit, then hand it to the browser. */
export async function downloadMedia(
  media: ResolvedMedia,
  format: MediaFormat,
  signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  try {
    const response = await fetch(mediaUrl(media.id, format.id, 'attachment'), {
      signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) throw await responseError(response);
    const length = Number(response.headers.get('content-length'));
    const total = Number.isFinite(length) && length > 0 ? length : undefined;
    if (total && total > MAX_DOWNLOAD_BYTES) {
      await response.body?.cancel();
      throw new ApiError('This file exceeds the 100 MB download limit.', 'FILE_TOO_LARGE');
    }
    const reader = response.body?.getReader();
    let blob: Blob;
    if (reader) {
      const chunks: ArrayBuffer[] = [];
      let received = 0;
      let lastReport = 0;
      onProgress({ received, total });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_DOWNLOAD_BYTES) {
            await reader.cancel();
            throw new ApiError('This file exceeds the 100 MB download limit.', 'FILE_TOO_LARGE');
          }
          // Copy to a concrete ArrayBuffer for DOM Blob compatibility across TS versions.
          chunks.push(Uint8Array.from(value).buffer);
          if (performance.now() - lastReport > 80) {
            onProgress({ received, total });
            lastReport = performance.now();
          }
        }
      } finally {
        reader.releaseLock();
      }
      onProgress({ received, total: total || received });
      blob = new Blob(chunks, { type: response.headers.get('content-type') || format.mimeType });
    } else {
      blob = await response.blob();
      if (blob.size > MAX_DOWNLOAD_BYTES) throw new ApiError('This file exceeds the 100 MB download limit.', 'FILE_TOO_LARGE');
      onProgress({ received: blob.size, total: blob.size });
    }
    if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
    if (!blob.size) throw new ApiError('The source returned an empty file. Try resolving the link again.', 'EMPTY_FILE');
    const filename = safeFilename(response.headers.get('content-disposition'), media, format);
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Give mobile browsers enough time to begin saving before releasing the blob.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    return filename;
  } catch (error) {
    return connectionError(error);
  }
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'Size available on download';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
