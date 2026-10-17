import type { ImageStore } from './ImageStore.js';

/** How a Session admits images and budgets them in model requests. */
export interface ImagePolicy {
  /** Where image bytes live. Without one, images stay inline as data: URLs. */
  store?: ImageStore;
  /** Largest accepted image in bytes. Default 10 MiB, further capped by the model. */
  maxImageBytes?: number;
  /** Most images in one input. Default 20. */
  maxImagesPerInput?: number;
  /** Token allowance for images the model has already seen. Default min(16,000, a quarter of the input window). */
  historyTokens?: number;
  /** Most images in one request. Default: the model's limit, otherwise 50. */
  maxImagesPerRequest?: number;
  /** What `send()` does with images when the model cannot accept them. Default 'reject'. */
  whenUnsupported?: 'reject' | 'omit';
  /** Accept http(s) images from callers. Default true; the SDK never fetches them itself. */
  remoteUrls?: boolean;
}
