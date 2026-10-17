import { describe, expect, it } from 'vitest';
import { base64ToBytes } from '../base64.js';
import { inspectImageBytes, sniffImageMediaType } from '../imageBytes.js';
import {
  gifBytes,
  jpegBytes,
  ONE_PIXEL_PNG_BASE64,
  pngBytes,
  webpExtendedBytes,
  webpLosslessBytes,
  webpLossyBytes,
} from './fixtures.js';

const encoder = new TextEncoder();

describe('inspectImageBytes', () => {
  it.each([
    ['png', pngBytes(1280, 720), 'image/png', 1280, 720],
    ['baseline jpeg', jpegBytes(640, 480), 'image/jpeg', 640, 480],
    ['progressive jpeg', jpegBytes(800, 600, { progressive: true }), 'image/jpeg', 800, 600],
    [
      'jpeg with EXIF before SOF',
      jpegBytes(1024, 768, { exifBytes: 4096 }),
      'image/jpeg',
      1024,
      768,
    ],
    ['gif', gifBytes(320, 200), 'image/gif', 320, 200],
    ['lossy webp', webpLossyBytes(1920, 1080), 'image/webp', 1920, 1080],
    ['lossless webp', webpLosslessBytes(256, 128), 'image/webp', 256, 128],
    ['extended webp', webpExtendedBytes(4000, 3000), 'image/webp', 4000, 3000],
  ] as const)('reads %s headers', (_name, bytes, mediaType, width, height) => {
    expect(inspectImageBytes(bytes)).toEqual({
      mediaType,
      width,
      height,
      byteLength: bytes.byteLength,
    });
  });

  it('reads a real PNG', () => {
    expect(inspectImageBytes(base64ToBytes(ONE_PIXEL_PNG_BASE64))).toEqual({
      mediaType: 'image/png',
      width: 1,
      height: 1,
      byteLength: 70,
    });
  });

  it('refuses SVG and unknown bytes', () => {
    expect(sniffImageMediaType(encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      undefined,
    );
    expect(inspectImageBytes(encoder.encode('<?xml version="1.0"?><svg/>'))).toBeUndefined();
    expect(inspectImageBytes(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('keeps the media type when a truncated header hides the size', () => {
    expect(inspectImageBytes(pngBytes(10, 10).subarray(0, 12))).toEqual({
      mediaType: 'image/png',
      byteLength: 12,
    });
    expect(inspectImageBytes(jpegBytes(10, 10, { exifBytes: 64 }).subarray(0, 40))).toEqual({
      mediaType: 'image/jpeg',
      byteLength: 40,
    });
    expect(inspectImageBytes(webpLossyBytes(10, 10).subarray(0, 16))).toEqual({
      mediaType: 'image/webp',
      byteLength: 16,
    });
  });

  it('stops at a corrupt JPEG segment instead of reading past it', () => {
    const bytes = jpegBytes(10, 10, { exifBytes: 8 });
    bytes[4] = 0x00;
    bytes[5] = 0x01;
    expect(inspectImageBytes(bytes)).toEqual({ mediaType: 'image/jpeg', byteLength: 35 });
  });
});
