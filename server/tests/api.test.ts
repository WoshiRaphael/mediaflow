import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { PinnedRequest } from '../src/upstream.js';

const image = Buffer.from('GIF89a\u0002\u0000\u0003\u0000' + '\u0000'.repeat(300), 'binary');
let changed = false;
const request: PinnedRequest = async (url, _address, _config, range) => {
  const bytes = url.pathname === '/html' || (changed && url.pathname === '/change') ? Buffer.from('<html>not media</html>') : image;
  const mime = url.pathname === '/mismatch' ? 'text/html' : 'image/gif';
  if (url.pathname === '/ranged' && range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)!;
    const start = Number(match[1]);
    const end = Math.min(Number(match[2] || bytes.length - 1), bytes.length - 1);
    const part = bytes.subarray(start, end + 1);
    return { statusCode: 206, headers: { 'content-type': mime, 'content-length': String(part.length), 'content-range': `bytes ${start}-${end}/${bytes.length}` }, body: Readable.from([part]), destroy() { this.body.destroy(); } };
  }
  if (url.pathname === '/unknown-size') {
    return { statusCode: 200, headers: { 'content-type': 'image/gif' }, body: Readable.from([Buffer.concat([image, Buffer.alloc(1500)])]), destroy() { this.body.destroy(); } };
  }
  return { statusCode: 200, headers: { 'content-type': mime, 'content-length': String(bytes.length) }, body: Readable.from([bytes]), destroy() { this.body.destroy(); } };
};
const config = loadConfig({ RATE_LIMIT_PER_MINUTE: '100' });
const server = createServer(createApp(config, { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request }));
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not start');
const base = `http://127.0.0.1:${address.port}`;
after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
async function resolveUrl(path = '/test.gif') {
  return fetch(`${base}/api/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: JSON.stringify({ url: `https://images.unsplash.com${path}` }) });
}

test('real API resolves signature and downloads bytes with safe headers', async () => {
  const resolved = await resolveUrl();
  assert.equal(resolved.status, 200);
  const media = await resolved.json() as { id: string; kind: string; formats: { size: number; width: number; height: number }[] };
  assert.equal(media.kind, 'photo');
  assert.equal(media.formats[0].size, image.length);
  assert.equal(media.formats[0].width, 2);
  assert.equal(media.formats[0].height, 3);
  const downloaded = await fetch(`${base}/api/media/${media.id}?format=original&disposition=attachment`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'image/gif');
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
  assert.match(downloaded.headers.get('content-disposition')!, /^attachment; filename="/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), image);
});

test('unsupported pages and mismatched declared content return clear errors', async () => {
  for (const path of ['/html', '/mismatch']) {
    const result = await resolveUrl(path);
    assert.equal(result.status, 422);
    const payload = await result.json() as { error: { code: string } };
    assert.match(payload.error.code, /UNSUPPORTED_MEDIA|CONTENT_TYPE_MISMATCH/);
  }
});

test('byte range previews retain actual range and length metadata', async () => {
  const resolved = await resolveUrl('/ranged');
  const media = await resolved.json() as { id: string; formats: { size: number }[] };
  assert.equal(media.formats[0].size, image.length);
  const preview = await fetch(`${base}/api/media/${media.id}?disposition=inline`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(preview.status, 206);
  assert.equal(preview.headers.get('content-range'), `bytes 10-19/${image.length}`);
  assert.equal(preview.headers.get('content-length'), '10');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), image.subarray(10, 20));
});

test('download is revalidated when a source changes after resolve', async () => {
  const resolved = await resolveUrl('/change');
  const media = await resolved.json() as { id: string };
  changed = true;
  const downloaded = await fetch(`${base}/api/media/${media.id}`);
  changed = false;
  assert.equal(downloaded.status, 422);
  assert.match((await downloaded.json() as { error: { code: string } }).error.code, /UNSUPPORTED_MEDIA|MEDIA_CHANGED/);
});

test('batch contains individual errors and rejects more than five URLs', async () => {
  const batch = await fetch(`${base}/api/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: ['https://images.unsplash.com/test.gif', 'https://youtube.com/watch?v=1'] }) });
  const payload = await batch.json() as { results: { media?: unknown; error?: { code: string } }[] };
  assert.equal(payload.results.length, 2);
  assert.ok(payload.results[0].media);
  assert.equal(payload.results[1].error?.code, 'PLATFORM_RESTRICTED');
  const oversized = await fetch(`${base}/api/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: Array(6).fill('https://images.unsplash.com/test.gif') }) });
  assert.equal(oversized.status, 400);
});

test('CORS is exact and unknown formats / multipart ranges cannot reach source', async () => {
  const denied = await fetch(`${base}/api/health`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(denied.status, 403);
  const resolveResponse = await resolveUrl();
  const media = await resolveResponse.json() as { id: string };
  assert.equal((await fetch(`${base}/api/media/${media.id}?format=4k`)).status, 400);
  assert.equal((await fetch(`${base}/api/media/${media.id}`, { headers: { Range: 'bytes=0-1,3-4' } })).status, 416);
  const invalidJson = await fetch(`${base}/api/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
});

test('unknown-length content cannot exceed the configured file cap', async () => {
  const bounded = createServer(createApp(loadConfig({ MAX_FILE_BYTES: '1024' }), { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request }));
  await new Promise<void>(resolve => bounded.listen(0, '127.0.0.1', resolve));
  const address = bounded.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start');
  const url = `http://127.0.0.1:${address.port}/api`;
  try {
    const resolved = await fetch(`${url}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://images.unsplash.com/unknown-size' }) });
    assert.equal(resolved.status, 200);
    const media = await resolved.json() as { id: string; formats: { size?: number }[] };
    assert.equal(media.formats[0].size, undefined);
    const downloaded = await fetch(`${url}/media/${media.id}`);
    assert.equal(downloaded.status, 413);
    assert.equal((await downloaded.json() as { error: { code: string } }).error.code, 'FILE_TOO_LARGE');
  } finally { bounded.closeAllConnections(); await new Promise<void>(resolve => bounded.close(() => resolve())); }
});

test('per-client rate limit rejects excess resolves with structured error', async () => {
  const limited = createServer(createApp(loadConfig({ RATE_LIMIT_PER_MINUTE: '1' }), { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request }));
  await new Promise<void>(resolve => limited.listen(0, '127.0.0.1', resolve));
  const address = limited.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start');
  const url = `http://127.0.0.1:${address.port}/api/resolve`;
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://images.unsplash.com/test.gif' }) };
  try {
    assert.equal((await fetch(url, init)).status, 200);
    const rejected = await fetch(url, init);
    assert.equal(rejected.status, 429);
    assert.equal((await rejected.json() as { error: { code: string } }).error.code, 'RATE_LIMITED');
  } finally { limited.closeAllConnections(); await new Promise<void>(resolve => limited.close(() => resolve())); }
});

test('disconnect before upstream headers releases the download slot and disposes a late response', async () => {
  let hold = true;
  let entered!: () => void;
  let observedAbort!: () => void;
  let completeLate!: (value: Awaited<ReturnType<PinnedRequest>>) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const aborted = new Promise<void>(resolve => { observedAbort = resolve; });
  const controlled: PinnedRequest = async (url, address, config, range, signal) => {
    if (!range && hold) {
      hold = false;
      signal!.addEventListener('abort', observedAbort, { once: true });
      entered();
      // Deliberately ignore abort and finish later, exercising the transport's
      // disposal path as well as immediate application-slot cleanup.
      return new Promise(resolve => { completeLate = resolve; });
    }
    return request(url, address, config, range, signal);
  };
  const isolated = createServer(createApp(loadConfig({ MAX_CONCURRENT_DOWNLOADS: '1' }), { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: controlled }));
  await new Promise<void>(resolve => isolated.listen(0, '127.0.0.1', resolve));
  const address = isolated.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start');
  const url = `http://127.0.0.1:${address.port}/api`;
  try {
    const resolved = await fetch(`${url}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://images.unsplash.com/test.gif' }) });
    const media = await resolved.json() as { id: string };
    const disconnected = httpRequest(`${url}/media/${media.id}`);
    disconnected.on('error', () => {});
    disconnected.end();
    await started;
    disconnected.destroy();
    await aborted;
    await new Promise<void>(resolve => setImmediate(resolve));
    const next = await fetch(`${url}/media/${media.id}`);
    assert.equal(next.status, 200, 'the aborted request must release the only transfer slot');
    assert.deepEqual(Buffer.from(await next.arrayBuffer()), image);
    const late = await request(new URL('https://images.unsplash.com/test.gif'), { address: '8.8.8.8', family: 4 }, config);
    completeLate(late);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(late.body.destroyed, true);
  } finally { isolated.closeAllConnections(); await new Promise<void>(resolve => isolated.close(() => resolve())); }
});

test('disconnects release all occupied resolve slots before pending headers finish', async () => {
  const lateResponses: ((value: Awaited<ReturnType<PinnedRequest>>) => void)[] = [];
  let holding = true;
  let allStarted!: () => void;
  let allCancelled!: () => void;
  let cancelled = 0;
  const started = new Promise<void>(resolve => { allStarted = resolve; });
  const aborted = new Promise<void>(resolve => { allCancelled = resolve; });
  const controlled: PinnedRequest = async (url, address, config, range, signal) => {
    if (!holding) return request(url, address, config, range, signal);
    signal!.addEventListener('abort', () => { if (++cancelled === 12) allCancelled(); }, { once: true });
    return new Promise(resolve => {
      lateResponses.push(resolve);
      if (lateResponses.length === 12) allStarted();
    });
  };
  const isolated = createServer(createApp(loadConfig({ RATE_LIMIT_PER_MINUTE: '100' }), { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: controlled }));
  await new Promise<void>(resolve => isolated.listen(0, '127.0.0.1', resolve));
  const address = isolated.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start');
  const url = `http://127.0.0.1:${address.port}/api/resolve`;
  const body = JSON.stringify({ url: 'https://images.unsplash.com/test.gif' });
  const clients = Array.from({ length: 12 }, () => {
    const client = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    client.on('error', () => {});
    client.end(body);
    return client;
  });
  try {
    await started;
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 503);
    for (const client of clients) client.destroy();
    await aborted;
    await new Promise<void>(resolve => setImmediate(resolve));
    holding = false;
    const next = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(next.status, 200, 'disconnect must immediately release occupied resolve slots');
    await next.arrayBuffer();
    for (const complete of lateResponses) complete(await request(new URL('https://images.unsplash.com/test.gif'), { address: '8.8.8.8', family: 4 }, config));
  } finally {
    for (const client of clients) client.destroy();
    isolated.closeAllConnections();
    await new Promise<void>(resolve => isolated.close(() => resolve()));
  }
});
