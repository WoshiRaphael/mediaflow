import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';
import type { MediaType } from './media.js';
import type { ExtractedFormat } from './extractor.js';

export interface MediaRecord {
  id: string;
  url: string;
  title: string;
  media: MediaType;
  size?: number;
  expiresAt: number;
  platform?: string;
  formats?: ExtractedFormat[];
}

/** Bounded, process-local registry. Run one instance or replace this with a
 * shared TTL store before scaling; tokens must never contain arbitrary URLs. */
export class MediaRegistry {
  private records = new Map<string, MediaRecord>();
  constructor(private ttlSeconds: number, private capacity = 500, private now = Date.now) {}
  create(record: Omit<MediaRecord, 'id' | 'expiresAt'>): MediaRecord {
    this.prune();
    if (this.records.size >= this.capacity) this.records.delete(this.records.keys().next().value!);
    const item = { ...record, id: randomBytes(24).toString('base64url'), expiresAt: this.now() + this.ttlSeconds * 1000 };
    this.records.set(item.id, item);
    return item;
  }
  get(id: string): MediaRecord {
    if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'This media link is invalid. Resolve the original URL again.');
    const record = this.records.get(id);
    if (!record || record.expiresAt <= this.now()) {
      this.records.delete(id);
      throw new ApiError(410, 'MEDIA_EXPIRED', 'This media link has expired. Paste the original URL again.');
    }
    return record;
  }
  private prune(): void {
    for (const [id, record] of this.records) if (record.expiresAt <= this.now()) this.records.delete(id);
  }
}
