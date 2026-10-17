import type { ImageRejectionReason } from '../errors/SessionInputError.js';
import type { ImageRef } from '../model/image.js';
import type { ModelContent } from '../model/message.js';
import type { VisionCapability } from '../model/vision.js';
import {
  type Base64DataUrl,
  base64DecodedLength,
  base64ToBytes,
  parseBase64DataUrl,
} from './base64.js';
import type { ResolvedImagePolicy } from './ImagePolicy.js';
import { inspectImageBytes } from './imageBytes.js';
import { imageRefusal } from './imageRefusal.js';
import { isDataUrl, isRemoteUrl } from './imageUrls.js';

/** An image part `send()` refuses; `index` is its position in the content array. */
export class ImageRejection extends Error {
  constructor(
    readonly index: number,
    readonly reason: ImageRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'ImageRejection';
  }
}

export interface NormalizeImagesContext {
  readonly policy: ResolvedImagePolicy;
  readonly vision: VisionCapability;
  readonly signal?: AbortSignal;
}

async function admitInlineImage(
  ref: ImageRef,
  inline: Base64DataUrl,
  index: number,
  context: NormalizeImagesContext,
): Promise<ImageRef> {
  const { policy } = context;
  const tooLarge = () =>
    new ImageRejection(index, 'too_large', `Images must be at most ${policy.maxImageBytes} bytes`);
  if (base64DecodedLength(inline.base64) > policy.maxImageBytes) throw tooLarge();
  const bytes = base64ToBytes(inline.base64);
  if (bytes.byteLength > policy.maxImageBytes) throw tooLarge();

  const facts = inspectImageBytes(bytes);
  if (!facts || imageRefusal({ ...ref, ...facts }, policy)) {
    throw new ImageRejection(
      index,
      'media_type',
      'Only png, jpeg, gif and webp images are accepted',
    );
  }

  const metadata: Partial<ImageRef> = {
    mediaType: facts.mediaType,
    byteLength: facts.byteLength,
    ...(facts.width !== undefined && facts.height !== undefined
      ? { width: facts.width, height: facts.height }
      : {}),
  };
  if (!policy.store) return { ...ref, ...metadata };
  const stored = await policy.store.put({ bytes, mediaType: facts.mediaType }, context.signal);
  return { ...ref, ...metadata, url: stored.url };
}

async function admitImage(
  ref: ImageRef,
  index: number,
  context: NormalizeImagesContext,
): Promise<ImageRef> {
  const inline = parseBase64DataUrl(ref.url);
  if (inline) return admitInlineImage(ref, inline, index, context);
  if (isDataUrl(ref.url)) {
    throw new ImageRejection(
      index,
      'media_type',
      'Inline images must be base64 png, jpeg, gif or webp data',
    );
  }
  const refusal = imageRefusal(ref, context.policy);
  if (refusal) {
    const messages = {
      remote_url: 'Remote image URLs are not accepted',
      too_large: `Images must be at most ${context.policy.maxImageBytes} bytes`,
      media_type: 'Only png, jpeg, gif and webp images are accepted',
    };
    throw new ImageRejection(index, refusal, messages[refusal]);
  }
  if (isRemoteUrl(ref.url)) return ref;
  if (context.policy.store?.handles(ref.url)) return ref;
  throw new ImageRejection(index, 'unresolvable', 'No image store resolves this image reference');
}

/**
 * Admit the images of one input: check count, capability, size and real media
 * type, add metadata, and move inline bytes into the store when one is
 * configured. Content without images is returned as is.
 */
export async function normalizeImageContent(
  content: string | ModelContent[],
  context: NormalizeImagesContext,
): Promise<string | ModelContent[]> {
  if (typeof content === 'string') return content;
  const imageIndexes = content.flatMap((part, index) => (part.type === 'image_url' ? [index] : []));
  if (imageIndexes.length === 0) return content;

  const { policy, vision } = context;
  if (imageIndexes.length > policy.maxImagesPerInput) {
    throw new ImageRejection(
      imageIndexes[policy.maxImagesPerInput] ?? 0,
      'too_many',
      `At most ${policy.maxImagesPerInput} images are accepted in one input`,
    );
  }
  if (!vision.images && policy.whenUnsupported === 'reject') {
    throw new ImageRejection(
      imageIndexes[0] ?? 0,
      'unsupported_model',
      'The current model does not accept images',
    );
  }

  const normalized: ModelContent[] = [];
  for (const [index, part] of content.entries()) {
    context.signal?.throwIfAborted();
    normalized.push(
      part.type === 'image_url'
        ? { type: 'image_url', image_url: await admitImage(part.image_url, index, context) }
        : part,
    );
  }
  return normalized;
}
