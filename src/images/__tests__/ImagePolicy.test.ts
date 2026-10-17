import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import { assertImagePolicy, resolveImagePolicy } from '../ImagePolicy.js';
import { InMemoryImageStore } from '../InMemoryImageStore.js';
import { IMAGE_MEDIA_TYPES } from '../imageBytes.js';

const MIB = 1024 * 1024;

describe('resolveImagePolicy', () => {
  it('derives defaults from the model capability and the input window', () => {
    expect(
      resolveImagePolicy(undefined, {
        vision: {
          images: true,
          toolResultImages: true,
          maxImageBytes: 5 * MIB,
          maxImagesPerRequest: 100,
        },
        inputWindowTokens: 120_000,
      }),
    ).toEqual({
      maxImageBytes: 5 * MIB,
      maxImagesPerInput: 20,
      historyTokens: 16_000,
      maxImagesPerRequest: 100,
      whenUnsupported: 'reject',
      remoteUrls: true,
      mediaTypes: IMAGE_MEDIA_TYPES,
    });
    expect(
      resolveImagePolicy(undefined, {
        vision: { images: true, toolResultImages: false },
        inputWindowTokens: 24_000,
      }).historyTokens,
    ).toBe(6_000);
    expect(
      resolveImagePolicy(undefined, { vision: { images: true, toolResultImages: false } }),
    ).toMatchObject({ maxImageBytes: 10 * MIB, maxImagesPerRequest: 50, historyTokens: 16_000 });
  });

  it('lets the policy override every default', () => {
    const store = new InMemoryImageStore();
    expect(
      resolveImagePolicy(
        {
          store,
          maxImageBytes: 1024,
          maxImagesPerInput: 2,
          historyTokens: 0,
          maxImagesPerRequest: 3,
          whenUnsupported: 'omit',
          remoteUrls: false,
        },
        { vision: { images: true, toolResultImages: true, mediaTypes: ['image/png'] } },
      ),
    ).toEqual({
      store,
      maxImageBytes: 1024,
      maxImagesPerInput: 2,
      historyTokens: 0,
      maxImagesPerRequest: 3,
      whenUnsupported: 'omit',
      remoteUrls: false,
      mediaTypes: ['image/png'],
    });
  });

  it('rejects invalid limits', () => {
    expect(() => assertImagePolicy({ maxImageBytes: 0 })).toThrow(ConfigError);
    expect(() => assertImagePolicy({ maxImagesPerRequest: 1.5 })).toThrow(ConfigError);
    expect(() => assertImagePolicy({ historyTokens: -1 })).toThrow(ConfigError);
    expect(() => assertImagePolicy({ historyTokens: 0 })).not.toThrow();
    expect(() => assertImagePolicy(undefined)).not.toThrow();
  });

  it('caps a policy count at the model limit', () => {
    expect(
      resolveImagePolicy(
        { maxImagesPerRequest: 200 },
        {
          vision: { images: true, toolResultImages: true, maxImagesPerRequest: 100 },
        },
      ).maxImagesPerRequest,
    ).toBe(100);
  });
});
