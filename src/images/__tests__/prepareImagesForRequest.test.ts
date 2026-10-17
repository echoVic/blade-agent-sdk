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
import { ONE_PIXEL_PNG_BASE64, ONE_PIXEL_PNG_DATA_URL } from './fixtures.js';

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

describe('prepareImagesForRequest', () => {
  it('returns the same array when no message carries an image', async () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    const prepared = await prepareImagesForRequest(messages, { vision, policy: basePolicy });
    expect(prepared.messages).toBe(messages);
    expect(prepared.report.total).toBe(0);
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
    await prepareImagesForRequest(messages, { vision, policy: { ...basePolicy, store }, cache });

    expect(first.messages[0]?.content).toEqual([
      { type: 'image_url', image_url: { ...ref, url: ONE_PIXEL_PNG_DATA_URL } },
    ]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('passes a presigned URL from the store straight to the request', async () => {
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
      { vision, policy: { ...basePolicy, store } },
    );

    expect(prepared.messages[0]?.content).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'https://bucket.example.test/a.png?sig=1', mediaType: 'image/png' },
      },
    ]);
  });

  it('turns missing, failing and unknown references into placeholders', async () => {
    const store: ImageStore = {
      handles: (url) => url.startsWith('app-image:'),
      put: async () => {
        throw new Error('unused');
      },
      get: async (url) => {
        if (url === 'app-image:broken') throw new Error('disk failure');
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
    });

    expect(prepared.messages[0]?.content).toEqual([unavailable, unavailable, unavailable]);
    expect(prepared.report.omitted.unavailable).toBe(3);
  });
});
