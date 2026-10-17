import { LRUCache } from 'lru-cache';
import { describe, expect, it, vi } from 'vitest';
import type { ImageRef } from '../../model/image.js';
import type { ModelContent, ModelMessage } from '../../model/message.js';
import type { VisionCapability } from '../../model/vision.js';
import { base64ToBytes } from '../base64.js';
import { resolveImagePolicy } from '../ImagePolicy.js';
import type { ImageStore } from '../ImageStore.js';
import { InMemoryImageStore } from '../InMemoryImageStore.js';
import { prepareImagesForRequest } from '../prepareImagesForRequest.js';
import { dataUrl, ONE_PIXEL_PNG_BASE64, ONE_PIXEL_PNG_DATA_URL, pngBytes } from './fixtures.js';

const vision: VisionCapability = { images: true, toolResultImages: true, imageTokens: 1600 };
const basePolicy = resolveImagePolicy(undefined, { vision, inputWindowTokens: 120_000 });
const image = (extra: Partial<ImageRef> = {}): ModelContent => ({
  type: 'image_url',
  image_url: { url: ONE_PIXEL_PNG_DATA_URL, mediaType: 'image/png', width: 1, height: 1, ...extra },
});
const unavailable = {
  type: 'text',
  text: '[image unavailable: it is no longer in the image store]',
};

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return this;
    },
  };
}

describe('prepareImagesForRequest', () => {
  it('returns the same array when no message carries an image', async () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    const prepared = await prepareImagesForRequest(messages, { vision, policy: basePolicy });
    expect(prepared.messages).toBe(messages);
    expect(prepared.report.total).toBe(0);
  });

  it('keeps a data URL with an uppercase scheme unchanged without a store', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [image({ url: ONE_PIXEL_PNG_DATA_URL.replace('data:', 'DATA:') })] },
    ];
    const prepared = await prepareImagesForRequest(messages, { vision, policy: basePolicy });

    expect(prepared.messages[0]).toBe(messages[0]);
    expect(prepared.messages).toEqual(messages);
    expect(prepared.report).toMatchObject({ kept: 1, omitted: { unavailable: 0 } });
  });

  it('replaces every image with a placeholder for a model without vision', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'see' }, image({ alt: 'dot' })] },
    ];
    const prepared = await prepareImagesForRequest(messages, {
      vision: { images: false, toolResultImages: false },
      policy: basePolicy,
    });

    expect(prepared.messages[0]?.content).toEqual([
      { type: 'text', text: 'see' },
      {
        type: 'text',
        text: '[image omitted: the current model does not accept images — image/png 1×1 — dot]',
      },
    ]);
    expect(prepared.report).toMatchObject({ total: 1, kept: 0, omitted: { unsupported: 1 } });
    expect(messages[0]?.content).toEqual([{ type: 'text', text: 'see' }, image({ alt: 'dot' })]);
  });

  it('keeps fresh images and drops the oldest history images past the allowance', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [image({ alt: 'old' })] },
      { role: 'assistant', content: 'noted' },
      { role: 'user', content: [image({ alt: 'mid' })] },
      { role: 'assistant', content: 'noted' },
      { role: 'user', content: [image({ alt: 'new' })] },
    ];
    const prepared = await prepareImagesForRequest(messages, {
      vision,
      policy: { ...basePolicy, historyTokens: 1_600 },
    });

    expect(prepared.messages[0]?.content).toEqual([
      { type: 'text', text: '[image omitted to fit the image budget: image/png 1×1 — old]' },
    ]);
    expect(prepared.messages[2]).toBe(messages[2]);
    expect(prepared.messages[4]).toBe(messages[4]);
    expect(prepared.report).toMatchObject({
      total: 3,
      kept: 2,
      freshKept: 1,
      omitted: { budget: 1, unsupported: 0, unavailable: 0 },
      estimatedTokens: 3_200,
    });
  });

  it('applies recovery limits', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [image()] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [image(), image()] },
    ];
    const prepared = await prepareImagesForRequest(messages, {
      vision,
      policy: basePolicy,
      limits: { historyTokens: 0, maxFreshImages: 1 },
    });

    expect(prepared.report).toMatchObject({ kept: 1, freshKept: 1, omitted: { budget: 2 } });
    expect(prepared.messages[2]?.content).toEqual([
      { type: 'text', text: '[image omitted to fit the image budget: image/png 1×1]' },
      image(),
    ]);
  });

  it('replaces images in system and assistant messages', async () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: [image()] },
      { role: 'assistant', content: [image()] },
      { role: 'user', content: 'next' },
    ];
    const prepared = await prepareImagesForRequest(messages, { vision, policy: basePolicy });
    expect(prepared.report).toMatchObject({ total: 2, kept: 0, omitted: { unsupported: 2 } });
  });

  it('resolves store references and caches the bytes', async () => {
    const store = new InMemoryImageStore();
    const ref = await store.put({
      bytes: base64ToBytes(ONE_PIXEL_PNG_BASE64),
      mediaType: 'image/png',
    });
    const get = vi.spyOn(store, 'get');
    const cache = new LRUCache<string, string>({
      maxSize: 1024 * 1024,
      sizeCalculation: (value) => value.length,
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: ref }] },
    ];

    const first = await prepareImagesForRequest(messages, {
      vision,
      policy: { ...basePolicy, store },
      cache,
    });
    const second = await prepareImagesForRequest(messages, {
      vision,
      policy: { ...basePolicy, store },
      cache,
    });

    expect(first.messages[0]?.content).toEqual([
      { type: 'image_url', image_url: { ...ref, url: ONE_PIXEL_PNG_DATA_URL } },
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(second.messages).toEqual(first.messages);
  });

  it('passes a presigned URL from the store straight to the request', async () => {
    const cache = new LRUCache<string, string>({ max: 10 });
    const store: ImageStore = {
      handles: (url) => url.startsWith('s3://'),
      put: async () => {
        throw new Error('unused');
      },
      get: async () => ({ url: 'https://bucket.example.test/a.png?sig=1' }),
    };
    const prepared = await prepareImagesForRequest(
      [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 's3://bucket/a.png', mediaType: 'image/png' } },
          ],
        },
      ],
      { vision, policy: { ...basePolicy, store }, cache },
    );

    expect(prepared.messages[0]?.content).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'https://bucket.example.test/a.png?sig=1', mediaType: 'image/png' },
      },
    ]);
    expect(cache.size).toBe(0);
  });

  it('turns missing, failing and unknown references into placeholders', async () => {
    const logger = createLogger();
    const reportedUnavailable = new Set<string>();
    const failure = new Error('disk failure');
    const store: ImageStore = {
      handles: (url) => url.startsWith('app-image:'),
      put: async () => {
        throw new Error('unused');
      },
      get: async (url) => {
        if (url === 'app-image:broken') throw failure;
        return undefined;
      },
    };
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'app-image:gone' } },
          { type: 'image_url', image_url: { url: 'app-image:broken' } },
          { type: 'image_url', image_url: { url: 'other:unknown' } },
        ],
      },
    ];
    const prepared = await prepareImagesForRequest(messages, {
      vision,
      policy: { ...basePolicy, store },
      logger,
      reportedUnavailable,
    });

    expect(prepared.messages[0]?.content).toEqual([unavailable, unavailable, unavailable]);
    expect(prepared.report.omitted.unavailable).toBe(3);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      '[Images] Image unavailable (it is no longer in the image store): app-image:gone',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[Images] Image unavailable (the image store failed): app-image:broken',
      failure,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[Images] Image unavailable (no image store handles this reference): other:unknown',
    );
    expect(reportedUnavailable).toEqual(
      new Set(['app-image:gone', 'app-image:broken', 'other:unknown']),
    );

    const second = await prepareImagesForRequest(messages, {
      vision,
      policy: { ...basePolicy, store },
      logger,
      reportedUnavailable,
    });
    expect(second).toEqual(prepared);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.debug).toHaveBeenCalledTimes(3);
    expect(logger.debug.mock.calls).toEqual(logger.warn.mock.calls);
  });

  it('warns on every miss when no reported-unavailable set is provided', async () => {
    const logger = createLogger();
    const messages: ModelMessage[] = [{ role: 'user', content: [image({ url: 'other:unknown' })] }];
    await prepareImagesForRequest(messages, { vision, policy: basePolicy, logger });
    await prepareImagesForRequest(messages, { vision, policy: basePolicy, logger });

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('resolves kept store references concurrently and preserves image order', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const store: ImageStore = {
      handles: (url) => url.startsWith('app-image:'),
      put: async () => {
        throw new Error('unused');
      },
      get: async (url) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { url: `https://example.test/${url.slice('app-image:'.length)}.png` };
      },
    };
    const prepared = await prepareImagesForRequest(
      [{ role: 'user', content: [image({ url: 'app-image:1' }), image({ url: 'app-image:2' })] }],
      { vision, policy: { ...basePolicy, store } },
    );

    expect(peakInFlight).toBe(2);
    expect(inFlight).toBe(0);
    expect(prepared.messages[0]?.content).toEqual([
      image({ url: 'https://example.test/1.png' }),
      image({ url: 'https://example.test/2.png' }),
    ]);
    expect(prepared.report).toEqual({
      total: 2,
      kept: 2,
      freshKept: 2,
      omitted: { budget: 0, unsupported: 0, unavailable: 0, rejected: 0 },
      estimatedTokens: 3_200,
    });
  });

  it('rejects with the abort reason when a store aborts resolution', async () => {
    const controller = new AbortController();
    const logger = createLogger();
    const store: ImageStore = {
      handles: (url) => url.startsWith('app-image:'),
      put: async () => {
        throw new Error('unused');
      },
      get: async (_url, signal) => {
        controller.abort();
        throw signal?.reason;
      },
    };

    await expect(
      prepareImagesForRequest([{ role: 'user', content: [image({ url: 'app-image:1' })] }], {
        vision,
        policy: { ...basePolicy, store },
        signal: controller.signal,
        logger,
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      'oversized history',
      {
        url: 'https://example.test/large.png',
        mediaType: 'image/png',
        byteLength: 8 * 1024 * 1024,
      },
      { maxImageBytes: 5 * 1024 * 1024 },
      'image/png',
    ],
    [
      'disallowed GIF',
      { url: 'https://example.test/a.gif', mediaType: 'image/gif' },
      { mediaTypes: ['image/png'] },
      'image/gif',
    ],
    ['remote URL', { url: 'https://example.test/secret.png' }, { remoteUrls: false }, ''],
    ['legacy oversized inline', { url: ONE_PIXEL_PNG_DATA_URL }, { maxImageBytes: 69 }, ''],
    ['legacy non-raster inline', { url: `data:image/png;base64,${btoa('<svg/>')}` }, {}, ''],
  ] as const)('rejects %s under the current policy before budgeting', async (_name, ref, overrides, description) => {
    const prepared = await prepareImagesForRequest(
      [
        { role: 'user', content: [{ type: 'image_url', image_url: ref }] },
        { role: 'assistant', content: 'seen' },
      ],
      { vision, policy: { ...basePolicy, ...overrides } },
    );
    expect(prepared.messages[0]?.content).toEqual([
      {
        type: 'text',
        text: `[image omitted: the current model or the image policy does not accept this image${description ? ` — ${description}` : ''}]`,
      },
    ]);
    expect(prepared.report).toMatchObject({ kept: 0, omitted: { rejected: 1 } });
    expect(JSON.stringify(prepared.messages)).not.toContain(ref.url);
  });

  it('does not spend a fresh place on a refused image', async () => {
    const accepted = image({ alt: 'accepted' });
    const prepared = await prepareImagesForRequest(
      [
        {
          role: 'user',
          content: [
            accepted,
            image({ url: dataUrl('image/png', pngBytes(1, 1, 71)), byteLength: 1 }),
          ],
        },
      ],
      { vision, policy: { ...basePolicy, maxImagesPerRequest: 1, maxImageBytes: 70 } },
    );
    expect(prepared.messages[0]?.content).toEqual([
      accepted,
      {
        type: 'text',
        text: '[image omitted: the current model or the image policy does not accept this image — image/png 1×1]',
      },
    ]);
    expect(prepared.report).toMatchObject({ freshKept: 1, omitted: { rejected: 1, budget: 0 } });
  });
});
