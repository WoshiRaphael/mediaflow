import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import { createExtractorEgress, extractorEnvironment } from '../src/egress.js';
import { cancelExtractions, extractionError, extractVideoPage, parseExtractedVideo } from '../src/extractor.js';
import { loadConfig } from '../src/config.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = 'https://www.youtube.com/watch?v=example';
const base = { title: 'A public test video', extractor_key: 'Youtube', duration: 5 };
const combined = { format_id: 'source-720', url: 'https://cdn.example.org/movie.mp4', protocol: 'https', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a.40.2', width: 1280, height: 720, filesize: 1000 };

test('explicit bot verification takes precedence over sign-in wording and HTTP429', () => {
  const error = extractionError("WARNING: HTTP Error 429: Too Many Requests\nERROR: Sign in to confirm you're not a bot. https://example.org/private?token=secret", 'YouTube');
  assert.equal(error.code, 'PLATFORM_BOT_CHECK');
  assert.match(error.message, /YouTube.*bot verification/);
  assert.match(error.message, /may still play in your browser/);
  assert.match(error.message, /cannot currently be downloaded from this host/);
  assert.doesNotMatch(error.message, /secret|example\.org|https:/);
});

test('HTTP429 without a bot challenge identifies hosting-server rate limiting', () => {
  const error = extractionError('ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests', 'YouTube');
  assert.equal(error.code, 'SOURCE_RATE_LIMITED');
  assert.equal(error.status, 429);
  assert.match(error.message, /hosting server/);
  assert.doesNotMatch(error.message, /bot|private|removed/);
});

test('a forbidden proxy tunnel does not establish a platform bot block', () => {
  const error = extractionError('ERROR: ProxyError: Tunnel connection failed: 403 Forbidden', 'YouTube');
  assert.equal(error.code, 'SOURCE_ACCESS_DENIED');
  assert.doesNotMatch(error.message, /bot|YouTube is blocking|requires account/);
  assert.equal(extractionError('WARNING: HTTP Error 403: Forbidden\nERROR: No video formats found').code, 'SOURCE_ACCESS_DENIED');
});

test('unclassified extractor failures disclose no raw diagnostics or unsupported assumptions', () => {
  const error = extractionError('ERROR: unexpected value https://example.org/path?token=secret user@example.org personal-data', 'https://unsafe.example/secret');
  assert.equal(error.code, 'SOURCE_UNAVAILABLE');
  assert.match(error.message, /MediaFlow's server could not retrieve/);
  assert.doesNotMatch(error.message, /secret|example|personal-data|removed|restricted|blocked/);
  assert.equal(extractionError('DRM protected stream').code, 'PROTECTED_VIDEO');
  assert.equal(extractionError('Private video; login required').code, 'LOGIN_REQUIRED');
  assert.equal(extractionError('The connection timed out').code, 'SOURCE_TIMEOUT');
});

test('real format plans include only complete, safe video+audio choices', () => {
  const parsed = parseExtractedVideo({ ...base, formats: [combined,
    { ...combined, height: 1080, acodec: 'none', url: 'https://cdn.example.org/video.mp4', filesize: 1500 },
    { format_id: 'audio', url: 'https://cdn.example.org/audio.m4a', ext: 'm4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 300 },
    { ...combined, height: 2160, has_drm: true },
    { ...combined, height: 1440, url: 'file:///etc/passwd' },
    { ...combined, height: 480, protocol: 'm3u8_native' },
  ] }, url, 10000);
  assert.equal(parsed.platform, 'youtube');
  assert.equal(parsed.formats.length, 2);
  assert.equal(parsed.formats[0].height, 720);
  const merged = parsed.formats.find(format => format.needsMerge)!;
  assert.equal(merged.height, 1080); assert.equal(merged.size, 1800);
  assert.equal(merged.sources.length, 2);
  assert.ok(parsed.formats.every(format => format.hasAudio));
});

test('source credentials and arbitrary headers never reach a download plan', () => {
  const parsed = parseExtractedVideo({ ...base, formats: [{ ...combined, http_headers: {
    Cookie: 'private', Authorization: 'secret', Host: '127.0.0.1', 'Proxy-Authorization': 'secret',
    'User-Agent': 'Public player', Referer: 'https://www.youtube.com/watch?v=example', 'X-Injected': 'a\r\nb: c',
  } }] }, url, 10000);
  assert.deepEqual(parsed.formats[0].sources[0].headers, { 'User-Agent': 'Public player', Referer: url });
  assert.throws(() => parseExtractedVideo({ ...base, formats: [{ ...combined, url: 'https://user:secret@cdn.example.org/a.mp4' }] }, url, 10000));
  assert.throws(() => parseExtractedVideo({ ...base, formats: [{ ...combined, url: 'https://127.0.0.1/a.mp4' }] }, url, 10000));
});

test('progressive files without codec metadata remain eligible for local stream verification', () => {
  const parsed = parseExtractedVideo({ title: 'Public HTML5 video', url: 'https://cdn.example.org/movie.mp4', ext: 'mp4', protocol: 'https' }, 'https://example.org/watch', 10000);
  assert.equal(parsed.formats.length, 1);
  assert.equal(parsed.formats[0].needsMerge, undefined);
  assert.equal(parsed.formats[0].videoCodec, undefined);
  assert.equal(parsed.formats[0].hasAudio, undefined);
  assert.doesNotMatch(parsed.formats[0].label, /video \+ audio|video only/);
  assert.equal(parsed.formats[0].sources.length, 1);
});

test('protected videos, live streams, playlists and oversized sources are rejected', () => {
  for (const extra of [{ has_drm: true }, { is_live: true }, { availability: 'private' }, { _type: 'playlist', entries: [] }]) {
    assert.throws(() => parseExtractedVideo({ ...base, formats: [combined], ...extra }, url, 10000));
  }
  assert.throws(() => parseExtractedVideo({ ...base, formats: [combined] }, url, 10));
});

test('explicitly silent videos remain available with truthful video-only metadata', () => {
  const parsed = parseExtractedVideo({ ...base, formats: [{ ...combined, acodec: 'none' }] }, url, 10000);
  assert.equal(parsed.formats.length, 1);
  assert.equal(parsed.formats[0].hasAudio, false);
  assert.equal(parsed.formats[0].audioCodec, 'none');
  assert.match(parsed.formats[0].label, /video only/);
  assert.equal(parsed.formats[0].sources.length, 1);
  assert.equal(parsed.formats[0].needsMerge, undefined);
});

test('available compatible audio is joined and complete formats outrank silent copies at the same height', () => {
  const silent = { ...combined, acodec: 'none', tbr: 9999 };
  const preferred = parseExtractedVideo({ ...base, formats: [silent, { ...combined, tbr: 1 }] }, url, 10000);
  assert.equal(preferred.formats[0].hasAudio, true);
  assert.equal(preferred.formats[0].sources.length, 1);
  const merged = parseExtractedVideo({ ...base, formats: [silent,
    { format_id: 'audio', url: 'https://cdn.example.org/audio.m4a', ext: 'm4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 300 },
  ] }, url, 10000);
  assert.equal(merged.formats[0].hasAudio, true);
  assert.equal(merged.formats[0].sources.length, 2);
  assert.equal(merged.formats[0].needsMerge, true);
});

test('extractor process never inherits proxy bypasses or account credentials', () => {
  const previous = process.env.NO_PROXY;
  process.env.NO_PROXY = '*';
  try {
    const environment = extractorEnvironment('http://guard.example');
    assert.equal(environment.NO_PROXY, ''); assert.equal(environment.no_proxy, '');
    assert.equal(environment.HTTPS_PROXY, 'http://guard.example');
    assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(environment.HOME, undefined);
  } finally { if (previous === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previous; }
});

async function tunnel(proxy: string, authority: string, authorized = true): Promise<string> {
  const address = new URL(proxy);
  const auth = Buffer.from(`${address.username}:${address.password}`).toString('base64');
  const socket = connect({ host: address.hostname, port: Number(address.port) });
  await once(socket, 'connect');
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorized ? `Proxy-Authorization: Basic ${auth}\r\n` : ''}\r\n`);
  try {
    const chunks: Buffer[] = [];
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Proxy fixture timeout')); }, 2000);
      socket.on('data', bytes => { chunks.push(bytes); if (Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n'))) { clearTimeout(timeout); resolve(Buffer.concat(chunks).toString()); } });
      socket.on('error', reject);
      socket.on('end', () => { clearTimeout(timeout); resolve(Buffer.concat(chunks).toString()); });
    });
  } finally { socket.destroy(); }
}

test('private proxy requires authentication and rejects unsafe authorities before DNS', async () => {
  let lookups = 0;
  const egress = await createExtractorEgress(undefined, { lookup: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; } });
  try {
    assert.match(await tunnel(egress.url, 'example.org:443', false), /407/);
    for (const authority of ['127.0.0.1:443', '[::1]:443', 'example.org:80', 'user@example.org:443', 'example.org:443/private']) assert.match(await tunnel(egress.url, authority), /403/);
    assert.equal(lookups, 0);
  } finally { egress.close(); }
});

test('proxy rejects mixed DNS answers and never opens a connection to private networks', async () => {
  let connected = false;
  const egress = await createExtractorEgress(undefined, { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], connect: () => { connected = true; throw new Error('must not connect'); } });
  try { assert.match(await tunnel(egress.url, 'example.org:443'), /403/); assert.equal(connected, false); }
  finally { egress.close(); }
});

test('a checked DNS address is pinned and CONNECT tunnel can transfer data', async () => {
  const fixture = createServer(socket => socket.end('fixture'));
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const port = (fixture.address() as { port: number }).port;
  let checked = '';
  let lookups = 0;
  const egress = await createExtractorEgress(undefined, {
    lookup: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; },
    connect: address => { checked = address.address; return connect({ host: '127.0.0.1', port }); },
  });
  try { assert.match(await tunnel(egress.url, 'example.org:443'), /200 Connection Established/); assert.equal(checked, '8.8.8.8'); assert.equal(lookups, 1); }
  finally { egress.close(); fixture.close(); }
});

test('cancelled proxy DNS lookup cannot create a late connection', async () => {
  const controller = new AbortController(); let connected = false;
  let release!: (value: { address: string; family: 4 }[]) => void;
  const egress = await createExtractorEgress(controller.signal, { lookup: () => new Promise(resolve => { release = resolve; }), connect: () => { connected = true; throw new Error('must not connect'); } });
  const address = new URL(egress.url);
  const socket = connect({ host: address.hostname, port: Number(address.port) }); await once(socket, 'connect');
  const auth = Buffer.from(`${address.username}:${address.password}`).toString('base64');
  socket.write(`CONNECT example.org:443 HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(); release([{ address: '8.8.8.8', family: 4 }]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(connected, false); socket.destroy(); egress.close();
});

test('shutdown cancellation stops a real active extractor process and waits for cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mediaflow-shutdown-test-'));
  const script = join(directory, 'worker.mjs');
  const marker = join(directory, 'started.json');
  await writeFile(script, 'import fs from "node:fs"; fs.writeFileSync(new URL("./started.json", import.meta.url), JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);');
  const config = loadConfig({ PYTHON_PATH: process.execPath, EXTRACTOR_PATH: script, DENO_PATH: script });
  const pending = extractVideoPage('https://example.org/watch', config).then(() => undefined, error => error);
  try {
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = JSON.parse(await readFile(marker, 'utf8')).pid; break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.ok(pid, 'the real subprocess must have started');
    await cancelExtractions();
    const error = await pending;
    assert.equal(error?.name, 'AbortError');
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid!, 0); } catch { alive = false; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(alive, false, 'shutdown must terminate the extractor process');
  } finally { await cancelExtractions(); await rm(directory, { recursive: true, force: true }); }
});
