import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DEFAULT_MEDIA_HOSTS = [
  'images.unsplash.com', 'upload.wikimedia.org',
  'media.w3.org', 'interactive-examples.mdn.mozilla.net',
];

export interface Config {
  port: number;
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  maxFileBytes: number;
  requestTimeoutMs: number;
  mediaTtlSeconds: number;
  rateLimit: number;
  maxConcurrentDownloads: number;
  trustProxyHops: number;
  allowPublicMedia: boolean;
  extractorEnabled: boolean;
  extractorPath: string;
  pythonPath: string;
  ffmpegPath: string;
  extractionTimeoutMs: number;
  downloadTimeoutMs: number;
  denoPath: string;
}

const integer = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const schema = z.object({
  PORT: integer(8787, 1, 65535),
  MAX_FILE_BYTES: integer(104857600, 1024, 1073741824),
  REQUEST_TIMEOUT_MS: integer(20000, 1000, 120000),
  MEDIA_TTL_SECONDS: integer(900, 60, 3600),
  RATE_LIMIT_PER_MINUTE: integer(30, 1, 600),
  MAX_CONCURRENT_DOWNLOADS: integer(4, 1, 32),
  TRUST_PROXY_HOPS: integer(0, 0, 3),
  EXTRACTION_TIMEOUT_MS: integer(65000, 1000, 120000),
  DOWNLOAD_TIMEOUT_MS: integer(120000, 10000, 600000),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const values = schema.parse(env);
  const origins = (env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(x => x.trim()).filter(Boolean);
  if (origins.length === 0 || origins.some(origin => {
    try { const u = new URL(origin); return u.origin !== origin || !['https:', 'http:'].includes(u.protocol); }
    catch { return true; }
  })) throw new Error('ALLOWED_ORIGINS must contain exact http(s) origins, without a path or trailing slash.');
  const hosts = (env.ALLOWED_MEDIA_HOSTS ?? DEFAULT_MEDIA_HOSTS.join(',')).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (hosts.length === 0 || hosts.some(host => !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))) {
    throw new Error('ALLOWED_MEDIA_HOSTS must contain exact public hostnames; wildcards and IP addresses are forbidden.');
  }
  const extractorPath = env.EXTRACTOR_PATH || fileURLToPath(new URL('../.bin/yt-dlp', import.meta.url));
  return {
    port: values.PORT, allowedOrigins: new Set(origins), allowedHosts: new Set(hosts),
    maxFileBytes: values.MAX_FILE_BYTES, requestTimeoutMs: values.REQUEST_TIMEOUT_MS,
    mediaTtlSeconds: values.MEDIA_TTL_SECONDS, rateLimit: values.RATE_LIMIT_PER_MINUTE,
    maxConcurrentDownloads: values.MAX_CONCURRENT_DOWNLOADS, trustProxyHops: values.TRUST_PROXY_HOPS,
    allowPublicMedia: env.ALLOW_PUBLIC_MEDIA !== 'false',
    extractorEnabled: env.EXTRACTOR_ENABLED !== 'false',
    extractorPath,
    pythonPath: env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3'),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    extractionTimeoutMs: values.EXTRACTION_TIMEOUT_MS,
    downloadTimeoutMs: values.DOWNLOAD_TIMEOUT_MS,
    denoPath: env.DENO_PATH || join(dirname(extractorPath), process.platform === 'win32' ? 'deno.exe' : 'deno'),
  };
}
