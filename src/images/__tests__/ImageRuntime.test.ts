import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import { SessionInputError } from '../../errors/SessionInputError.js';
import { ImageRuntime } from '../ImageRuntime.js';

describe('ImageRuntime', () => {
  it('follows the bound model and uses the fallback before binding', () => {
    const runtime = new ImageRuntime({
      fallbackVision: () => ({ images: false, toolResultImages: false }),
    });
    expect(runtime.vision().images).toBe(false);

    let accepts = true;
    runtime.bindModel({
      getVision: () => ({ images: accepts, toolResultImages: true, imageTokens: 1600 }),
      getInputWindowTokens: () => 24_000,
      markImagesUnsupported: () => {
        accepts = false;
      },
    });
    expect(runtime.vision().images).toBe(true);
    expect(runtime.policy().historyTokens).toBe(6_000);

    runtime.markImagesUnsupported();
    expect(runtime.vision().images).toBe(false);
  });

  it('wraps rejections in SessionInputError', async () => {
    const runtime = new ImageRuntime({ policy: { remoteUrls: false } });
    const rejected = runtime.normalizeUserContent([
      { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
    ]);

    await expect(rejected).rejects.toBeInstanceOf(SessionInputError);
    await expect(rejected).rejects.toMatchObject({
      code: 'SESSION_INPUT_IMAGE_REJECTED',
      details: { index: 0, reason: 'remote_url' },
    });
  });

  it('rejects an invalid policy at construction', () => {
    expect(() => new ImageRuntime({ policy: { maxImagesPerRequest: 0 } })).toThrow(ConfigError);
  });
});
