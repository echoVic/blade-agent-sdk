import { describe, expect, it } from 'vitest';
import { SessionInputError } from '../../errors/SessionInputError.js';
import { ONE_PIXEL_PNG_DATA_URL } from '../../images/__tests__/fixtures.js';
import { InMemoryImageStore } from '../../images/InMemoryImageStore.js';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelContent, ModelMessage } from '../../model/message.js';
import type { ModelService } from '../../model/service.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';
import { createSession } from '../Session.js';
import type { ISession, SessionOptions } from '../types.js';

function captureRegistry(requests: ModelMessage[][]): ProviderRegistry {
  return new ProviderRegistry([
    {
      type: 'image-capture-api',
      create(config: Readonly<ModelServiceConfig>): ModelService {
        let current: ModelServiceConfig = { ...config };
        return {
          async chat(messages) {
            requests.push([...messages]);
            return { content: 'ok' };
          },
          async sideQuery() {
            return { content: 'ok' };
          },
          async *streamChat(messages) {
            requests.push([...messages]);
            yield { content: 'ok' };
            yield { finishReason: 'stop' };
          },
          getConfig: () => current,
          updateConfig(next) {
            current = { ...current, ...next };
          },
        };
      },
    },
  ]);
}

function sessionOptions(
  requests: ModelMessage[][],
  overrides: Partial<SessionOptions> = {},
): SessionOptions {
  return {
    provider: { type: 'image-capture-api', apiKey: 'test-key' },
    providerRegistry: captureRegistry(requests),
    model: 'capture-model',
    persistSession: false,
    allowedTools: [],
    ...overrides,
  };
}

async function drain(session: ISession): Promise<void> {
  for await (const _event of session.stream()) {
    // Drain the request to completion.
  }
}

function imagePart(message: ModelMessage | undefined): ModelContent | undefined {
  return Array.isArray(message?.content)
    ? message.content.find((part) => part.type === 'image_url')
    : undefined;
}

describe('Session images', () => {
  it('stores inline images and keeps only the reference in the transcript', async () => {
    const requests: ModelMessage[][] = [];
    const store = new InMemoryImageStore();
    const session = await createSession(sessionOptions(requests, { images: { store } }));

    await session.send([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
    ]);
    await drain(session);

    const stored = imagePart(session.messages.find((message) => message.role === 'user'));
    expect(stored).toEqual({
      type: 'image_url',
      image_url: {
        url: expect.stringMatching(/^blade-image:sha256:[0-9a-f]{64}$/),
        mediaType: 'image/png',
        width: 1,
        height: 1,
        byteLength: 70,
      },
    });
    expect(JSON.stringify(session.messages)).not.toContain(';base64,');
    if (stored?.type === 'image_url') {
      expect(await store.get(stored.image_url.url)).toMatchObject({ mediaType: 'image/png' });
    }

    await session.close();
  });

  it('rejects images the current model cannot accept', async () => {
    const requests: ModelMessage[][] = [];
    const session = await createSession(sessionOptions(requests, { vision: { images: false } }));

    const sent = session.send([{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } }]);

    await expect(sent).rejects.toBeInstanceOf(SessionInputError);
    await expect(sent).rejects.toMatchObject({
      code: 'SESSION_INPUT_IMAGE_REJECTED',
      details: { index: 0, reason: 'unsupported_model' },
    });
    expect(requests).toEqual([]);

    await session.close();
  });
});
