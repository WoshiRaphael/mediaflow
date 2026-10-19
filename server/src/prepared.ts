import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import type { ExtractedFormat } from './extractor.js';
import { detectMedia, detectTrackContainer } from './media.js';
import type { MediaRecord } from './registry.js';
import { checkDeclaredSize, openMedia, type TransportDependencies } from './upstream.js';

interface PreparedFile {
  key: string; directory: string; path: string; size: number; extension: 'mp4' | 'webm'; mimeType: string;
  expiresAt: number; lastUsed: number; leases: number;
}
interface Preparation {
  promise: Promise<PreparedFile>; controller: AbortController; waiters: number; finished: boolean; entry?: PreparedFile;
}
export interface PreparedLease {
  path: string; size: number; extension: 'mp4' | 'webm'; mimeType: string; release: () => void;
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(signal.reason ?? new Error('Request cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    promise.then(value => { cleanup(); if (!signal.aborted) resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Only local, signature-checked containers reach ffmpeg. Each input is forced
 * to the appropriate demuxer, and remote/manifest protocols are unavailable. */
export function offlineFfmpegArgs(inputs: { path: string; container: 'mp4' | 'webm' }[], output?: string, maxBytes?: number): string[] {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  for (const input of inputs) {
    args.push('-protocol_whitelist', 'file,pipe', '-f', input.container === 'mp4' ? 'mov' : 'matroska');
    if (input.container === 'mp4') args.push('-enable_drefs', '0', '-use_absolute_path', '0');
    args.push('-i', input.path);
  }
  args.push('-map', '0:v:0', '-map', inputs.length === 2 ? '1:a:0' : '0:a:0', '-c', 'copy');
  if (!output) args.push('-f', 'null', '-');
  else {
    if (maxBytes) args.push('-fs', String(maxBytes));
    if (output.endsWith('.mp4')) args.push('-movflags', '+faststart');
    args.push(output);
  }
  return args;
}

async function ffmpeg(config: Config, args: string[], cwd: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: cwd, USERPROFILE: cwd, TMP: cwd, TEMP: cwd, TMPDIR: cwd, LANG: 'C',
    } });
    let settled = false;
    let stderrBytes = 0;
    const cancel = () => child.kill('SIGKILL');
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 65536) child.kill('SIGKILL'); });
    child.once('error', () => finish(new ApiError(503, 'PROCESSOR_UNAVAILABLE', 'Video processing is unavailable. The operator needs to install FFmpeg.')));
    child.once('close', code => {
      if (signal.aborted) finish(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled'));
      else if (code !== 0) finish(new ApiError(422, 'PROCESSING_FAILED', 'The source’s audio and video could not be prepared. Try another available quality.'));
      else finish();
    });
  });
}

export class PreparedMediaStore {
  private cache = new Map<string, PreparedFile>();
  private jobs = new Map<string, Preparation>();
  private active = 0;
  private reserved = 0;
  private used = 0;
  private lock: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout;
  constructor(private config: Config, private transport: TransportDependencies = {}, private temporaryRoot = tmpdir()) {
    this.timer = setInterval(() => { void this.prune(); }, 15000).unref();
  }

  private async remove(entry: PreparedFile): Promise<boolean> {
    if (entry.leases > 0) return false;
    try { await rm(entry.directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); }
    catch { return false; }
    if (this.cache.get(entry.key) === entry) { this.cache.delete(entry.key); this.used -= entry.size; }
    return true;
  }
  async prune(): Promise<void> {
    for (const entry of this.cache.values()) if (entry.expiresAt <= Date.now()) await this.remove(entry);
  }
  private async reserve(): Promise<number> {
    let unlock!: () => void;
    const previous = this.lock;
    this.lock = new Promise(resolve => { unlock = resolve; });
    await previous;
    try {
      if (this.active >= 2) throw new ApiError(503, 'SERVER_BUSY', 'Two videos are already being prepared. Please retry in a moment.');
      const reservation = this.config.maxFileBytes * 2;
      const budget = this.config.maxFileBytes * 4;
      for (const entry of [...this.cache.values()].sort((a, b) => a.lastUsed - b.lastUsed)) {
        if (this.used + this.reserved + reservation <= budget) break;
        await this.remove(entry);
      }
      if (this.used + this.reserved + reservation > budget) throw new ApiError(503, 'STORAGE_BUSY', 'Temporary video storage is busy. Please retry shortly.');
      this.active++;
      this.reserved += reservation;
      return reservation;
    } finally { unlock(); }
  }

  private async download(source: ExtractedFormat['sources'][number], path: string, total: { bytes: number }, signal: AbortSignal): Promise<'mp4' | 'webm'> {
    const { response } = await openMedia(source.url, { ...this.config, requestTimeoutMs: this.config.downloadTimeoutMs }, undefined, this.transport, signal, source.headers);
    const prefix: Buffer[] = [];
    let prefixLength = 0;
    try {
      const declared = checkDeclaredSize(response, this.config.maxFileBytes);
      if (declared !== undefined && total.bytes + declared > this.config.maxFileBytes) throw new ApiError(413, 'FILE_TOO_LARGE', 'The selected audio and video exceed the file-size limit.');
      const mime = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
      if (mime && !['video/mp4', 'audio/mp4', 'audio/x-m4a', 'video/webm', 'audio/webm', 'application/octet-stream', 'binary/octet-stream'].includes(mime)) throw new ApiError(422, 'UNSUPPORTED_TRACK', 'The source did not provide an MP4 or WebM media track.');
      const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        total.bytes += chunk.length;
        if (total.bytes > this.config.maxFileBytes) { callback(new ApiError(413, 'FILE_TOO_LARGE', 'The selected audio and video exceed the file-size limit.')); return; }
        if (prefixLength < 65536) { const part = chunk.subarray(0, 65536 - prefixLength); prefix.push(part); prefixLength += part.length; }
        callback(null, chunk);
      } });
      await pipeline(response.body, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
      return detectTrackContainer(Buffer.concat(prefix, prefixLength));
    } finally { response.destroy(); }
  }

  private async run(key: string, record: MediaRecord, plan: ExtractedFormat, signal: AbortSignal): Promise<PreparedFile> {
    const reservation = await this.reserve();
    let directory: string | undefined;
    let cached = false;
    try {
      signal.throwIfAborted();
      if (!plan.hasAudio || ![1, 2].includes(plan.sources.length) || Boolean(plan.needsMerge) !== (plan.sources.length === 2)) throw new ApiError(422, 'INVALID_PLAN', 'This source does not provide a complete video with audio.');
      directory = await mkdtemp(join(this.temporaryRoot, 'mediaflow-'));
      const paths: { path: string; container: 'mp4' | 'webm' }[] = [];
      const total = { bytes: 0 };
      for (let index = 0; index < plan.sources.length; index++) {
        signal.throwIfAborted();
        const path = join(directory, `track-${index}.media`);
        const container = await this.download(plan.sources[index], path, total, signal);
        paths.push({ path, container });
      }
      let output = join(directory, `prepared.${plan.extension}`);
      if (plan.needsMerge) {
        await ffmpeg(this.config, offlineFfmpegArgs(paths, output, this.config.maxFileBytes), directory, signal);
      } else {
        // Verify both streams exist locally. Codec copy to a null muxer adds no
        // transcoding and prevents a mislabeled video-only file being served.
        await ffmpeg(this.config, offlineFfmpegArgs(paths), directory, signal);
        // Keep the original private path. No filesystem move or byte copy is
        // needed; the public filename comes from Content-Disposition.
        output = paths[0].path;
      }
      signal.throwIfAborted();
      const info = await stat(output);
      if (!info.size || info.size > this.config.maxFileBytes || (plan.needsMerge && info.size >= this.config.maxFileBytes)) throw new ApiError(413, 'FILE_TOO_LARGE', 'The prepared video exceeds the file-size limit.');
      const handle = await open(output, 'r');
      let bytes: Buffer;
      try { const prefix = Buffer.alloc(65536); const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0); bytes = prefix.subarray(0, bytesRead); } finally { await handle.close(); }
      const actual = detectMedia(bytes);
      if (actual.kind !== 'video' || actual.extension !== plan.extension) throw new ApiError(422, 'INVALID_VIDEO', 'The prepared file did not match the selected video format.');
      for (const path of paths) if (path.path !== output) await rm(path.path, { force: true });
      signal.throwIfAborted();
      const entry: PreparedFile = { key, directory, path: output, size: info.size, extension: plan.extension, mimeType: actual.mimeType, expiresAt: record.expiresAt, lastUsed: Date.now(), leases: 1 };
      this.cache.set(key, entry);
      this.used += entry.size;
      cached = true;
      return entry;
    } finally {
      this.active--;
      this.reserved -= reservation;
      if (!cached && directory) await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(() => {});
    }
  }

  async acquire(record: MediaRecord, plan: ExtractedFormat, signal?: AbortSignal): Promise<PreparedLease> {
    signal?.throwIfAborted();
    const key = `${record.id}:${plan.id}`;
    let entry = this.cache.get(key);
    if (entry && entry.expiresAt <= Date.now()) { await this.remove(entry); entry = undefined; }
    if (!entry) {
      let job = this.jobs.get(key);
      if (!job) {
        const controller = new AbortController();
        const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(this.config.downloadTimeoutMs)]);
        job = { controller, waiters: 0, finished: false, promise: undefined as unknown as Promise<PreparedFile> };
        const current = job;
        current.promise = this.run(key, record, plan, combined).then(result => { current.finished = true; current.entry = result; if (current.waiters === 0) result.leases--; return result; }, error => {
          current.finished = true;
          if (combined.aborted && !controller.signal.aborted) throw new ApiError(504, 'PREPARATION_TIMEOUT', 'Preparing this video took too long. Try a smaller quality or retry.');
          throw error;
        }).finally(() => this.jobs.delete(key));
        this.jobs.set(key, current);
      }
      job.waiters++;
      try { entry = await waitFor(job.promise, signal); entry.leases++; }
      finally {
        job.waiters--;
        if (job.waiters === 0) {
          if (!job.finished) job.controller.abort();
          if (job.entry) job.entry.leases--;
        }
      }
    } else entry.leases++;
    entry.lastUsed = Date.now();
    let released = false;
    return { path: entry.path, size: entry.size, extension: entry.extension, mimeType: entry.mimeType, release: () => {
      if (released) return;
      released = true; entry!.leases--;
      if (entry!.expiresAt <= Date.now()) void this.remove(entry!);
    } };
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
    for (const entry of this.cache.values()) { entry.leases = 0; await this.remove(entry); }
  }
}

export function preparedRange(range: string | undefined, size: number): { start: number; end: number; partial: boolean } {
  if (!range) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)!;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) throw new ApiError(416, 'INVALID_RANGE', 'The requested media range is unavailable.');
  return { start, end, partial: true };
}

export { createReadStream };
