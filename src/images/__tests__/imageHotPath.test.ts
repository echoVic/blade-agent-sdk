import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64PrefixToBytes } from '../base64.js';
import { resolveImagePolicy } from '../ImagePolicy.js';
import { imageRefusal } from '../imageRefusal.js';
import { normalizeImageContent } from '../normalizeImages.js';
import {
  dataUrl,
  gifBytes,
  jpegBytes,
  ONE_PIXEL_PNG_DATA_URL,
  pngBytes,
  webpLossyBytes,
} from './fixtures.js';

vi.mock('../base64.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../base64.js')>();
  return { ...original, base64PrefixToBytes: vi.fn(original.base64PrefixToBytes) };
});
const vision = { images: true, toolResultImages: false };
const policy = resolveImagePolicy(undefined, { vision });
afterEach(() => {
  vi.mocked(base64PrefixToBytes).mockClear();
});

describe('image hot path byte work', () => {
  it.each([
    ['image/png', pngBytes(1, 1, 100_000)],
    ['image/jpeg', jpegBytes(1, 1)],
    ['image/gif', gifBytes(1, 1)],
    ['image/webp', webpLossyBytes(1, 1)],
  ] as const)('sniffs %s using at most 32 decoded bytes', (mediaType, bytes) => {
    expect(imageRefusal({ url: dataUrl(mediaType, bytes) }, policy)).toBeUndefined();
    const calls = vi.mocked(base64PrefixToBytes).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([, maxBytes]) => maxBytes <= 32)).toBe(true);
  });
  it('does not decode or sniff an extra prefix after admission inspects all bytes', async () => {
    await expect(
      normalizeImageContent([{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } }], {
        policy,
        vision,
      }),
    ).resolves.toMatchObject([{ image_url: { mediaType: 'image/png', byteLength: 70 } }]);
    expect(base64PrefixToBytes).not.toHaveBeenCalled();
  });
});
