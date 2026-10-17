import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_TOKENS, estimateImageTokens } from '../estimateImageTokens.js';
import { dataUrl, pngBytes } from './fixtures.js';

describe('estimateImageTokens', () => {
  it.each([
    ['openai 1024×1024', 1024, 1024, 'openai', 765],
    ['openai 2048×4096', 2048, 4096, 'openai', 1105],
    ['openai 512×512', 512, 512, 'openai', 255],
    ['anthropic 1092×1092', 1092, 1092, 'anthropic', 1590],
    ['anthropic 200×200', 200, 200, 'anthropic', 54],
    ['anthropic 4000×3000', 4000, 3000, 'anthropic', 1600],
    ['gemini 384×384', 384, 384, 'gemini', 258],
    ['gemini 1920×1080', 1920, 1080, 'gemini', 1548],
  ] as const)('%s', (_name, width, height, imageTokens, expected) => {
    expect(
      estimateImageTokens({ url: 'blade-image:sha256:x', width, height }, { imageTokens }),
    ).toBe(expected);
  });

  it('charges 85 tokens for low detail on the openai formula', () => {
    expect(
      estimateImageTokens(
        { url: 'x', detail: 'low', width: 4000, height: 4000 },
        { imageTokens: 'openai' },
      ),
    ).toBe(85);
  });

  it('uses a fixed count when the capability gives one', () => {
    expect(
      estimateImageTokens({ url: 'x', width: 4000, height: 4000 }, { imageTokens: 1234 }),
    ).toBe(1234);
  });

  it('reads the size from an inline data URL when the reference has none', () => {
    const url = dataUrl('image/png', pngBytes(1024, 1024, 2048));
    expect(estimateImageTokens({ url }, { imageTokens: 'openai' })).toBe(765);
  });

  it('falls back to the default when the size is unknown', () => {
    expect(
      estimateImageTokens({ url: 'https://example.test/a.png' }, { imageTokens: 'anthropic' }),
    ).toBe(DEFAULT_IMAGE_TOKENS);
    expect(estimateImageTokens({ url: 'https://example.test/a.png' })).toBe(DEFAULT_IMAGE_TOKENS);
  });
});
