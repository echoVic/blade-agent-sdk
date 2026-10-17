import type { ImageRef } from '../model/image.js';

export interface ImageBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** Bytes of a stored image, or a URL the provider can fetch itself (for example a presigned URL). */
export type ResolvedImage = ImageBytes | { readonly url: string };

/**
 * Where image bytes live outside the transcript.
 *
 * When a Session has a store, inline images are written through `put()` and
 * only the returned reference is kept. `get()` runs when a request needs the
 * image again.
 */
export interface ImageStore {
  /** Whether this store resolves `url`. */
  handles(url: string): boolean;
  /** Persist one image; return url, mediaType and byteLength, plus width/height when the header gives them. */
  put(image: ImageBytes, signal?: AbortSignal): Promise<ImageRef>;
  /** Resolve a reference this store handles; undefined when the image is gone. */
  get(url: string, signal?: AbortSignal): Promise<ResolvedImage | undefined>;
  delete?(url: string): Promise<void>;
}

/** A store shared by tenants; each tenant sees only its own images. */
export interface TenantImageStore {
  forTenant(tenantId: string): ImageStore;
}

/** Prefix of references written by the built-in content-addressed stores. */
export const BLADE_IMAGE_URL_PREFIX = 'blade-image:sha256:';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function bladeImageUrl(sha256: string): string {
  return `${BLADE_IMAGE_URL_PREFIX}${sha256}`;
}

/** The SHA-256 digest inside a built-in store reference, or undefined for any other URL. */
export function parseBladeImageUrl(url: string): string | undefined {
  if (!url.startsWith(BLADE_IMAGE_URL_PREFIX)) return undefined;
  const digest = url.slice(BLADE_IMAGE_URL_PREFIX.length);
  return DIGEST_PATTERN.test(digest) ? digest : undefined;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * Join stores: `put` writes to `primary`; `handles`, `get` and `delete` go to
 * the first store that handles the reference. Applications plug their own
 * reference schemes (IM file keys, object storage) in this way.
 */
export function combineImageStores(primary: ImageStore, ...others: ImageStore[]): ImageStore {
  const stores = [primary, ...others];
  const owner = (url: string) => stores.find((store) => store.handles(url));
  return {
    handles: (url) => owner(url) !== undefined,
    put: (image, signal) => primary.put(image, signal),
    get: async (url, signal) => owner(url)?.get(url, signal),
    delete: async (url) => {
      await owner(url)?.delete?.(url);
    },
  };
}
