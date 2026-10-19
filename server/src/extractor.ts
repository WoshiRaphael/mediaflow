import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { createExtractorEgress, extractorEnvironment } from './egress.js';
import { findPlatform } from './platforms.js';

export interface ExtractedSource { url: string; headers?: Record<string, string> }
export interface ExtractedFormat {
  id: string; label: string; extension: 'mp4' | 'webm'; mimeType: string;
  size?: number; width?: number; height?: number; hasAudio: true;
  videoCodec?: string; audioCodec?: string; sources: ExtractedSource[]; needsMerge?: boolean;
}
export interface ExtractedVideo { title: string; platform: string; duration?: number; formats: ExtractedFormat[] }
type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 16384) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || isIP(url.hostname) || url.hostname.includes('[')) return;
    url.hash = '';
    return url.href;
  } catch { return; }
}

function headers(value: unknown): Record<string, string> | undefined {
  if (!object(value)) return;
  const result: Record<string, string> = {};
  for (const [key, value_] of Object.entries(value)) {
    if (typeof value_ !== 'string' || value_.length > 2048 || /[\r\n\0]/.test(value_)) continue;
    if (key.toLowerCase() === 'user-agent') result['User-Agent'] = value_.slice(0, 512);
    if (key.toLowerCase() === 'referer') { const url = sourceUrl(value_); if (url) result.Referer = url; }
  }
  return Object.keys(result).length ? result : undefined;
}

/** Only actual, unencrypted direct HTTP video/audio files become plans. We never
 * publish URLs, manifests, DRM streams, cookies or raw extractor options. */
export function parseExtractedVideo(value: unknown, input: string, maximumBytes: number): ExtractedVideo {
  if (!object(value)) throw new ApiError(502, 'INVALID_SOURCE_METADATA', 'The video source returned unreadable details. Please try again.');
  if (value._type === 'playlist' || value._type === 'multi_video' || Array.isArray(value.entries)) {
    const platform = findPlatform(new URL(input).hostname);
    const entries = Array.isArray(value.entries) ? value.entries.filter(object) : [];
    if (platform && ['instagram', 'x', 'facebook'].includes(platform.id) && entries[0]) value = entries[0];
    else throw new ApiError(422, 'PLAYLIST_UNSUPPORTED', 'Paste a single video or post link instead of a playlist, profile, or channel.');
  }
  const data = value as Data;
  if (data.is_live === true || data.live_status === 'is_live' || data.live_status === 'is_upcoming') throw new ApiError(422, 'LIVE_UNSUPPORTED', 'Live and scheduled streams cannot be saved. Try a completed public video.');
  if (data.has_drm === true || ['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(text(data.availability))) throw new ApiError(422, 'PROTECTED_VIDEO', 'This video is protected or requires account access. Only public, unprotected videos can be downloaded.');
  const raw = Array.isArray(data.formats) ? data.formats.filter(object) : sourceUrl(data.url) ? [data] : [];
  const candidates = raw.filter(format => {
    const protocol = text(format.protocol);
    return format.has_drm !== true && (!protocol || ['http', 'https'].includes(protocol)) && sourceUrl(format.url) &&
      ['mp4', 'webm', 'm4a'].includes(text(format.ext)) && (positive(format.filesize) ?? 0) <= maximumBytes;
  });
  const audio = candidates.filter(f => f.vcodec === 'none' && text(f.acodec) && f.acodec !== 'none');
  // Some progressive/HTML5 sources omit codec metadata. The local preparation
  // step verifies both streams with FFmpeg before serving any bytes. Explicit
  // video-only tracks still require a separately identified audio track.
  const hasVideo = (f: Data) => f.vcodec !== 'none';
  const hasAudio = (f: Data) => f.acodec !== 'none';
  const ranked = candidates.filter(f => hasVideo(f) && ['mp4', 'webm'].includes(text(f.ext))).sort((a, b) =>
    (positive(b.height) ?? 0) - (positive(a.height) ?? 0) || (hasAudio(b) ? 1 : 0) - (hasAudio(a) ? 1 : 0) || (positive(b.tbr) ?? 0) - (positive(a.tbr) ?? 0));
  const formats: ExtractedFormat[] = [];
  const seen = new Set<string>();
  for (const video of ranked) {
    const extension = text(video.ext) as 'mp4' | 'webm';
    const height = positive(video.height);
    if (height && height > 2160) continue;
    const key = `${height || text(video.format_note) || 'original'}-${extension}`;
    if (seen.has(key)) continue;
    let audioTrack: Data | undefined;
    if (!hasAudio(video)) {
      audioTrack = audio.filter(a => extension === 'mp4' ? ['m4a', 'mp4'].includes(text(a.ext)) && /^(mp4a|aac)/.test(text(a.acodec)) : text(a.ext) === 'webm')
        .sort((a, b) => (positive(b.abr) ?? 0) - (positive(a.abr) ?? 0))[0];
      if (!audioTrack) continue;
    }
    const videoSize = positive(video.filesize), audioSize = audioTrack ? positive(audioTrack.filesize) : undefined;
    const size = videoSize && (!audioTrack || audioSize) ? videoSize + (audioSize || 0) : undefined;
    if (size && size > maximumBytes) continue;
    const source = (format: Data): ExtractedSource => ({ url: sourceUrl(format.url)!, headers: headers(format.http_headers) || headers(data.http_headers) });
    const quality = height ? `${height}p` : text(video.format_note).slice(0, 30) || 'Original';
    formats.push({
      id: `video-${formats.length + 1}`, label: `${quality} · ${extension.toUpperCase()}${text(video.acodec) || audioTrack ? ' · video + audio' : ''}`, extension,
      mimeType: extension === 'mp4' ? 'video/mp4' : 'video/webm', hasAudio: true,
      ...(size ? { size } : {}), ...(height ? { height } : {}), ...(positive(video.width) ? { width: positive(video.width) } : {}),
      ...(text(video.vcodec) ? { videoCodec: text(video.vcodec).slice(0, 60) } : {}),
      ...(text(audioTrack?.acodec || video.acodec) ? { audioCodec: text(audioTrack?.acodec || video.acodec).slice(0, 60) } : {}),
      sources: audioTrack ? [source(video), source(audioTrack)] : [source(video)], ...(audioTrack ? { needsMerge: true } : {}),
    });
    seen.add(key);
    if (formats.length >= 8) break;
  }
  if (!formats.length) throw new ApiError(422, 'NO_DOWNLOADABLE_FORMAT', 'This source did not provide an accessible MP4 or WebM video with audio within the file-size limit. It may be protected, unavailable, or only offer unsupported streams.');
  // A combined file avoids preparing separate tracks just to show a preview.
  const firstCombined = formats.findIndex(f => !f.needsMerge && (!f.height || f.height <= 1080));
  if (firstCombined > 0) formats.unshift(...formats.splice(firstCombined, 1));
  const platform = findPlatform(new URL(input).hostname)?.id || text(data.extractor_key || data.extractor).replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 40) || 'website';
  return { title: (text(data.title) || 'Your video').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180), platform, ...(positive(data.duration) ? { duration: positive(data.duration) } : {}), formats };
}

export function stopExtractor(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => { if (child.exitCode === null) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

function extractionError(stderr: string): ApiError {
  if (/confirm you.re not a bot|automated|unusual traffic|rate.limit|HTTP Error (?:403|429)|IP.*block/i.test(stderr)) return new ApiError(422, 'PLATFORM_BLOCKED', 'This platform is blocking access from the hosting server. MediaFlow cannot override that restriction.');
  if (/private|log.?in|sign.?in|cookies|authentication|members.only|premium/i.test(stderr)) return new ApiError(422, 'LOGIN_REQUIRED', 'This video requires account access or is private. Try a public video that plays without signing in.');
  if (/DRM|protected/i.test(stderr)) return new ApiError(422, 'PROTECTED_VIDEO', 'This video uses access protection and cannot be downloaded.');
  if (/Unsupported URL|No video|not a valid URL/i.test(stderr)) return new ApiError(422, 'VIDEO_NOT_FOUND', 'No downloadable video was found at this link. Paste the video’s own post or watch-page URL.');
  if (/timed? out|timeout/i.test(stderr)) return new ApiError(504, 'SOURCE_TIMEOUT', 'The video source took too long to respond. Please try again.');
  return new ApiError(422, 'SOURCE_UNAVAILABLE', 'This video could not be accessed. It may have been removed, restricted, or blocked by the source platform.');
}

async function runExtraction(input: string, config: Config, signal?: AbortSignal): Promise<ExtractedVideo> {
  signal?.throwIfAborted();
  if (!sourceUrl(input)) throw new ApiError(400, 'INVALID_URL', 'Paste a complete public HTTPS video link without credentials or a custom port.');
  if (!config.extractorEnabled) throw new ApiError(503, 'EXTRACTOR_DISABLED', 'Video-page downloads are not enabled on this installation. Direct media links still work.');
  try { await access(config.extractorPath); await access(config.denoPath); }
  catch { throw new ApiError(503, 'EXTRACTOR_UNAVAILABLE', 'The video-page resolver is not installed on this server yet. Please contact the site operator.'); }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let egress: Awaited<ReturnType<typeof createExtractorEgress>> | undefined;
  let directory: string | undefined;
  try {
    const transport = await createExtractorEgress(controller.signal);
    egress = transport;
    const workingDirectory = await mkdtemp(path.join(tmpdir(), 'mediaflow-resolve-'));
    directory = workingDirectory;
    const result = await new Promise<unknown>((resolve, reject) => {
      const child = spawn(config.pythonPath, [
        config.extractorPath, '--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-remote-components',
        '--no-cache-dir', '--no-playlist', '--playlist-items', '1', '--skip-download', '--dump-single-json', '--no-warnings',
        '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0', '--fragment-retries', '0',
        '--no-js-runtimes', '--js-runtimes', `deno:${config.denoPath}`,
        '--proxy', transport.url, '--geo-verification-proxy', transport.url,
        '--', input,
      ], { shell: false, windowsHide: true, detached: process.platform !== 'win32', cwd: workingDirectory, env: extractorEnvironment(transport.url), stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      let outputSize = 0, errorSize = 0;
      let failure: Error | undefined;
      const fail = (error: Error) => { failure ??= error; stopExtractor(child); };
      const cancel = () => fail(controller.signal.reason instanceof Error ? controller.signal.reason : new DOMException('Cancelled', 'AbortError'));
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
      const timer = setTimeout(() => fail(new ApiError(504, 'SOURCE_TIMEOUT', 'Finding this video took too long. Please retry or try another link.')), config.extractionTimeoutMs);
      child.stdout.on('data', (bytes: Buffer) => { outputSize += bytes.length; if (outputSize > 6 * 1024 * 1024) fail(new ApiError(422, 'SOURCE_TOO_COMPLEX', 'This video page returned too much data. Try a single video link.')); else stdout.push(bytes); });
      child.stderr.on('data', (bytes: Buffer) => { errorSize += bytes.length; if (errorSize > 64 * 1024) fail(new ApiError(422, 'SOURCE_UNAVAILABLE', 'The video source could not be resolved.')); else stderr.push(bytes); });
      child.once('error', error => { failure ??= new ApiError(503, 'EXTRACTOR_UNAVAILABLE', 'The server’s video resolver could not start. Please contact the site operator.'); });
      child.once('close', code => {
        clearTimeout(timer); controller.signal.removeEventListener('abort', cancel);
        if (failure) { reject(failure); return; }
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8');
          // Log a bounded classification only: never source URLs, cookies,
          // extractor output, private proxy credentials or raw diagnostics.
          const httpStatus = /HTTP Error (\d{3})/.exec(detail)?.[1];
          const reason = httpStatus ? `HTTP_${httpStatus}` : /CERTIFICATE_VERIFY_FAILED|certificate verify failed/i.test(detail) ? 'TLS_CERTIFICATE_FAILED'
            : /Tunnel connection failed|ProxyError|proxy/i.test(detail) ? 'SOURCE_TUNNEL_FAILED'
            : /timed? out|timeout/i.test(detail) ? 'SOURCE_TIMEOUT'
            : /Name or service not known|name resolution|nodename nor servname/i.test(detail) ? 'SOURCE_DNS_FAILED'
            : /Remote end closed|Connection reset|Connection refused/i.test(detail) ? 'SOURCE_CONNECTION_FAILED'
            : extractionError(detail).code;
          console.warn(JSON.stringify({ event: 'video_resolve_failed', platform: findPlatform(new URL(input).hostname)?.id || 'website', reason }));
          reject(extractionError(detail)); return;
        }
        try { resolve(JSON.parse(Buffer.concat(stdout).toString('utf8'))); }
        catch { reject(new ApiError(502, 'INVALID_SOURCE_METADATA', 'The video source returned unreadable details. Please retry.')); }
      });
    });
    signal?.throwIfAborted();
    return parseExtractedVideo(result, input, config.maxFileBytes);
  } finally {
    egress?.close(); signal?.removeEventListener('abort', abort);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

let activeExtractions = 0;
export async function extractVideoPage(input: string, config: Config, signal?: AbortSignal): Promise<ExtractedVideo> {
  signal?.throwIfAborted();
  if (activeExtractions >= 2) throw new ApiError(503, 'RESOLVER_BUSY', 'Two video links are already being checked. Please try again in a moment.');
  activeExtractions++;
  try { return await runExtraction(input, config, signal); }
  finally { activeExtractions--; }
}
