export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export interface ImageFacts {
  readonly mediaType: ImageMediaType;
  readonly byteLength: number;
  readonly width?: number;
  readonly height?: number;
}

interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return (
    bytes.length >= offset + prefix.length &&
    prefix.every((value, index) => bytes[offset + index] === value)
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return bytes.length < offset + length
    ? ''
    : String.fromCharCode(...bytes.subarray(offset, offset + length));
}

const uint16be = (bytes: Uint8Array, offset: number) => (bytes[offset] << 8) | bytes[offset + 1];
const uint16le = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
const uint24le = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
const uint32be = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] << 24) >>> 0) +
  ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);

function size(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Identify a raster image by its magic bytes. SVG and everything else return undefined. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const gif = ascii(bytes, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

function pngSize(bytes: Uint8Array): ImageSize | undefined {
  return bytes.length >= 24 && ascii(bytes, 12, 4) === 'IHDR'
    ? size(uint32be(bytes, 16), uint32be(bytes, 20))
    : undefined;
}

function gifSize(bytes: Uint8Array): ImageSize | undefined {
  return bytes.length >= 10 ? size(uint16le(bytes, 6), uint16le(bytes, 8)) : undefined;
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = uint16be(bytes, offset + 2);
    if (length < 2) return undefined;
    if (JPEG_SOF_MARKERS.has(marker)) {
      return offset + 9 <= bytes.length
        ? size(uint16be(bytes, offset + 7), uint16be(bytes, offset + 5))
        : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8 ') {
    return startsWith(bytes, [0x9d, 0x01, 0x2a], 23)
      ? size(uint16le(bytes, 26) & 0x3fff, uint16le(bytes, 28) & 0x3fff)
      : undefined;
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    return size(uint24le(bytes, 24) + 1, uint24le(bytes, 27) + 1);
  }
  return undefined;
}

function readImageSize(bytes: Uint8Array, mediaType: ImageMediaType): ImageSize | undefined {
  switch (mediaType) {
    case 'image/png':
      return pngSize(bytes);
    case 'image/jpeg':
      return jpegSize(bytes);
    case 'image/gif':
      return gifSize(bytes);
    case 'image/webp':
      return webpSize(bytes);
  }
}

/**
 * Media type, pixel size and byte length of a png, jpeg, gif or webp image.
 * Returns undefined for anything else. A truncated header keeps the media type
 * and drops the size.
 */
export function inspectImageBytes(bytes: Uint8Array): ImageFacts | undefined {
  const mediaType = sniffImageMediaType(bytes);
  if (!mediaType) return undefined;
  return { mediaType, byteLength: bytes.byteLength, ...readImageSize(bytes, mediaType) };
}
