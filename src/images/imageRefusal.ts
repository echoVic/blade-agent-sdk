import type { ImageRef } from '../model/image.js';
import { base64DecodedLength, base64PrefixToBytes, parseBase64DataUrl } from './base64.js';
import type { ResolvedImagePolicy } from './ImagePolicy.js';
import { sniffImageMediaType } from './imageBytes.js';
import { isDataUrl, isRemoteUrl } from './imageUrls.js';

export const canonicalMediaType = (type: string): string =>
  type.toLowerCase() === 'image/jpg' ? 'image/jpeg' : type.toLowerCase();

/** Recheck known image facts without decoding the whole inline payload or fetching a URL. */
export function imageRefusal(
  ref: ImageRef,
  policy: ResolvedImagePolicy,
): 'remote_url' | 'too_large' | 'media_type' | undefined {
  if (isRemoteUrl(ref.url) && !policy.remoteUrls) return 'remote_url';
  const inline = parseBase64DataUrl(ref.url);
  const byteLength = inline ? base64DecodedLength(inline.base64) : ref.byteLength;
  if (byteLength !== undefined && byteLength > policy.maxImageBytes) return 'too_large';
  let mediaType = ref.mediaType;
  if (isDataUrl(ref.url)) {
    mediaType = inline ? sniffImageMediaType(base64PrefixToBytes(inline.base64, 32)) : undefined;
    if (!mediaType) return 'media_type';
  }
  if (mediaType && !policy.mediaTypes.includes(canonicalMediaType(mediaType))) return 'media_type';
  return undefined;
}
