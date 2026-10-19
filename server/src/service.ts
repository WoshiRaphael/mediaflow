import type { Config } from './config.js';
import { checkDeclaredSize, openMedia, type TransportDependencies } from './upstream.js';
import { detectMedia, mediaTitle, readPrefix, validateDeclaredMime } from './media.js';
import { MediaRegistry } from './registry.js';
import { cancelExtractions, extractVideoPage, type ExtractedVideo } from './extractor.js';
import { ApiError } from './errors.js';
import { findPlatform } from './platforms.js';
import { validateUrl } from './security.js';
import { PreparedMediaStore } from './prepared.js';

export interface MediaServiceDependencies extends TransportDependencies {
  extract?: (input: string, config: Config, signal?: AbortSignal) => Promise<ExtractedVideo>;
}

export function createMediaService(config: Config, dependencies: MediaServiceDependencies = {}) {
  const registry = new MediaRegistry(config.mediaTtlSeconds);
  const prepared = new PreparedMediaStore(config, dependencies);
  let disposed = false;
  const resolvePage = async (input: string, signal?: AbortSignal) => {
    if (disposed) throw new ApiError(503, 'SERVER_SHUTTING_DOWN', 'The server is restarting. Please retry in a moment.');
    if (!config.extractorEnabled) throw new ApiError(422, 'EXTRACTOR_DISABLED', 'Video-page downloads are disabled on this server. Direct photo and video files still work.');
    const video = await (dependencies.extract ?? extractVideoPage)(input, config, signal);
    signal?.throwIfAborted();
    if (disposed) throw new ApiError(503, 'SERVER_SHUTTING_DOWN', 'The server is restarting. Please retry in a moment.');
    const formats = video.formats.filter(format => ['mp4', 'webm'].includes(format.extension) && [1, 2].includes(format.sources.length));
    if (!formats.length) throw new ApiError(422, 'NO_COMPLETE_VIDEO', 'This page did not provide an accessible video. Try a different public video link.');
    const first = formats[0];
    const record = registry.create({ url: input, title: video.title.slice(0, 200), platform: video.platform, formats, media: { kind: 'video', extension: first.extension, mimeType: first.mimeType } });
    return {
      id: record.id, title: record.title, platform: video.platform, kind: 'video' as const,
      ...(video.duration ? { duration: video.duration } : {}),
      formats: formats.map(({ sources: _sources, needsMerge, ...format }) => ({ ...format, ...(needsMerge ? { size: undefined } : {}) })),
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  };
  return {
    registry,
    async resolve(input: string, signal?: AbortSignal) {
      if (disposed) throw new ApiError(503, 'SERVER_SHUTTING_DOWN', 'The server is restarting. Please retry in a moment.');
      const inputUrl = validateUrl(input, config);
      const staticExtension = /\.(?:jpe?g|png|webp|gif|mp4|webm)$/i.test(inputUrl.pathname);
      if (findPlatform(inputUrl.hostname) && !staticExtension) return resolvePage(inputUrl.href, signal);
      const { response, url } = await openMedia(input, config, 'bytes=0-65535', dependencies, signal);
      try {
        const size = checkDeclaredSize(response, config.maxFileBytes);
        const prefix = await readPrefix(response.body);
        let media;
        try { media = detectMedia(prefix); }
        catch (error) {
          const declared = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
          if (declared === 'text/html' || declared === 'application/xhtml+xml' || /^\s*(?:<!doctype html|<html|<head|<body)/i.test(prefix.toString('utf8', 0, 256))) return resolvePage(url.href, signal);
          throw error;
        }
        signal?.throwIfAborted();
        validateDeclaredMime(response.headers['content-type'], media);
        const record = registry.create({ url: url.href, title: mediaTitle(url, media.extension), media, ...(size ? { size } : {}) });
        return {
          id: record.id, title: record.title, platform: 'direct' as const, kind: media.kind,
          formats: [{ id: 'original', label: 'Original quality', extension: media.extension, mimeType: media.mimeType, ...(size ? { size } : {}), ...(media.width ? { width: media.width } : {}), ...(media.height ? { height: media.height } : {}) }],
          expiresAt: new Date(record.expiresAt).toISOString(),
        };
      } finally { response.destroy(); }
    },
    open: (url: string, range?: string, signal?: AbortSignal) => openMedia(url, config, range, dependencies, signal),
    prepare: (record: ReturnType<MediaRegistry['get']>, formatId: string, signal?: AbortSignal) => {
      if (disposed) throw new ApiError(503, 'SERVER_SHUTTING_DOWN', 'The server is restarting. Please retry in a moment.');
      const plan = record.formats?.find(format => format.id === formatId);
      if (!plan) throw new ApiError(400, 'INVALID_FORMAT', 'Choose one of the available qualities for this video.');
      return prepared.acquire(record, plan, signal);
    },
    dispose: async () => { disposed = true; await Promise.all([cancelExtractions(), prepared.dispose()]); },
  };
}
