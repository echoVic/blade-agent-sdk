import type { ImageRef } from '../model/image.js';

/** Why an image was left out of a model request. */
export type ImageOmissionReason = 'budget' | 'unsupported' | 'unavailable' | 'rejected';

/** `image/png 1280×720 — alt`, leaving out whatever is unknown. */
export function describeImage(ref: ImageRef): string {
  const size = ref.width && ref.height ? `${ref.width}×${ref.height}` : '';
  const meta = [ref.mediaType ?? '', size].filter((value) => value !== '').join(' ');
  const rawAlt = ref.alt?.trim() ?? '';
  let alt = '';
  let count = 0;
  for (const point of rawAlt) {
    if (count === 200) {
      alt += '…';
      break;
    }
    alt += point;
    count++;
  }
  if (meta && alt) return `${meta} — ${alt}`;
  return meta || alt;
}

/** How compaction shows an image to the summary model. */
export function summaryImageText(ref: ImageRef): string {
  const description = describeImage(ref);
  return description ? `[image: ${description}]` : '[image]';
}

/** Deterministic text that takes an omitted image's place, so prompt caching still works. */
export function imagePlaceholder(reason: ImageOmissionReason, ref: ImageRef): string {
  const description = describeImage(ref);
  switch (reason) {
    case 'budget':
      return description
        ? `[image omitted to fit the image budget: ${description}]`
        : '[image omitted to fit the image budget]';
    case 'unsupported':
      return description
        ? `[image omitted: the current model does not accept images — ${description}]`
        : '[image omitted: the current model does not accept images]';
    case 'rejected':
      return description
        ? `[image omitted: the current model or the image policy does not accept this image — ${description}]`
        : '[image omitted: the current model or the image policy does not accept this image]';
    case 'unavailable':
      return '[image unavailable: it is no longer in the image store]';
  }
}
