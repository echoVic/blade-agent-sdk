/** How much detail a provider should spend on an image. Only OpenAI reads it today. */
export type ImageDetail = 'auto' | 'low' | 'high';

/**
 * One model-visible image.
 *
 * `url` is a `data:` URL, an `http(s):` URL, or a reference that an
 * `ImageStore` resolves, for example `blade-image:sha256:<hex>`. Every other
 * field is optional metadata, so a bare `{ url }` is a valid reference.
 */
export interface ImageRef {
  url: string;
  detail?: ImageDetail;
  /** image/png, image/jpeg, image/gif or image/webp once the SDK has checked the bytes. */
  mediaType?: string;
  /** Pixel size read from the file header; budget estimates use it. */
  width?: number;
  height?: number;
  /** Decoded size in bytes. */
  byteLength?: number;
  /** Text used in place of the image when it cannot be sent to the model. */
  alt?: string;
}
