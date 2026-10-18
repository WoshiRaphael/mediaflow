import type { Readable } from 'node:stream';
import { ApiError } from './errors.js';

export interface MediaType { kind: 'photo' | 'video'; extension: 'jpg' | 'png' | 'webp' | 'gif' | 'mp4' | 'webm'; mimeType: string; width?: number; height?: number }

export function detectMedia(bytes: Buffer): MediaType {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: 'photo', extension: 'jpg', mimeType: 'image/jpeg' };
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return { kind: 'photo', extension: 'png', mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return { kind: 'photo', extension: 'gif', mimeType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { kind: 'photo', extension: 'webp', mimeType: 'image/webp' };
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash|MSNV)/.test(bytes.toString('ascii', 8, 12))) return { kind: 'video', extension: 'mp4', mimeType: 'video/mp4' };
  if (bytes.length >= 32 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && bytes.subarray(0, 256).includes(Buffer.from('webm'))) return { kind: 'video', extension: 'webm', mimeType: 'video/webm' };
  throw new ApiError(422, 'UNSUPPORTED_MEDIA', 'This link does not provide a supported JPG, PNG, WebP, GIF, MP4, or WebM file. Paste the direct file URL, not a webpage.');
}

export function validateDeclaredMime(value: string | undefined, media: MediaType): void {
  const declared = value?.split(';')[0].trim().toLowerCase();
  if (declared && ![media.mimeType, 'application/octet-stream', 'binary/octet-stream', ...(media.extension === 'jpg' ? ['image/jpg'] : [])].includes(declared)) {
    throw new ApiError(422, 'CONTENT_TYPE_MISMATCH', 'The source returned a file with an unexpected content type.');
  }
}

export async function readPrefix(body: Readable, maximum = 65536): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let count = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maximum - count;
      chunks.push(bytes.subarray(0, remaining));
      count += Math.min(remaining, bytes.length);
      if (count >= maximum) break;
    }
  } finally { body.destroy(); }
  return Buffer.concat(chunks, count);
}

export function mediaTitle(url: URL, extension: string): string {
  const basename = url.pathname.split('/').filter(Boolean).at(-1) ?? 'media';
  let decoded = basename;
  try { decoded = decodeURIComponent(basename); } catch { /* Keep a safe filename for malformed path escapes. */ }
  const title = decoded.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^a-zA-Z0-9 _-]/g, '-').replace(/[-_]+/g, ' ').trim().slice(0, 100);
  return title || `MediaFlow ${extension.toUpperCase()}`;
}

export function filename(title: string, extension: string): string {
  return `${title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 100) || 'mediaflow'}.${extension}`;
}
