import type { Config } from './config.js';
import { checkDeclaredSize, openMedia, type TransportDependencies } from './upstream.js';
import { detectMedia, mediaTitle, readPrefix, validateDeclaredMime } from './media.js';
import { MediaRegistry } from './registry.js';

export function createMediaService(config: Config, dependencies: TransportDependencies = {}) {
  const registry = new MediaRegistry(config.mediaTtlSeconds);
  return {
    registry,
    async resolve(input: string, signal?: AbortSignal) {
      const { response, url } = await openMedia(input, config, 'bytes=0-65535', dependencies, signal);
      try {
        const size = checkDeclaredSize(response, config.maxFileBytes);
        const media = detectMedia(await readPrefix(response.body));
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
  };
}
