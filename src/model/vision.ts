/**
 * What the active model accepts as image input.
 *
 * Resolved per model from the built-in table, then `ModelConfig.vision`, then
 * `SessionOptions.vision`.
 */
export interface VisionCapability {
  /** The model accepts image input. */
  images: boolean;
  /**
   * Images may stay inside tool results. When false, requests move them into a
   * user message that follows the tool results.
   */
  toolResultImages: boolean;
  /** Accepted media types; png, jpeg, gif and webp when omitted. */
  mediaTypes?: readonly string[];
  /** Largest accepted image in bytes. */
  maxImageBytes?: number;
  /** Most images one request may carry. */
  maxImagesPerRequest?: number;
  /** Token estimate formula, or a fixed token count per image. */
  imageTokens?: 'openai' | 'anthropic' | 'gemini' | number;
}

export type VisionCapabilityOverride = Partial<VisionCapability>;

/** Resolves an override; provider is the adapter type (e.g. 'openai-compatible'), not providerId. */
export type VisionResolver = (model: {
  readonly provider: string;
  readonly model: string;
}) => VisionCapabilityOverride | undefined;
