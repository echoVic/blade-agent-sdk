import { ConfigError } from '../errors/ConfigError.js';
import type { VisionCapability } from '../model/vision.js';
import type { ImageStore } from './ImageStore.js';
import { IMAGE_MEDIA_TYPES } from './imageBytes.js';

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

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_IMAGES_PER_INPUT = 20;
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 50;
export const DEFAULT_HISTORY_IMAGE_TOKENS = 16_000;
/** Input window assumed before a model is applied: 128k context minus 8,192 output tokens. */
const DEFAULT_INPUT_WINDOW_TOKENS = 128_000 - 8_192;

/** An `ImagePolicy` with every default filled in for the active model. */
export interface ResolvedImagePolicy {
  readonly store?: ImageStore;
  readonly maxImageBytes: number;
  readonly maxImagesPerInput: number;
  readonly historyTokens: number;
  readonly maxImagesPerRequest: number;
  readonly whenUnsupported: 'reject' | 'omit';
  readonly remoteUrls: boolean;
  readonly mediaTypes: readonly string[];
}

export function assertImagePolicy(policy: ImagePolicy | undefined): void {
  const limits = [
    ['maxImageBytes', policy?.maxImageBytes, 1],
    ['maxImagesPerInput', policy?.maxImagesPerInput, 1],
    ['historyTokens', policy?.historyTokens, 0],
    ['maxImagesPerRequest', policy?.maxImagesPerRequest, 1],
  ] as const;
  for (const [name, value, minimum] of limits) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
      throw new ConfigError(`images.${name} must be a safe integer of at least ${minimum}`);
    }
  }
}

export function resolveImagePolicy(
  policy: ImagePolicy | undefined,
  context: { readonly vision: VisionCapability; readonly inputWindowTokens?: number },
): ResolvedImagePolicy {
  const inputWindow = Math.max(0, context.inputWindowTokens ?? DEFAULT_INPUT_WINDOW_TOKENS);
  return {
    store: policy?.store,
    maxImageBytes: Math.min(
      policy?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      context.vision.maxImageBytes ?? Number.POSITIVE_INFINITY,
    ),
    maxImagesPerInput: policy?.maxImagesPerInput ?? DEFAULT_MAX_IMAGES_PER_INPUT,
    historyTokens:
      policy?.historyTokens ??
      Math.min(DEFAULT_HISTORY_IMAGE_TOKENS, Math.floor(inputWindow * 0.25)),
    maxImagesPerRequest:
      policy?.maxImagesPerRequest ??
      context.vision.maxImagesPerRequest ??
      DEFAULT_MAX_IMAGES_PER_REQUEST,
    whenUnsupported: policy?.whenUnsupported ?? 'reject',
    remoteUrls: policy?.remoteUrls ?? true,
    mediaTypes: context.vision.mediaTypes ?? IMAGE_MEDIA_TYPES,
  };
}
