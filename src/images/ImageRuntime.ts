import { LRUCache } from 'lru-cache';
import { SessionInputError } from '../errors/SessionInputError.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { ModelContent, ModelMessage } from '../model/message.js';
import type { VisionCapability } from '../model/vision.js';
import {
  assertImagePolicy,
  type ImagePolicy,
  type ResolvedImagePolicy,
  resolveImagePolicy,
} from './ImagePolicy.js';
import type { ImageStore } from './ImageStore.js';
import { ImageRejection, normalizeImageContent } from './normalizeImages.js';
import {
  type ImageRequestLimits,
  type PreparedImageRequest,
  prepareImagesForRequest,
} from './prepareImagesForRequest.js';
import { DEFAULT_VISION_CAPABILITY } from './visionDefaults.js';

/** What the Agent tells the image runtime about its active model. */
export interface ImageModelBinding {
  readonly getVision: () => VisionCapability | undefined;
  readonly getInputWindowTokens: () => number | undefined;
  readonly markImagesUnsupported: () => void;
}

const RESOLVED_IMAGE_CACHE_CHARS = 64 * 1024 * 1024;
const resolvedByStore = new WeakMap<ImageStore, LRUCache<string, string>>();

function cacheFor(store: ImageStore | undefined): LRUCache<string, string> | undefined {
  if (!store) return undefined;
  let cache = resolvedByStore.get(store);
  if (!cache) {
    cache = new LRUCache<string, string>({
      maxSize: RESOLVED_IMAGE_CACHE_CHARS,
      sizeCalculation: (value) => Math.max(1, value.length),
    });
    resolvedByStore.set(store, cache);
  }
  return cache;
}

export interface ImageRuntimeOptions {
  readonly policy?: ImagePolicy;
  /** Capability used until a model binding reports one. */
  readonly fallbackVision?: () => VisionCapability;
  readonly logger?: InternalLogger;
}

/**
 * Session-scoped image handling: admits images when they arrive and projects
 * them into each model request. The transcript is never rewritten.
 */
export class ImageRuntime {
  private binding?: ImageModelBinding;
  private readonly logger: InternalLogger;
  private readonly reportedUnavailable = new Set<string>();

  constructor(private readonly options: ImageRuntimeOptions = {}) {
    assertImagePolicy(options.policy);
    this.logger = (options.logger ?? NOOP_LOGGER).child(LogCategory.CONTEXT);
  }

  bindModel(binding: ImageModelBinding): void {
    this.binding = binding;
  }

  vision(): VisionCapability {
    return (
      this.binding?.getVision() ?? this.options.fallbackVision?.() ?? DEFAULT_VISION_CAPABILITY
    );
  }

  policy(): ResolvedImagePolicy {
    return resolveImagePolicy(this.options.policy, {
      vision: this.vision(),
      inputWindowTokens: this.binding?.getInputWindowTokens(),
    });
  }

  /** Admit the images of one user input; a refused image throws `SessionInputError`. */
  async normalizeUserContent(
    content: string | ModelContent[],
    signal?: AbortSignal,
  ): Promise<string | ModelContent[]> {
    try {
      return await normalizeImageContent(content, {
        policy: this.policy(),
        vision: this.vision(),
        signal,
      });
    } catch (error) {
      if (error instanceof ImageRejection) {
        this.logger.debug(`[Images] Rejected input image ${error.index}: ${error.reason}`);
        throw new SessionInputError('SESSION_INPUT_IMAGE_REJECTED', error.message, {
          cause: error,
          details: { index: error.index, reason: error.reason },
        });
      }
      throw error;
    }
  }

  /** The image view of one model request; see `prepareImagesForRequest`. */
  async prepareRequest(
    messages: readonly ModelMessage[],
    options: { readonly limits?: ImageRequestLimits; readonly signal?: AbortSignal } = {},
  ): Promise<PreparedImageRequest> {
    const policy = this.policy();
    const prepared = await prepareImagesForRequest(messages, {
      vision: this.vision(),
      policy,
      cache: cacheFor(policy.store),
      reportedUnavailable: this.reportedUnavailable,
      limits: options.limits,
      signal: options.signal,
      logger: this.logger,
    });
    const { omitted } = prepared.report;
    if (omitted.budget + omitted.unsupported + omitted.unavailable + omitted.rejected > 0) {
      this.logger.debug('[Images] Images left out of the model request:', prepared.report);
    }
    return prepared;
  }

  markImagesUnsupported(): void {
    this.binding?.markImagesUnsupported();
  }
}
