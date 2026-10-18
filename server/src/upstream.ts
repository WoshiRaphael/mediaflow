import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { resolvePublicAddress, validateUrl, type Lookup, type ResolvedAddress } from './security.js';

export interface UpstreamResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
  destroy: () => void;
}
export type PinnedRequest = (url: URL, address: ResolvedAddress, config: Config, range?: string, signal?: AbortSignal) => Promise<UpstreamResponse>;
export interface TransportDependencies { lookup?: Lookup; request?: PinnedRequest }

/** Release application slots immediately on cancellation, even for OS DNS
 * lookups or third-party adapters whose promise itself cannot be cancelled. */
function withAbort<T>(operation: Promise<T>, signal?: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Request aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(value => {
      if (settled) { disposeLate?.(value); return; }
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export function pinnedLookup(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    // Newer Node releases request an array for family auto-selection. In both
    // callback modes expose only the single address that passed our checks.
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

export const requestPinned: PinnedRequest = (url, address, config, range, signal) => new Promise((resolve, reject) => {
  const request = https.request(url, {
    method: 'GET', agent: false, family: address.family, signal,
    headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,application/octet-stream;q=0.5', 'Accept-Encoding': 'identity', 'User-Agent': 'MediaFlow/1.0 (authorized-media-download)', ...(range ? { Range: range } : {}) },
    // Pin the already validated address while retaining the original hostname for
    // TLS certificate verification and SNI. No second DNS lookup can occur.
    lookup: pinnedLookup(address),
    servername: url.hostname,
  }, response => {
    // Cancellation can occur between headers and the consumer's first read.
    // Keep that race from creating an unhandled stream error; async iteration
    // still observes and propagates any error when a consumer is attached.
    response.on('error', () => {});
    resolve({ statusCode: response.statusCode ?? 502, headers: response.headers, body: response, destroy: () => response.destroy() });
  });
  const timer = setTimeout(() => request.destroy(new ApiError(504, 'SOURCE_TIMEOUT', 'The source took too long to respond. Please retry.')), config.requestTimeoutMs);
  request.once('close', () => clearTimeout(timer));
  request.once('error', reject);
  request.end();
});

export async function openMedia(input: string, config: Config, range?: string, dependencies: TransportDependencies = {}, signal?: AbortSignal): Promise<{ response: UpstreamResponse; url: URL }> {
  signal?.throwIfAborted();
  let url = validateUrl(input, config);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let timer: NodeJS.Timeout | undefined;
    const address = await withAbort(Promise.race([
      resolvePublicAddress(url.hostname, dependencies.lookup),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ApiError(504, 'SOURCE_TIMEOUT', 'The source took too long to resolve. Please retry.')), config.requestTimeoutMs); }),
    ]), signal).finally(() => { if (timer) clearTimeout(timer); });
    signal?.throwIfAborted();
    const response = await withAbort((dependencies.request ?? requestPinned)(url, address, config, range, signal), signal, late => late.destroy());
    if (signal) {
      const cancel = () => response.destroy();
      signal.addEventListener('abort', cancel, { once: true });
      response.body.once('close', () => signal.removeEventListener('abort', cancel));
      if (signal.aborted) { response.destroy(); signal.throwIfAborted(); }
    }
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (redirects === 3 || !response.headers.location) throw new ApiError(422, 'REDIRECT_LIMIT', 'The source redirected too many times. Use its final direct media link.');
      try { url = validateUrl(new URL(response.headers.location, url).href, config); }
      catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(422, 'UNSAFE_REDIRECT', 'The source redirected to an invalid location.'); }
      continue;
    }
    if (response.statusCode !== 200 && response.statusCode !== 206) {
      response.destroy();
      if (response.statusCode === 416) throw new ApiError(416, 'INVALID_RANGE', 'The requested media range is unavailable.');
      throw new ApiError(422, 'SOURCE_REJECTED', response.statusCode === 403 || response.statusCode === 401 ? 'The source requires permission or authentication. MediaFlow cannot access protected media.' : 'The source did not provide an accessible media file.');
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      response.destroy(); throw new ApiError(422, 'ENCODING_UNSUPPORTED', 'The source returned an unsupported transfer encoding.');
    }
    return { response, url };
  }
  throw new ApiError(422, 'REDIRECT_LIMIT', 'The source redirected too many times.');
}

export function contentSize(response: UpstreamResponse): number | undefined {
  const range = response.headers['content-range'];
  const total = typeof range === 'string' ? /^bytes \d+-\d+\/(\d+)$/.exec(range)?.[1] : undefined;
  const raw = total ?? (response.statusCode === 200 ? response.headers['content-length'] : undefined);
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  const size = Number(raw);
  return Number.isSafeInteger(size) && size > 0 ? size : undefined;
}

export function checkDeclaredSize(response: UpstreamResponse, maxBytes: number): number | undefined {
  const size = contentSize(response);
  if (size !== undefined && size > maxBytes) { response.destroy(); throw new ApiError(413, 'FILE_TOO_LARGE', `This file exceeds the ${Math.round(maxBytes / 1048576)} MB limit.`); }
  const partLength = response.headers['content-length'];
  if (partLength && (!/^\d+$/.test(String(partLength)) || Number(partLength) > maxBytes)) { response.destroy(); throw new ApiError(413, 'FILE_TOO_LARGE', 'The source file is too large.'); }
  return size;
}
