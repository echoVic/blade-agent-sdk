import { SessionInputError } from '../errors/SessionInputError.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { ModelContent } from '../model/message.js';
import type { VisionCapability } from '../model/vision.js';
import {
  assertImagePolicy,
  type ImagePolicy,
  type ResolvedImagePolicy,
  resolveImagePolicy,
} from './ImagePolicy.js';
import { ImageRejection, normalizeImageContent } from './normalizeImages.js';
import { DEFAULT_VISION_CAPABILITY } from './visionDefaults.js';

/** What the Agent tells the image runtime about its active model. */
export interface ImageModelBinding {
  readonly getVision: () => VisionCapability | undefined;
  readonly getInputWindowTokens: () => number | undefined;
  readonly markImagesUnsupported: () => void;
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

  markImagesUnsupported(): void {
    this.binding?.markImagesUnsupported();
  }
}
