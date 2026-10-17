import { ConfigError } from '../errors/ConfigError.js';
import type {
  VisionCapability,
  VisionCapabilityOverride,
  VisionResolver,
} from '../model/vision.js';
import { normalizeDeepSeekModel } from '../services/deepseek.js';

const MIB = 1024 * 1024;

const ANTHROPIC_VISION: VisionCapability = {
  images: true,
  toolResultImages: true,
  imageTokens: 'anthropic',
  maxImageBytes: 5 * MIB,
  maxImagesPerRequest: 100,
};
const OPENAI_VISION: VisionCapability = {
  images: true,
  toolResultImages: true,
  imageTokens: 'openai',
  maxImageBytes: 20 * MIB,
};
// Azure routes through the OpenAI-compatible adapter, which turns tool result
// content into text, so images move out of tool results.
const AZURE_VISION: VisionCapability = {
  images: true,
  toolResultImages: false,
  imageTokens: 'openai',
};
const GEMINI_VISION: VisionCapability = {
  images: true,
  toolResultImages: true,
  imageTokens: 'gemini',
};
const NO_VISION: VisionCapability = { images: false, toolResultImages: false };

/** Capability assumed for models the table does not know: pass images through, as before. */
export const DEFAULT_VISION_CAPABILITY: VisionCapability = {
  images: true,
  toolResultImages: false,
  imageTokens: 1600,
};

const OPENAI_TEXT_ONLY_MODELS = [
  /^gpt-3\.5/,
  /^gpt-4(?:-0314|-0613)?$/,
  /^gpt-4-32k/,
  /^gpt-4-(?:0125|1106)-preview$/,
  /^o1-mini/,
  /^o1-preview/,
  /^o3-mini/,
];
const TEXT_ONLY_MODEL_HINTS = [
  /qwq/,
  /deepseek-r1/,
  /deepseek-v4-pro/,
  /o1-mini/,
  /o3-mini/,
  /gpt-3\.5/,
];

const matches = (patterns: readonly RegExp[], name: string) =>
  patterns.some((pattern) => pattern.test(name));

/** The built-in capability row for a provider and model name. */
export function builtinVisionCapability(provider: string, model: string): VisionCapability {
  const name = model.trim().toLowerCase();
  switch (provider) {
    case 'anthropic':
      return /^claude-(?:2|instant)/.test(name) ? NO_VISION : ANTHROPIC_VISION;
    case 'openai':
      return matches(OPENAI_TEXT_ONLY_MODELS, name) ? NO_VISION : OPENAI_VISION;
    case 'azure-openai':
      return matches(OPENAI_TEXT_ONLY_MODELS, name) ? NO_VISION : AZURE_VISION;
    case 'gemini':
      return GEMINI_VISION;
    case 'deepseek':
      return normalizeDeepSeekModel(name) === 'deepseek-v4-flash'
        ? DEFAULT_VISION_CAPABILITY
        : NO_VISION;
    default:
      return matches(TEXT_ONLY_MODEL_HINTS, name) ? NO_VISION : DEFAULT_VISION_CAPABILITY;
  }
}

function assertOverride(override: VisionCapabilityOverride, source: string): void {
  for (const key of ['maxImageBytes', 'maxImagesPerRequest'] as const) {
    const value = override[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new ConfigError(`${source}.${key} must be a positive safe integer`);
    }
  }
  const tokens = override.imageTokens;
  if (typeof tokens === 'number' && (!Number.isSafeInteger(tokens) || tokens < 1)) {
    throw new ConfigError(
      `${source}.imageTokens must be a positive safe integer or a formula name`,
    );
  }
}

function applyOverride(
  base: VisionCapability,
  override: VisionCapabilityOverride | undefined,
): VisionCapability {
  if (!override) return base;
  const mediaTypes = override.mediaTypes ?? base.mediaTypes;
  const maxImageBytes = override.maxImageBytes ?? base.maxImageBytes;
  const maxImagesPerRequest = override.maxImagesPerRequest ?? base.maxImagesPerRequest;
  const imageTokens = override.imageTokens ?? base.imageTokens;
  return {
    images: override.images ?? base.images,
    toolResultImages: override.toolResultImages ?? base.toolResultImages,
    ...(mediaTypes ? { mediaTypes } : {}),
    ...(maxImageBytes !== undefined ? { maxImageBytes } : {}),
    ...(maxImagesPerRequest !== undefined ? { maxImagesPerRequest } : {}),
    ...(imageTokens !== undefined ? { imageTokens } : {}),
  };
}

export interface VisionResolutionInput {
  readonly provider: string;
  readonly model: string;
  readonly modelOverride?: VisionCapabilityOverride;
  readonly sessionOverride?: VisionCapabilityOverride | VisionResolver;
  /** The provider already said this model does not accept images. */
  readonly imagesUnsupported?: boolean;
}

/** Built-in row, then `ModelConfig.vision`, then `SessionOptions.vision`, then any runtime downgrade. */
export function resolveVisionCapability(input: VisionResolutionInput): VisionCapability {
  const sessionOverride =
    typeof input.sessionOverride === 'function'
      ? input.sessionOverride({ provider: input.provider, model: input.model })
      : input.sessionOverride;
  if (input.modelOverride) assertOverride(input.modelOverride, 'ModelConfig.vision');
  if (sessionOverride) assertOverride(sessionOverride, 'SessionOptions.vision');
  const resolved = applyOverride(
    applyOverride(builtinVisionCapability(input.provider, input.model), input.modelOverride),
    sessionOverride,
  );
  return input.imagesUnsupported ? { ...resolved, images: false } : resolved;
}
