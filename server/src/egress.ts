import { createServer } from 'node:http';
import { connect as connectTcp, isIP, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { resolvePublicAddress, type Lookup, type ResolvedAddress } from './security.js';
import { ApiError } from './errors.js';

export interface EgressDependencies {
  lookup?: Lookup;
  connect?: (address: ResolvedAddress) => Socket;
}

/** The extractor receives a private, authenticated CONNECT endpoint, never an
 * unrestricted public proxy. Every tunnel gets its own checked, pinned IP. */
export async function createExtractorEgress(signal?: AbortSignal, dependencies: EgressDependencies = {}) {
  signal?.throwIfAborted();
  const password = randomBytes(32).toString('hex');
  const authorization = `Basic ${Buffer.from(`mediaflow:${password}`).toString('base64')}`;
  const sockets = new Set<Socket>();
  let closed = false;
  let attempts = 0;
  let transferred = 0;
  const maxBytes = 32 * 1024 * 1024;
  const server = createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(405, { Connection: 'close' }).end();
  });
  server.maxConnections = 12;
  server.headersTimeout = 10000;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    signal?.removeEventListener('abort', close);
  };
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(20000, () => socket.destroy());
    socket.on('data', chunk => {
      transferred += chunk.length;
      if (transferred > maxBytes) close();
    });
  };
  server.on('connection', socket => { track(socket); if (closed) socket.destroy(); });
  server.on('connect', (request, client, head) => {
    const socket = client as Socket;
    const deny = (status: number) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); };
    if (closed || request.headers['proxy-authorization'] !== authorization) { deny(407); return; }
    if (++attempts > 48) { deny(429); return; }
    const authority = request.url || '';
    const match = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):443$/i.exec(authority);
    if (!match || !match[1].includes('.') || match[1].includes('..') || isIP(match[1])) { deny(403); return; }
    const hostname = match[1].toLowerCase();
    let timer: NodeJS.Timeout | undefined;
    const cancel = () => socket.destroy();
    signal?.addEventListener('abort', cancel, { once: true });
    const cleanup = () => { signal?.removeEventListener('abort', cancel); if (timer) clearTimeout(timer); };
    socket.once('close', cleanup);
    void Promise.race([
      resolvePublicAddress(hostname, dependencies.lookup),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ApiError(504, 'SOURCE_TIMEOUT', 'The video source took too long to respond.')), 10000); }),
    ]).then(address => {
      if (timer) clearTimeout(timer);
      if (closed || signal?.aborted || socket.destroyed) return;
      const upstream = dependencies.connect?.(address) ?? connectTcp({ host: address.address, port: 443, family: address.family });
      track(upstream);
      const destroy = () => { socket.destroy(); upstream.destroy(); };
      socket.once('error', destroy); socket.once('close', () => upstream.destroy());
      upstream.once('error', destroy);
      upstream.once('close', hadError => { if (hadError || !upstream.readableEnded) socket.destroy(); });
      upstream.once('connect', () => {
        if (closed || signal?.aborted || socket.destroyed) { destroy(); return; }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
    }).catch(() => deny(403));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  server.on('error', close);
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) { close(); signal.throwIfAborted(); }
  const address = server.address();
  if (!address || typeof address === 'string') { close(); throw new Error('Could not start media resolver transport'); }
  return { url: `http://mediaflow:${password}@127.0.0.1:${address.port}`, close };
}

/** Do not inherit credentials, proxy bypasses, plugin paths or user settings. */
export function extractorEnvironment(proxy: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || process.env.Path,
    SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONNOUSERSITE: '1',
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
    NO_PROXY: '', no_proxy: '',
  };
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}
