import { describe, expect, it } from 'vitest';
import { ONE_PIXEL_PNG_BASE64, ONE_PIXEL_PNG_DATA_URL } from '../../images/__tests__/fixtures.js';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import { prepareModelRequest } from '../modelAdapter.js';

describe('prepareModelRequest images', () => {
  it('maps image detail to the OpenAI provider option and keeps the media type', () => {
    const prepared = prepareModelRequest(
      { provider: 'openai', model: 'gpt-5', apiKey: 'test-key', baseUrl: '' },
      NOOP_LOGGER,
      [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL, detail: 'low' } },
            {
              type: 'image_url',
              image_url: { url: 'https://example.test/a.webp', mediaType: 'image/webp' },
            },
          ],
        },
      ],
    );

    expect(prepared.coreMessages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'image',
          image: ONE_PIXEL_PNG_BASE64,
          mediaType: 'image/png',
          providerOptions: { openai: { imageDetail: 'low' } },
        },
        { type: 'image', image: 'https://example.test/a.webp', mediaType: 'image/webp' },
      ],
    });
  });

  it('uses the canonical ref media type for a case-insensitive data URL', () => {
    const prepared = prepareModelRequest(
      { provider: 'openai', model: 'gpt-5', apiKey: 'test-key', baseUrl: '' },
      NOOP_LOGGER,
      [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `DATA:image/jpg;base64,${ONE_PIXEL_PNG_BASE64}`,
                mediaType: 'image/png',
              },
            },
          ],
        },
      ],
    );

    expect(prepared.coreMessages[0]).toEqual({
      role: 'user',
      content: [{ type: 'image', image: ONE_PIXEL_PNG_BASE64, mediaType: 'image/png' }],
    });
  });
});
