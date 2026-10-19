import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import type { ExtractedFormat } from '../src/extractor.js';
import { offlineFfmpegArgs, PreparedMediaStore, preparedRange } from '../src/prepared.js';
import { MediaRegistry } from '../src/registry.js';
import { createMediaService } from '../src/service.js';
import type { PinnedRequest } from '../src/upstream.js';

const execute = promisify(execFile);
const config = loadConfig({ ...process.env, ALLOW_PUBLIC_MEDIA: 'true', MAX_FILE_BYTES: '2097152' });
let available = false;
try { await execute(config.ffmpegPath, ['-version'], { windowsHide: true, timeout: 10000 }); available = true; } catch { /* Real processing tests explicitly skip when the external runtime is absent. */ }
if (process.env.REQUIRE_FFMPEG_TESTS === 'true' && !available) throw new Error('FFmpeg is required for this test run. Install it or set FFMPEG_PATH to a working executable.');
const fixtures = await mkdtemp(join(tmpdir(), 'mediaflow-fixtures-'));
after(() => rm(fixtures, { recursive: true, force: true }));
let combined: Buffer, video: Buffer, audio: Buffer;
if (available) {
  const main = join(fixtures, 'combined.mp4');
  await execute(config.ffmpegPath, ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5:d=0.6', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=0.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', main], { windowsHide: true, timeout: 20000 });
  await execute(config.ffmpegPath, ['-nostdin', '-loglevel', 'error', '-y', '-i', main, '-map', '0:v:0', '-c', 'copy', join(fixtures, 'video.mp4')], { windowsHide: true, timeout: 10000 });
  await execute(config.ffmpegPath, ['-nostdin', '-loglevel', 'error', '-y', '-i', main, '-map', '0:a:0', '-c', 'copy', join(fixtures, 'audio.m4a')], { windowsHide: true, timeout: 10000 });
  [combined, video, audio] = await Promise.all(['combined.mp4', 'video.mp4', 'audio.m4a'].map(name => readFile(join(fixtures, name))));
}
const plans = (): ExtractedFormat[] => [
  { id: 'progressive', label: 'Original with audio', extension: 'mp4', mimeType: 'video/mp4', hasAudio: true, sources: [{ url: 'https://cdn.example.org/combined.mp4' }] },
  { id: 'merged', label: 'Separate original tracks', extension: 'mp4', mimeType: 'video/mp4', hasAudio: true, needsMerge: true, sources: [{ url: 'https://cdn.example.org/video.mp4' }, { url: 'https://cdn.example.org/audio.m4a' }] },
];
const sourceTransport = (onRequest: () => void = () => {}): PinnedRequest => async url => {
  onRequest();
  const bytes = url.pathname.includes('combined') ? combined : url.pathname.includes('audio') ? audio : video;
  return { statusCode: 200, headers: { 'content-type': url.pathname.includes('audio') ? 'audio/mp4' : 'video/mp4', 'content-length': String(bytes.length) }, body: Readable.from([bytes]), destroy() { this.body.destroy(); } };
};
const dns = async () => [{ address: '8.8.8.8', family: 4 as const }];

test('offline ffmpeg restricts every input and requires actual video and audio streams', () => {
  const args = offlineFfmpegArgs([{ path: '/private/video', container: 'mp4' }, { path: '/private/audio', container: 'mp4' }], '/private/result.mp4', 1024);
  assert.equal(args.filter(arg => arg === '-protocol_whitelist').length, 2);
  assert.equal(args.filter(arg => arg === 'file,pipe').length, 2);
  assert.ok(args.includes('0:v:0'));
  assert.ok(args.includes('1:a:0'));
  assert.ok(args.includes('+faststart'));
  assert.ok(!args.some(arg => arg.includes('http')));
});

test('prepared local byte ranges clamp endpoints and support suffix ranges', () => {
  assert.deepEqual(preparedRange('bytes=2-999', 10), { start: 2, end: 9, partial: true });
  assert.deepEqual(preparedRange('bytes=-3', 10), { start: 7, end: 9, partial: true });
  assert.throws(() => preparedRange('bytes=10-', 10));
});

test('public page resolution preserves available plans without leaking source URLs', async () => {
  const service = createMediaService(config, { extract: async () => ({ title: 'Actual page video', platform: 'youtube', formats: plans() }) });
  try {
    const result = await service.resolve('https://youtube.com/watch?v=example');
    assert.equal(result.kind, 'video');
    assert.deepEqual(result.formats.map(format => format.id), ['progressive', 'merged']);
    assert.ok(result.formats.every(format => !('sources' in format)));
    assert.throws(() => service.prepare(service.registry.get(result.id), '--exec attacker'));
  } finally { await service.dispose(); }
});

test('real ffmpeg merges original audio/video, shares preparation, caches and cleans files', { skip: !available }, async () => {
  let requests = 0;
  const service = createMediaService(config, { lookup: dns, request: sourceTransport(() => requests++), extract: async () => ({ title: 'Merge test', platform: 'youtube', formats: plans() }) });
  let path: string | undefined;
  try {
    const result = await service.resolve('https://youtube.com/watch?v=example');
    const record = service.registry.get(result.id);
    const [first, second] = await Promise.all([service.prepare(record, 'merged'), service.prepare(record, 'merged')]);
    assert.equal(first.path, second.path);
    assert.equal(first.size, (await stat(first.path)).size);
    assert.equal(first.mimeType, 'video/mp4');
    assert.equal(requests, 2, 'one bounded download per original track');
    await execute(config.ffmpegPath, offlineFfmpegArgs([{ path: first.path, container: 'mp4' }]), { windowsHide: true, timeout: 10000 });
    path = first.path;
    first.release(); second.release();
    const cached = await service.prepare(record, 'merged');
    assert.equal(cached.path, path);
    assert.equal(requests, 2);
    cached.release();
    const progressive = await service.prepare(record, 'progressive');
    assert.equal(progressive.size, combined.length);
    progressive.release();
  } finally { await service.dispose(); }
  if (path) await assert.rejects(access(path));
});

test('real ffmpeg rejects a claimed progressive video that lacks audio and removes partial files', { skip: !available }, async () => {
  const temporaryRoot = await mkdtemp(join(fixtures, 'failure-root-'));
  const store = new PreparedMediaStore(config, { lookup: dns, request: sourceTransport() }, temporaryRoot);
  const registry = new MediaRegistry(900);
  const record = registry.create({ url: 'https://youtube.com/watch?v=test', title: 'Incomplete', media: { kind: 'video', extension: 'mp4', mimeType: 'video/mp4' } });
  const plan: ExtractedFormat = { ...plans()[0], sources: [{ url: 'https://cdn.example.org/video.mp4' }] };
  try {
    await assert.rejects(store.acquire(record, plan), (error: unknown) => error instanceof ApiError && error.code === 'PROCESSING_FAILED');
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally { await store.dispose(); }
});

test('page API downloads the selected real merged video and serves cached preview ranges', { skip: !available }, async () => {
  const app = createApp(config, { lookup: dns, request: sourceTransport(), extract: async () => ({ title: 'Video with audio', platform: 'youtube', formats: plans() }) });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test API did not start');
  const url = `http://127.0.0.1:${address.port}/api`;
  try {
    const response = await fetch(`${url}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://youtube.com/watch?v=test' }) });
    const media = await response.json() as { id: string; formats: { id: string; sources?: unknown }[] };
    assert.equal(response.status, 200);
    assert.ok(media.formats.every(format => !format.sources));
    assert.equal((await fetch(`${url}/media/${media.id}?format=unlisted`)).status, 400);
    const download = await fetch(`${url}/media/${media.id}?format=merged&disposition=attachment`);
    assert.equal(download.status, 200);
    const downloaded = Buffer.from(await download.arrayBuffer());
    assert.equal(Number(download.headers.get('content-length')), downloaded.length);
    assert.equal(download.headers.get('content-type'), 'video/mp4');
    const preview = await fetch(`${url}/media/${media.id}?format=merged&disposition=inline`, { headers: { Range: 'bytes=0-31' } });
    assert.equal(preview.status, 206);
    assert.equal(preview.headers.get('content-length'), '32');
    assert.equal(preview.headers.get('content-range'), `bytes 0-31/${downloaded.length}`);
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), downloaded.subarray(0, 32));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await app.locals.dispose();
  }
});

test('aggregate source-byte limit stops preparation and removes partial files', { skip: !available }, async () => {
  const temporaryRoot = await mkdtemp(join(fixtures, 'limit-root-'));
  const smallConfig = { ...config, maxFileBytes: video.length + audio.length - 1 };
  const store = new PreparedMediaStore(smallConfig, { lookup: dns, request: sourceTransport() }, temporaryRoot);
  const registry = new MediaRegistry(900);
  const record = registry.create({ url: 'https://youtube.com/watch?v=test', title: 'Limit', media: { kind: 'video', extension: 'mp4', mimeType: 'video/mp4' } });
  try {
    await assert.rejects(store.acquire(record, plans()[1]), (error: unknown) => error instanceof ApiError && error.code === 'FILE_TOO_LARGE');
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally { await store.dispose(); }
});

test('real progressive preparation joins capped sequential ranges with checked DNS on every request', { skip: !available }, async () => {
  const temporaryRoot = await mkdtemp(join(fixtures, 'range-root-'));
  const ranges: string[] = [];
  let lookups = 0;
  const store = new PreparedMediaStore(config, { lookup: async () => { lookups++; return dns(); }, request: async (_url, _address, _config, range) => {
    assert.ok(range);
    ranges.push(range!);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range!)!;
    const start = Number(match[1]);
    const end = Math.min(start + 511, Number(match[2]), combined.length - 1);
    const part = combined.subarray(start, end + 1);
    return { statusCode: 206, headers: { 'content-type': 'video/mp4', 'content-length': String(part.length), 'content-range': `bytes ${start}-${end}/${combined.length}` }, body: Readable.from([part]), destroy() { this.body.destroy(); } };
  } }, temporaryRoot);
  const record = new MediaRegistry(900).create({ url: 'https://example.org/page', title: 'Ranges', media: { kind: 'video', extension: 'mp4', mimeType: 'video/mp4' } });
  try {
    const lease = await store.acquire(record, plans()[0]);
    assert.deepEqual(await readFile(lease.path), combined);
    assert.equal(lease.size, combined.length);
    assert.ok(ranges.length > 1);
    assert.equal(lookups, ranges.length);
    lease.release();
  } finally { await store.dispose(); }
});

test('overlapping and incomplete source ranges are rejected with partial-file cleanup', async () => {
  for (const mode of ['overlap', 'incomplete']) {
    const temporaryRoot = await mkdtemp(join(fixtures, `bad-${mode}-`));
    let requests = 0;
    const store = new PreparedMediaStore(config, { lookup: dns, request: async () => {
      const requestIndex = requests++;
      const start = 0;
      const end = mode === 'incomplete' ? 63 : 31;
      const bytes = Buffer.alloc(32);
      return { statusCode: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/64` }, body: Readable.from([bytes]), destroy() { this.body.destroy(); } };
    } }, temporaryRoot);
    const record = new MediaRegistry(900).create({ url: 'https://example.org/page', title: 'Bad range', media: { kind: 'video', extension: 'mp4', mimeType: 'video/mp4' } });
    try {
      await assert.rejects(store.acquire(record, plans()[0]), (error: unknown) => error instanceof ApiError && error.code === (mode === 'incomplete' ? 'INCOMPLETE_SOURCE' : 'INVALID_SOURCE_RANGE'));
      assert.deepEqual(await readdir(temporaryRoot), []);
      assert.equal(requests, mode === 'incomplete' ? 1 : 2);
    } finally { await store.dispose(); }
  }
});

test('cancelling a preparation removes partial files and closes the source stream', async () => {
  const temporaryRoot = await mkdtemp(join(fixtures, 'abort-root-'));
  const controller = new AbortController();
  let opened!: () => void;
  const entered = new Promise<void>(resolve => { opened = resolve; });
  const body = new Readable({ read() {} });
  const store = new PreparedMediaStore(config, { lookup: dns, request: async () => {
    opened(); return { statusCode: 200, headers: { 'content-type': 'video/mp4' }, body, destroy() { body.destroy(); } };
  } }, temporaryRoot);
  const registry = new MediaRegistry(900);
  const record = registry.create({ url: 'https://youtube.com/watch?v=test', title: 'Cancelled', media: { kind: 'video', extension: 'mp4', mimeType: 'video/mp4' } });
  try {
    const waiting = store.acquire(record, plans()[0], controller.signal);
    await entered;
    controller.abort();
    await assert.rejects(waiting);
    await store.dispose();
    assert.equal(body.destroyed, true);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally { await store.dispose(); }
});
