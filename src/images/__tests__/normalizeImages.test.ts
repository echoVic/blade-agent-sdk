import { describe, expect, it } from 'vitest';
import type { ModelContent, ModelImageContent } from '../../model/message.js';
import type { VisionCapability } from '../../model/vision.js';
import { type ResolvedImagePolicy, resolveImagePolicy } from '../ImagePolicy.js';
import { InMemoryImageStore } from '../InMemoryImageStore.js';
import { normalizeImageContent } from '../normalizeImages.js';
import {
  dataUrl,
  ONE_PIXEL_JPEG_BASE64,
  ONE_PIXEL_PNG_BASE64,
  ONE_PIXEL_PNG_DATA_URL,
  pngBytes,
} from './fixtures.js';

const vision: VisionCapability = { images: true, toolResultImages: false, imageTokens: 1600 };
const blind: VisionCapability = { images: false, toolResultImages: false };

function policy(overrides: Partial<ResolvedImagePolicy> = {}): ResolvedImagePolicy {
  return { ...resolveImagePolicy(undefined, { vision }), ...overrides };
}

const image = (url: string): ModelContent => ({ type: 'image_url', image_url: { url } });

describe('normalizeImageContent', () => {
  it('returns strings and text-only content untouched', async () => {
    const content: ModelContent[] = [{ type: 'text', text: 'hi' }];
    expect(await normalizeImageContent('hi', { policy: policy(), vision })).toBe('hi');
    expect(await normalizeImageContent(content, { policy: policy(), vision })).toBe(content);
  });

  it('adds metadata to inline images when there is no store', async () => {
    const result = await normalizeImageContent(
      [
        { type: 'text', text: 'look' },
        {
          type: 'image_url',
          image_url: { url: ONE_PIXEL_PNG_DATA_URL, detail: 'low', alt: 'dot' },
        },
      ],
      { policy: policy(), vision },
    );

    expect(result).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'image_url',
        image_url: {
          url: ONE_PIXEL_PNG_DATA_URL,
          detail: 'low',
          alt: 'dot',
          mediaType: 'image/png',
          width: 1,
          height: 1,
          byteLength: 70,
        },
      },
    ]);
  });

  it('moves inline images into the store and keeps only the reference', async () => {
    const store = new InMemoryImageStore();
    const [part] = (await normalizeImageContent(
      [{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL, alt: 'dot' } }],
      { policy: policy({ store }), vision },
    )) as ModelImageContent[];

    expect(part).toEqual({
      type: 'image_url',
      image_url: {
        url: expect.stringMatching(/^blade-image:sha256:[0-9a-f]{64}$/),
        alt: 'dot',
        mediaType: 'image/png',
        width: 1,
        height: 1,
        byteLength: 70,
      },
    });
    expect(await store.get(part?.image_url.url ?? '')).toMatchObject({ mediaType: 'image/png' });
  });

  it.each([
    ['svg data', `data:image/svg+xml;base64,${btoa('<svg/>')}`, 'media_type'],
    ['a non-base64 data URL', 'data:image/png,not-base64', 'media_type'],
    ['an uppercase non-base64 data URL', 'DATA:image/png,not-base64', 'media_type'],
    ['an unknown scheme', 'lark-image:img_v3_abc', 'unresolvable'],
    ['a store reference without a store', `blade-image:sha256:${'e'.repeat(64)}`, 'unresolvable'],
  ])('rejects %s', async (_name, url, reason) => {
    await expect(
      normalizeImageContent([{ type: 'text', text: 'x' }, image(url)], {
        policy: policy(),
        vision,
      }),
    ).rejects.toMatchObject({ index: 1, reason });
  });

  it('rejects images over the byte limit before decoding them', async () => {
    const url = dataUrl('image/png', pngBytes(10, 10, 2048));
    await expect(
      normalizeImageContent([image(url)], { policy: policy({ maxImageBytes: 1024 }), vision }),
    ).rejects.toMatchObject({ index: 0, reason: 'too_large' });
  });

  it('rejects too many images, and remote URLs when they are not allowed', async () => {
    const three = [
      image(ONE_PIXEL_PNG_DATA_URL),
      image(ONE_PIXEL_PNG_DATA_URL),
      image(ONE_PIXEL_PNG_DATA_URL),
    ];
    await expect(
      normalizeImageContent(three, { policy: policy({ maxImagesPerInput: 2 }), vision }),
    ).rejects.toMatchObject({ index: 2, reason: 'too_many' });

    const remote = [image('https://example.test/a.png')];
    await expect(
      normalizeImageContent(remote, { policy: policy({ remoteUrls: false }), vision }),
    ).rejects.toMatchObject({ index: 0, reason: 'remote_url' });
    expect(await normalizeImageContent(remote, { policy: policy(), vision })).toEqual(remote);
  });

  it('rejects or keeps images for a model without vision according to the policy', async () => {
    const content = [image(ONE_PIXEL_PNG_DATA_URL)];
    await expect(
      normalizeImageContent(content, { policy: policy(), vision: blind }),
    ).rejects.toMatchObject({ index: 0, reason: 'unsupported_model' });
    expect(
      await normalizeImageContent(content, {
        policy: policy({ whenUnsupported: 'omit' }),
        vision: blind,
      }),
    ).toMatchObject([{ image_url: { mediaType: 'image/png' } }]);
  });

  it.each([
    [{ url: `data:image/jpeg;base64,${ONE_PIXEL_PNG_BASE64}` }, 'image/png'],
    [{ url: ONE_PIXEL_PNG_DATA_URL, mediaType: 'image/jpeg' }, 'image/png'],
    [
      { url: `data:image/jpg;base64,${ONE_PIXEL_JPEG_BASE64}`, mediaType: 'image/jpg' },
      'image/jpeg',
    ],
  ])('uses the real type for a declared mismatch or alias: %j', async (ref, mediaType) => {
    await expect(
      normalizeImageContent([{ type: 'image_url', image_url: ref }], { policy: policy(), vision }),
    ).resolves.toMatchObject([{ image_url: { mediaType, width: 1, height: 1 } }]);
  });
  it('still refuses sniffed types outside the model mediaTypes', async () => {
    await expect(
      normalizeImageContent([image(ONE_PIXEL_PNG_DATA_URL)], {
        policy: policy({ mediaTypes: ['image/jpeg'] }),
        vision,
      }),
    ).rejects.toMatchObject({ reason: 'media_type' });
  });
});
