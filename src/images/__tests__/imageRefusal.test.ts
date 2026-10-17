import { describe, expect, it } from 'vitest';
import { resolveImagePolicy } from '../ImagePolicy.js';
import { imageRefusal } from '../imageRefusal.js';
import { ONE_PIXEL_PNG_DATA_URL } from './fixtures.js';

const vision = { images: true, toolResultImages: false };
const policy = resolveImagePolicy({ maxImageBytes: 69 }, { vision });

describe('imageRefusal inline facts', () => {
  it('checks actual decoded bytes even when declared byteLength is smaller', () => {
    expect(imageRefusal({ url: ONE_PIXEL_PNG_DATA_URL, byteLength: 1 }, policy)).toBe('too_large');
  });
  it.each([
    `data:image/png;base64,${btoa('<svg/>')}`,
    'data:image/png,not-base64',
  ])('refuses unsupported inline bytes despite a declared raster type: %s', (url) => {
    expect(imageRefusal({ url, mediaType: 'image/png' }, policy)).toBe('media_type');
  });
  it('uses the sniffed raster type instead of the declared type for the allowlist', () => {
    const jpegOnly = resolveImagePolicy(undefined, {
      vision: { ...vision, mediaTypes: ['image/jpeg'] },
    });
    expect(imageRefusal({ url: ONE_PIXEL_PNG_DATA_URL, mediaType: 'image/jpeg' }, jpegOnly)).toBe(
      'media_type',
    );
  });
  it('keeps declared metadata authoritative for non-inline references', () => {
    expect(imageRefusal({ url: 'https://example.test/a.png', byteLength: 70 }, policy)).toBe(
      'too_large',
    );
    expect(imageRefusal({ url: 'custom:image', mediaType: 'image/svg+xml' }, policy)).toBe(
      'media_type',
    );
  });
});
