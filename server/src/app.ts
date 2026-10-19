import { once } from 'node:events';
import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from './config.js';
import { ApiError, publicError } from './errors.js';
import { detectMedia, filename, validateDeclaredMime } from './media.js';
import { platformModules } from './platforms.js';
import { parseByteRange } from './security.js';
import { createMediaService, type MediaServiceDependencies } from './service.js';
import { checkDeclaredSize, type TransportDependencies } from './upstream.js';
import { createReadStream, preparedRange } from './prepared.js';

const urlSchema = z.string().trim().min(1).max(4096);
const resolveSchema = z.object({ url: urlSchema }).strict();
const batchSchema = z.object({ urls: z.array(urlSchema).min(1).max(5) }).strict();
const asyncRoute = (handler: express.RequestHandler): express.RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next); };

function clientCancellation(res: express.Response, timeoutMs: number) {
  const controller = new AbortController();
  const cancel = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', cancel);
  res.setTimeout(timeoutMs, () => res.destroy());
  if (res.destroyed) controller.abort();
  return { signal: controller.signal, dispose: () => res.off('close', cancel) };
}

export function createApp(config: Config, dependencies: MediaServiceDependencies = {}) {
  const app = express();
  const service = createMediaService(config, dependencies);
  app.locals.dispose = () => service.dispose();
  let activeDownloads = 0;
  let activeResolves = 0;
  app.disable('x-powered-by');
  if (config.trustProxyHops) app.set('trust proxy', config.trustProxyHops);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.has(origin)) callback(null, true);
      else callback(new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'This website is not permitted to use the API.'));
    },
    methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Range'],
    exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Disposition', 'Content-Range', 'Accept-Ranges'], maxAge: 600,
  }));
  app.use(express.json({ limit: '24kb', strict: true }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'mediaflow', version: '1.0.0' }));
  app.get('/api/platforms', (_req, res) => res.json({
    direct: { id: 'direct', name: 'Direct media', status: 'available', publicHosts: config.allowPublicMedia, hosts: [...config.allowedHosts], formats: ['mp4', 'webm', 'jpg', 'png', 'webp', 'gif'], maxFileBytes: config.maxFileBytes },
    platforms: platformModules.map(platform => ({ ...platform, status: config.extractorEnabled ? 'available' : 'disabled' })),
  }));
  const limiter = rateLimit({
    windowMs: 60000, limit: config.rateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'You’re moving quickly. Please wait a minute and try again.' } }),
  });
  const limitedResolve = async (url: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (activeResolves >= 12) throw new ApiError(503, 'SERVER_BUSY', 'MediaFlow is busy. Please try again in a moment.');
    activeResolves++;
    try { return await service.resolve(url, signal); } finally { activeResolves--; }
  };
  app.post('/api/resolve', limiter, asyncRoute(async (req, res) => {
    const input = resolveSchema.safeParse(req.body);
    if (!input.success) throw new ApiError(400, 'INVALID_INPUT', 'Provide one media URL.');
    const cancellation = clientCancellation(res, Math.max(75000, config.extractionTimeoutMs + 10000));
    try {
      const media = await limitedResolve(input.data.url, cancellation.signal);
      cancellation.signal.throwIfAborted();
      if (!res.destroyed) res.json(media);
    } finally { cancellation.dispose(); }
  }));
  app.post('/api/batch', limiter, asyncRoute(async (req, res) => {
    const input = batchSchema.safeParse(req.body);
    if (!input.success) throw new ApiError(400, 'INVALID_INPUT', 'Provide between one and five media URLs.');
    // Resolve sequentially so a batch cannot multiply connection concurrency.
    const cancellation = clientCancellation(res, Math.max(75000, config.extractionTimeoutMs + 10000) * input.data.urls.length);
    try {
      const results = [];
      for (const url of [...new Set(input.data.urls)]) {
        cancellation.signal.throwIfAborted();
        try { results.push({ url, media: await limitedResolve(url, cancellation.signal) }); }
        catch (error) {
          cancellation.signal.throwIfAborted();
          const safe = publicError(error); results.push({ url, error: { code: safe.code, message: safe.message } });
        }
      }
      if (!res.destroyed) res.json({ results });
    } finally { cancellation.dispose(); }
  }));
  app.get('/api/media/:id', limiter, asyncRoute(async (req, res) => {
    if (req.query.format !== undefined && typeof req.query.format !== 'string') throw new ApiError(400, 'INVALID_FORMAT', 'Choose a valid media format.');
    if (req.query.disposition !== undefined && !['inline', 'attachment'].includes(String(req.query.disposition))) throw new ApiError(400, 'INVALID_INPUT', 'Choose inline or attachment.');
    const record = service.registry.get(req.params.id);
    const formatId = typeof req.query.format === 'string' ? req.query.format : record.formats?.[0]?.id ?? 'original';
    if (!record.formats && formatId !== 'original') throw new ApiError(400, 'INVALID_FORMAT', 'Only the source’s original format is available.');
    const range = parseByteRange(req.headers.range, record.size);
    if (activeDownloads >= config.maxConcurrentDownloads) throw new ApiError(503, 'SERVER_BUSY', 'All download slots are in use. Please try again in a moment.');
    activeDownloads++;
    let response: Awaited<ReturnType<typeof service.open>>['response'] | undefined;
    const aborted = new AbortController();
    let localStream: ReturnType<typeof createReadStream> | undefined;
    const cancel = () => { aborted.abort(); response?.destroy(); localStream?.destroy(); };
    res.once('close', cancel);
    // Bound stalled downstream clients as well as slow upstream servers, so a
    // client that stops reading cannot retain a global transfer slot forever.
    res.setTimeout(Math.max(120000, config.downloadTimeoutMs), () => res.destroy());
    try {
      if (record.formats) {
        const lease = await service.prepare(record, formatId, aborted.signal);
        try {
          if (res.destroyed) return;
          aborted.signal.throwIfAborted();
          const bounds = preparedRange(parseByteRange(req.headers.range, lease.size), lease.size);
          res.status(bounds.partial ? 206 : 200);
          res.setHeader('Content-Type', lease.mimeType);
          res.setHeader('Content-Disposition', `${req.query.disposition === 'inline' ? 'inline' : 'attachment'}; filename="${filename(record.title, lease.extension)}"`);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', bounds.end - bounds.start + 1);
          if (bounds.partial) res.setHeader('Content-Range', `bytes ${bounds.start}-${bounds.end}/${lease.size}`);
          localStream = createReadStream(lease.path, { start: bounds.start, end: bounds.end });
          for await (const chunk of localStream) {
            if (res.destroyed) break;
            if (!res.write(chunk)) await once(res, 'drain', { signal: aborted.signal });
          }
          if (!res.destroyed) res.end();
        } finally { localStream?.destroy(); lease.release(); }
        return;
      }
      const opened = await service.open(record.url, range, aborted.signal);
      response = opened.response;
      if (res.destroyed) { response.destroy(); return; }
      aborted.signal.throwIfAborted();
      checkDeclaredSize(response, config.maxFileBytes);
      validateDeclaredMime(response.headers['content-type'], record.media);
      const iterator = response.body[Symbol.asyncIterator]();
      const initial: Buffer[] = [];
      // Re-sniff full transfers before sending any bytes. A URL whose content
      // changed after resolution cannot serve a different file type.
      if (!range || response.statusCode === 200) {
        let prefixLength = 0;
        while (prefixLength < 256) {
          const part = await iterator.next();
          if (part.done) break;
          const bytes = Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value);
          initial.push(bytes);
          prefixLength += bytes.length;
        }
        if (detectMedia(Buffer.concat(initial).subarray(0, 256)).mimeType !== record.media.mimeType) throw new ApiError(422, 'MEDIA_CHANGED', 'This source has changed. Resolve its URL again.');
      }
      const contentRange = response.headers['content-range'];
      if (response.statusCode === 206 && (typeof contentRange !== 'string' || !/^bytes \d+-\d+\/\d+$/.test(contentRange))) throw new ApiError(502, 'INVALID_SOURCE_RANGE', 'The source returned an invalid media range.');
      res.status(response.statusCode);
      res.setHeader('Content-Type', record.media.mimeType);
      res.setHeader('Content-Disposition', `${req.query.disposition === 'inline' ? 'inline' : 'attachment'}; filename="${filename(record.title, record.media.extension)}"`);
      res.setHeader('Accept-Ranges', 'bytes');
      const length = response.headers['content-length'];
      if (typeof length === 'string' && /^\d+$/.test(length)) res.setHeader('Content-Length', length);
      if (contentRange) res.setHeader('Content-Range', contentRange);
      let downloaded = 0;
      const writeChunk = async (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        downloaded += bytes.length;
        if (downloaded > config.maxFileBytes) throw new ApiError(413, 'FILE_TOO_LARGE', 'The source exceeded the file-size limit.');
        if (res.destroyed) return;
        if (!res.write(bytes)) await once(res, 'drain', { signal: aborted.signal });
      };
      for (const chunk of initial) await writeChunk(chunk);
      for (;;) {
        if (res.destroyed) break;
        const part = await iterator.next();
        if (part.done) break;
        await writeChunk(part.value);
      }
      res.end();
    } finally {
      activeDownloads--;
      res.off('close', cancel);
      response?.destroy();
    }
  }));
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'This API endpoint does not exist.')));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Send a valid JSON request.' } }); return; }
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') { res.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: 'The request is too large.' } }); return; }
    const safe = publicError(error);
    for (const header of ['Content-Disposition', 'Content-Length', 'Content-Range', 'Accept-Ranges']) res.removeHeader(header);
    res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
  };
  app.use(errors);
  return app;
}
