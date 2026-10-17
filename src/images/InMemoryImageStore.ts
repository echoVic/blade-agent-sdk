import { LRUCache } from 'lru-cache';
import type { ImageRef } from '../model/image.js';
import {
  bladeImageUrl,
  type ImageBytes,
  type ImageStore,
  parseBladeImageUrl,
  type ResolvedImage,
  sha256Hex,
  type TenantImageStore,
} from './ImageStore.js';
import { inspectImageBytes } from './imageBytes.js';

export interface InMemoryImageStoreOptions {
  /** Bytes held across all tenants before the least recently used images go. Default 256 MiB. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_TENANT = '';

interface StoredImage {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

class InMemoryImageBucket implements ImageStore {
  constructor(
    private readonly images: LRUCache<string, StoredImage>,
    private readonly maxBytes: number,
    private readonly tenantId: string,
  ) {}

  handles(url: string): boolean {
    return parseBladeImageUrl(url) !== undefined;
  }

  async put(image: ImageBytes, signal?: AbortSignal): Promise<ImageRef> {
    signal?.throwIfAborted();
    const facts = inspectImageBytes(image.bytes);
    if (!facts) {
      throw new TypeError('InMemoryImageStore accepts only png, jpeg, gif and webp images');
    }
    if (facts.byteLength > this.maxBytes) {
      throw new RangeError(
        `An image of ${facts.byteLength} bytes exceeds the store limit of ${this.maxBytes} bytes`,
      );
    }
    const digest = await sha256Hex(image.bytes);
    const key = this.key(digest);
    if (this.images.get(key) === undefined) {
      this.images.set(key, { bytes: image.bytes.slice(), mediaType: facts.mediaType });
    }
    return {
      url: bladeImageUrl(digest),
      mediaType: facts.mediaType,
      byteLength: facts.byteLength,
      ...(facts.width !== undefined && facts.height !== undefined
        ? { width: facts.width, height: facts.height }
        : {}),
    };
  }

  async get(url: string): Promise<ResolvedImage | undefined> {
    const digest = parseBladeImageUrl(url);
    const image = digest ? this.images.get(this.key(digest)) : undefined;
    return image ? { bytes: image.bytes, mediaType: image.mediaType } : undefined;
  }

  async delete(url: string): Promise<void> {
    const digest = parseBladeImageUrl(url);
    if (digest) this.images.delete(this.key(digest));
  }

  private key(digest: string): string {
    return `${this.tenantId}\u0000${digest}`;
  }
}

/**
 * Process-local image store. Images live as long as the process; once
 * `maxBytes` is reached the least recently used ones are dropped, and a dropped
 * reference becomes an "unavailable" placeholder in later requests.
 */
export class InMemoryImageStore implements ImageStore, TenantImageStore {
  private readonly images: LRUCache<string, StoredImage>;
  private readonly maxBytes: number;
  private readonly defaultBucket: InMemoryImageBucket;

  constructor(options: InMemoryImageStoreOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    this.maxBytes = maxBytes;
    this.images = new LRUCache<string, StoredImage>({
      maxSize: maxBytes,
      sizeCalculation: (image) => Math.max(1, image.bytes.byteLength),
    });
    this.defaultBucket = new InMemoryImageBucket(this.images, maxBytes, DEFAULT_TENANT);
  }

  forTenant(tenantId: string): ImageStore {
    return new InMemoryImageBucket(this.images, this.maxBytes, tenantId);
  }

  handles(url: string): boolean {
    return this.defaultBucket.handles(url);
  }

  put(image: ImageBytes, signal?: AbortSignal): Promise<ImageRef> {
    return this.defaultBucket.put(image, signal);
  }

  get(url: string): Promise<ResolvedImage | undefined> {
    return this.defaultBucket.get(url);
  }

  delete(url: string): Promise<void> {
    return this.defaultBucket.delete(url);
  }
}
