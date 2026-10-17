import type { ImageRef } from '../model/image.js';
import type { VisionCapability } from '../model/vision.js';
import { base64PrefixToBytes, parseBase64DataUrl } from './base64.js';
import { inspectImageBytes } from './imageBytes.js';

/** Estimate for an image whose size is unknown; about one 1080p screenshot on any provider. */
export const DEFAULT_IMAGE_TOKENS = 1_600;
const HEADER_PROBE_BYTES = 64 * 1024;

interface Size {
  readonly width: number;
  readonly height: number;
}

function imageSize(ref: ImageRef): Size | undefined {
  if (ref.width && ref.height) return { width: ref.width, height: ref.height };
  const inline = parseBase64DataUrl(ref.url);
  if (!inline) return undefined;
  const facts = inspectImageBytes(base64PrefixToBytes(inline.base64, HEADER_PROBE_BYTES));
  return facts?.width && facts.height ? { width: facts.width, height: facts.height } : undefined;
}

function openAiTokens({ width, height }: Size): number {
  const fit = Math.min(1, 2048 / Math.max(width, height));
  let scaledWidth = width * fit;
  let scaledHeight = height * fit;
  const shortest = Math.min(scaledWidth, scaledHeight);
  if (shortest > 768) {
    scaledWidth *= 768 / shortest;
    scaledHeight *= 768 / shortest;
  }
  return 85 + 170 * Math.ceil(scaledWidth / 512) * Math.ceil(scaledHeight / 512);
}

function anthropicTokens({ width, height }: Size): number {
  const scale = Math.min(1, 1568 / Math.max(width, height));
  return Math.min(1600, Math.ceil((width * scale * height * scale) / 750));
}

function geminiTokens({ width, height }: Size): number {
  return width <= 384 && height <= 384
    ? 258
    : 258 * Math.ceil(width / 768) * Math.ceil(height / 768);
}

/**
 * Conservative token estimate for sending `ref`. It uses the pixel size and the
 * provider formula and never tokenizes base64. Billing stays the provider's.
 */
export function estimateImageTokens(
  ref: ImageRef,
  vision?: Pick<VisionCapability, 'imageTokens'>,
): number {
  const formula = vision?.imageTokens ?? DEFAULT_IMAGE_TOKENS;
  if (typeof formula === 'number') return formula;
  if (formula === 'openai' && ref.detail === 'low') return 85;
  const size = imageSize(ref);
  if (!size) return DEFAULT_IMAGE_TOKENS;
  switch (formula) {
    case 'openai':
      return openAiTokens(size);
    case 'anthropic':
      return anthropicTokens(size);
    case 'gemini':
      return geminiTokens(size);
  }
}
