import type { InternalLogger } from '../logging/Logger.js';
import type { ImageRef } from '../model/image.js';
import type { ModelContent, ModelMessage } from '../model/message.js';
import type { VisionCapability } from '../model/vision.js';
import { toDataUrl } from './base64.js';
import { estimateImageTokens } from './estimateImageTokens.js';
import type { ResolvedImagePolicy } from './ImagePolicy.js';
import { selectImages } from './imageBudget.js';
import { imageRefusal } from './imageRefusal.js';
import { type ImageOmissionReason, imagePlaceholder } from './imageText.js';
import { isDataUrl, isRemoteUrl } from './imageUrls.js';

/** Tighter limits for one recovery retry. */
export interface ImageRequestLimits {
  /** Replaces the history allowance; 0 omits every image the model has already seen. */
  readonly historyTokens?: number;
  /** Caps how many fresh images survive. */
  readonly maxFreshImages?: number;
}

export interface ImageProjectionReport {
  readonly total: number;
  readonly kept: number;
  readonly freshKept: number;
  readonly omitted: Readonly<Record<ImageOmissionReason, number>>;
  readonly estimatedTokens: number;
}

export interface PreparedImageRequest {
  readonly messages: readonly ModelMessage[];
  readonly report: ImageProjectionReport;
}

/** Store references already turned into data URLs; an `LRUCache<string, string>` fits. */
export interface ResolvedImageCache {
  get(key: string): string | undefined;
  set(key: string, value: string): unknown;
}

export interface ImageRequestContext {
  readonly vision: VisionCapability;
  readonly policy: ResolvedImagePolicy;
  readonly cache?: ResolvedImageCache;
  /** URLs already reported unavailable; each is warned about once, later misses log at debug */
  readonly reportedUnavailable?: { has(url: string): boolean; add(url: string): unknown };
  readonly limits?: ImageRequestLimits;
  readonly signal?: AbortSignal;
  readonly logger?: InternalLogger;
}

interface LocatedImage {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly ref: ImageRef;
  /** Only user and tool messages may carry images to a provider. */
  readonly eligible: boolean;
  readonly fresh: boolean;
}

type Decision = ImageOmissionReason | 'keep';

const NO_IMAGES: ImageProjectionReport = {
  total: 0,
  kept: 0,
  freshKept: 0,
  omitted: { budget: 0, unsupported: 0, unavailable: 0, rejected: 0 },
  estimatedTokens: 0,
};

function locateImages(messages: readonly ModelMessage[]): LocatedImage[] {
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  return messages.flatMap((message, messageIndex) =>
    typeof message.content === 'string'
      ? []
      : message.content.flatMap((part, partIndex) =>
          part.type === 'image_url'
            ? [
                {
                  messageIndex,
                  partIndex,
                  ref: part.image_url,
                  eligible: message.role === 'user' || message.role === 'tool',
                  fresh: messageIndex > lastAssistant,
                },
              ]
            : [],
        ),
  );
}

function decide(images: readonly LocatedImage[], context: ImageRequestContext): Decision[] {
  const decisions: Decision[] = images.map((image) => (image.eligible ? 'keep' : 'unsupported'));
  const eligible = images.flatMap((image, index) => (image.eligible ? [index] : []));
  if (!context.vision.images) {
    for (const index of eligible) decisions[index] = 'unsupported';
    return decisions;
  }
  const accepted = eligible.filter((index) => {
    if (!imageRefusal(images[index].ref, context.policy)) return true;
    decisions[index] = 'rejected';
    return false;
  });
  const keep = selectImages(
    accepted.map((index) => ({
      cost: estimateImageTokens(images[index].ref, context.vision),
      fresh: images[index].fresh,
    })),
    {
      maxImages: context.policy.maxImagesPerRequest,
      historyTokens: context.limits?.historyTokens ?? context.policy.historyTokens,
      maxFreshImages: context.limits?.maxFreshImages,
    },
  );
  accepted.forEach((imageIndex, slot) => {
    if (!keep[slot]) decisions[imageIndex] = 'budget';
  });
  return decisions;
}

function reportUnavailable(
  ref: ImageRef,
  context: ImageRequestContext,
  reason: string,
  error?: unknown,
): undefined {
  const message = `[Images] Image unavailable (${reason}): ${ref.url}`;
  const args = error === undefined ? [message] : [message, error];
  if (context.reportedUnavailable?.has(ref.url)) {
    context.logger?.debug(...args);
  } else {
    context.logger?.warn(...args);
    context.reportedUnavailable?.add(ref.url);
  }
  return undefined;
}

/** The ref as the provider should receive it, or undefined when its bytes are gone. */
async function resolveImage(
  ref: ImageRef,
  context: ImageRequestContext,
): Promise<ImageRef | undefined> {
  if (isDataUrl(ref.url) || isRemoteUrl(ref.url)) return ref;
  const store = context.policy.store;
  if (!store?.handles(ref.url))
    return reportUnavailable(ref, context, 'no image store handles this reference');
  const cached = context.cache?.get(ref.url);
  if (cached !== undefined) return { ...ref, url: cached };
  try {
    const resolved = await store.get(ref.url, context.signal);
    if (!resolved) return reportUnavailable(ref, context, 'it is no longer in the image store');
    if ('url' in resolved) return { ...ref, url: resolved.url };
    const url = toDataUrl(resolved.mediaType, resolved.bytes);
    context.cache?.set(ref.url, url);
    return { ...ref, url };
  } catch (error) {
    context.signal?.throwIfAborted();
    return reportUnavailable(ref, context, 'the image store failed', error);
  }
}

function rebuild(
  messages: readonly ModelMessage[],
  replacements: ReadonlyMap<string, ModelContent>,
): readonly ModelMessage[] {
  return messages.map((message, messageIndex) => {
    if (typeof message.content === 'string') return message;
    let changed = false;
    const content = message.content.map((part, partIndex) => {
      const replacement = replacements.get(`${messageIndex}:${partIndex}`);
      if (!replacement) return part;
      changed = true;
      return replacement;
    });
    return changed ? { ...message, content } : message;
  });
}

/**
 * Build the image view of one model request: keep what the capability and the
 * budget allow, resolve store references, and put deterministic placeholders
 * where images were left out. The input messages are never modified.
 */
export async function prepareImagesForRequest(
  messages: readonly ModelMessage[],
  context: ImageRequestContext,
): Promise<PreparedImageRequest> {
  const images = locateImages(messages);
  if (images.length === 0) return { messages, report: NO_IMAGES };

  const decisions = decide(images, context);
  const resolvedImages = await Promise.all(
    images.map((image, index) =>
      decisions[index] === 'keep' ? resolveImage(image.ref, context) : undefined,
    ),
  );
  const replacements = new Map<string, ModelContent>();
  const omitted: Record<ImageOmissionReason, number> = {
    budget: 0,
    unsupported: 0,
    unavailable: 0,
    rejected: 0,
  };
  let kept = 0;
  let freshKept = 0;
  let estimatedTokens = 0;
  for (const [index, image] of images.entries()) {
    const key = `${image.messageIndex}:${image.partIndex}`;
    let decision = decisions[index] ?? 'unsupported';
    if (decision === 'keep') {
      const resolved = resolvedImages[index];
      if (resolved) {
        kept += 1;
        if (image.fresh) freshKept += 1;
        estimatedTokens += estimateImageTokens(image.ref, context.vision);
        if (resolved !== image.ref)
          replacements.set(key, { type: 'image_url', image_url: resolved });
        continue;
      }
      decision = 'unavailable';
    }
    omitted[decision] += 1;
    replacements.set(key, { type: 'text', text: imagePlaceholder(decision, image.ref) });
  }

  return {
    messages: rebuild(messages, replacements),
    report: { total: images.length, kept, freshKept, omitted, estimatedTokens },
  };
}
