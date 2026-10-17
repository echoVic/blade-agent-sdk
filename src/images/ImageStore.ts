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
  /** Persist one image and return its reference with complete metadata. */
  put(image: ImageBytes, signal?: AbortSignal): Promise<ImageRef>;
  /** Resolve a reference this store handles; undefined when the image is gone. */
  get(url: string, signal?: AbortSignal): Promise<ResolvedImage | undefined>;
  delete?(url: string): Promise<void>;
}

/** A store shared by tenants; each tenant sees only its own images. */
export interface TenantImageStore {
  forTenant(tenantId: string): ImageStore;
}
