import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import { SessionInputError } from '../../errors/SessionInputError.js';
import { ImageRuntime } from '../ImageRuntime.js';
import { InMemoryImageStore } from '../InMemoryImageStore.js';
import { ONE_PIXEL_PNG_DATA_URL } from './fixtures.js';

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

  it('warns once per unavailable URL in each runtime and debugs repeated misses', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child() {
        return this;
      },
    };
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'image_url' as const, image_url: { url: 'app-image:gone' } }],
      },
    ];
    const runtime = new ImageRuntime({ logger });
    const first = await runtime.prepareRequest(messages);
    const second = await runtime.prepareRequest(messages);

    expect(first.messages[0]?.content).toEqual([
      { type: 'text', text: '[image unavailable: it is no longer in the image store]' },
    ]);
    expect(second).toEqual(first);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      '[Images] Image unavailable (no image store handles this reference): app-image:gone',
    );

    await new ImageRuntime({ logger }).prepareRequest(messages);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('admits an image into its store and resolves it again for a request', async () => {
    const runtime = new ImageRuntime({ policy: { store: new InMemoryImageStore() } });
    const content = await runtime.normalizeUserContent([
      { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
    ]);
    const prepared = await runtime.prepareRequest([{ role: 'user', content }]);

    expect(JSON.stringify(content)).not.toContain(';base64,');
    expect(prepared.messages[0]?.content).toEqual([
      {
        type: 'image_url',
        image_url: {
          url: ONE_PIXEL_PNG_DATA_URL,
          mediaType: 'image/png',
          width: 1,
          height: 1,
          byteLength: 70,
        },
      },
    ]);
  });
});
