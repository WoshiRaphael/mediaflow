import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { detectMedia, filename } from '../src/media.js';
import { MediaRegistry } from '../src/registry.js';
import { isPublicAddress, parseByteRange, resolvePublicAddress, validateUrl } from '../src/security.js';
import { checkDeclaredSize, openMedia, pinnedLookup, type UpstreamResponse } from '../src/upstream.js';

const config = loadConfig({});
const response = (statusCode = 200, headers = {}): UpstreamResponse => ({ statusCode, headers, body: Readable.from([]), destroy() { this.body.destroy(); } });

test('blocks private, reserved, metadata, mapped, transition and documentation IPs', () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.1.1.1', '169.254.169.254', '168.63.129.16', '172.16.1.1', '192.168.1.1', '100.64.0.1', '192.0.2.1', '198.18.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1', '2001:db8::1', '3fff::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

test('rejects mixed DNS answer sets, including a rebinding answer', async () => {
  await assert.rejects(resolvePublicAddress('images.unsplash.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), (error: unknown) => error instanceof ApiError && error.code === 'UNSAFE_SOURCE');
  await assert.rejects(resolvePublicAddress('images.unsplash.com', async () => []));
});

test('validates scheme, userinfo, ports, exact allowlist and platform restrictions', () => {
  for (const url of ['http://images.unsplash.com/test.jpg', 'https://user:pass@images.unsplash.com/a', 'https://images.unsplash.com:444/a', 'https://images.unsplash.com.attacker.test/a', 'https://127.0.0.1/a', 'file:///test.jpg', 'https://images.unsplash.com./a']) assert.throws(() => validateUrl(url, config));
  assert.throws(() => validateUrl('https://www.youtube.com/watch?v=a', config), (error: unknown) => error instanceof ApiError && error.code === 'PLATFORM_RESTRICTED');
  assert.equal(validateUrl('https://images.unsplash.com/photo?a=1#fragment', config).href, 'https://images.unsplash.com/photo?a=1');
});

test('pins the checked DNS answer and rechecks allowed redirects', async () => {
  const lookedUp: string[] = [];
  const requested: string[] = [];
  const opened = await openMedia('https://images.unsplash.com/a', config, undefined, {
    lookup: async host => { lookedUp.push(host); return [{ address: '8.8.8.8', family: 4 }]; },
    request: async (url, address) => {
      assert.deepEqual(address, { address: '8.8.8.8', family: 4 });
      requested.push(url.href);
      return requested.length === 1 ? response(302, { location: 'https://upload.wikimedia.org/b' }) : response();
    },
  });
  assert.deepEqual(lookedUp, ['images.unsplash.com', 'upload.wikimedia.org']);
  assert.equal(opened.url.hostname, 'upload.wikimedia.org');
});

test('pinned lookup supports Node single-address and auto-selection callback modes', () => {
  const lookup = pinnedLookup({ address: '8.8.8.8', family: 4 });
  lookup('images.unsplash.com', {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
  });
  lookup('images.unsplash.com', { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
  });
});

test('redirect to a local address or unapproved host never reaches transport', async () => {
  let count = 0;
  await assert.rejects(openMedia('https://images.unsplash.com/a', config, undefined, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => { count++; return response(302, { location: 'http://169.254.169.254/latest/meta-data' }); },
  }));
  assert.equal(count, 1);
});

test('redirect DNS rebinding is rejected even for the same allowlisted hostname', async () => {
  let lookups = 0;
  let requests = 0;
  await assert.rejects(openMedia('https://images.unsplash.com/a', config, undefined, {
    lookup: async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '10.0.0.1', family: 4 }],
    request: async () => { requests++; return response(302, { location: '/b' }); },
  }));
  assert.equal(requests, 1);
});

test('cancelling a pending DNS lookup rejects promptly and never opens a socket', async () => {
  const controller = new AbortController();
  let finishLookup!: (addresses: { address: string; family: 4 }[]) => void;
  let requests = 0;
  const pending = openMedia('https://images.unsplash.com/a', config, undefined, {
    lookup: () => new Promise(resolve => { finishLookup = resolve; }),
    request: async () => { requests++; return response(); },
  }, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  finishLookup([{ address: '8.8.8.8', family: 4 }]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
});

test('cancelling pending response headers destroys a late non-cooperative adapter response', async () => {
  const controller = new AbortController();
  let finishRequest!: (value: UpstreamResponse) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = openMedia('https://images.unsplash.com/a', config, undefined, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async (_url, _address, _config, _range, signal) => {
      assert.equal(signal, controller.signal);
      started();
      return new Promise(resolve => { finishRequest = resolve; });
    },
  }, controller.signal);
  await entered;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  const late = response();
  finishRequest(late);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(late.body.destroyed, true);
});

test('rejects oversized total size even when a probe is only 64 KiB', () => {
  assert.throws(() => checkDeclaredSize(response(206, { 'content-range': 'bytes 0-65535/104857601', 'content-length': '65536' }), config.maxFileBytes));
  assert.equal(checkDeclaredSize(response(206, { 'content-range': 'bytes 0-99/1000', 'content-length': '100' }), config.maxFileBytes), 1000);
});

test('sniffs supported media and rejects HTML, SVG and arbitrary text', () => {
  assert.equal(detectMedia(Buffer.from([255, 216, 255, 224])).extension, 'jpg');
  assert.equal(detectMedia(Buffer.from('GIF89a\u0001\u0000\u0001\u0000')).extension, 'gif');
  for (const value of ['<!DOCTYPE html><html></html>', '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'fake.mp4']) assert.throws(() => detectMedia(Buffer.from(value)));
  assert.equal(filename('a";\r\nX-Evil: yes', 'jpg'), 'aX-Evil yes.jpg');
});

test('supports one safe range and rejects multipart and invalid ranges', () => {
  assert.equal(parseByteRange('bytes=0-99', 100), 'bytes=0-99');
  assert.equal(parseByteRange('bytes=-32', 100), 'bytes=-32');
  for (const range of ['bytes=0-2,4-6', 'bytes=9-2', 'bytes=-0', 'bytes=100-', 'bytes=999999999999999999999-', 'items=0-1']) assert.throws(() => parseByteRange(range, 100));
});

test('opaque registry tokens expire and never accept URL-shaped IDs', () => {
  let now = 1000;
  const registry = new MediaRegistry(60, 2, () => now);
  const record = registry.create({ url: 'https://images.unsplash.com/a.jpg', title: 'a', media: { kind: 'photo', extension: 'jpg', mimeType: 'image/jpeg' } });
  assert.match(record.id, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(registry.get(record.id).url, record.url);
  assert.throws(() => registry.get('https://evil.example/a'));
  now += 60001;
  assert.throws(() => registry.get(record.id), (error: unknown) => error instanceof ApiError && error.code === 'MEDIA_EXPIRED');
});
