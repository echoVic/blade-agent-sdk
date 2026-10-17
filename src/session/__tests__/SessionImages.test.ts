import { describe, expect, it, vi } from 'vitest';
import { SessionInputError } from '../../errors/SessionInputError.js';
import { ONE_PIXEL_PNG_DATA_URL } from '../../images/__tests__/fixtures.js';
import type { ImageStore } from '../../images/ImageStore.js';
import { InMemoryImageStore } from '../../images/InMemoryImageStore.js';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelContent, ModelMessage } from '../../model/message.js';
import type { ModelService } from '../../model/service.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';
import { createSession } from '../Session.js';
import { SessionLifecycle } from '../SessionLifecycle.js';
import type { ISession, SessionOptions } from '../types.js';

function captureRegistry(
  requests: ModelMessage[][],
  onStreamStarted?: () => void,
  rejectFirstImage = false,
): ProviderRegistry {
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
          async *streamChat(messages, _tools, signal) {
            requests.push([...messages]);
            if (rejectFirstImage && requests.length === 1)
              throw new Error('The model does not support image input');
            if (onStreamStarted) {
              onStreamStarted();
              await new Promise<void>((resolve) => {
                if (signal?.aborted) resolve();
                else signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              return;
            }
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

function gatedImageStore() {
  const backing = new InMemoryImageStore();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const store: ImageStore = {
    handles: (url) => backing.handles(url),
    get: (url) => backing.get(url),
    async put(image, signal) {
      entered.resolve();
      await gate.promise;
      return backing.put(image, signal);
    },
  };
  return { store, entered: entered.promise, release: gate.resolve };
}

describe('Session images', () => {
  it('preserves send order when an image is followed by text on a warm Session', async () => {
    const requests: ModelMessage[][] = [];
    const gated = gatedImageStore();
    const session = await createSession(
      sessionOptions(requests, { images: { store: gated.store } }),
    );
    const sends: Promise<unknown>[] = [];

    try {
      await session.send('warmup');
      await drain(session);

      const first = session.send([
        { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
      ]);
      const second = session.send('B');
      sends.push(first, second);
      let secondSettled = false;
      void second.then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        },
      );
      await gated.entered;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(secondSettled).toBe(false);
      gated.release();

      expect((await first).status).toBe('started');
      expect((await second).status).toBe('steered');
      await drain(session);

      const userMessages = session.messages.filter((message) => message.role === 'user');
      expect(userMessages[0]?.content).toBe('warmup');
      expect(userMessages.slice(1).map((message) => message.content)).toEqual([
        [
          {
            type: 'image_url',
            image_url: {
              url: expect.stringMatching(/^blade-image:sha256:[0-9a-f]{64}$/),
              mediaType: 'image/png',
              width: 1,
              height: 1,
              byteLength: 70,
            },
          },
        ],
        'B',
      ]);
    } finally {
      gated.release();
      await Promise.allSettled(sends);
      await session.close();
    }
  });

  it('aborts a running request while image admission is blocked in the store', async () => {
    const requests: ModelMessage[][] = [];
    const gated = gatedImageStore();
    const started = Promise.withResolvers<void>();
    const session = await createSession(
      sessionOptions(requests, {
        images: { store: gated.store },
        providerRegistry: captureRegistry(requests, started.resolve),
      }),
    );
    let draining: Promise<void> | undefined;
    let pending: Promise<unknown> | undefined;
    let aborting: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await session.send('running');
      draining = drain(session);
      await started.promise;
      pending = session
        .send([{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } }])
        .then(
          () => 'settled',
          () => 'settled',
        );
      await gated.entered;

      aborting = session.abort();
      const winner = await Promise.race([
        aborting.then(() => 'aborted'),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), 1000);
        }),
      ]);
      expect(winner).toBe('aborted');
      gated.release();
      expect(await pending).toBe('settled');
    } finally {
      clearTimeout(timer);
      gated.release();
      await pending;
      await aborting;
      await session.close();
      await draining;
    }
  });

  it('rejects queued image admission with the closed Session error after close', async () => {
    const requests: ModelMessage[][] = [];
    const gated = gatedImageStore();
    const session = await createSession(
      sessionOptions(requests, { images: { store: gated.store } }),
    );
    const sends: Promise<unknown>[] = [];

    try {
      const first = session.send([
        { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
      ]);
      sends.push(first);
      await gated.entered;
      const second = session.send([
        { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
      ]);
      sends.push(second);
      const settled = Promise.allSettled(sends);
      await new Promise((resolve) => setImmediate(resolve));

      await session.close();
      await expect(session.send('closed')).rejects.toThrow(new Error('Session is closed'));
      gated.release();
      await expect(second).rejects.toThrow(new Error('Session is closed'));
      await settled;
    } finally {
      gated.release();
      await Promise.allSettled(sends);
      await session.close();
    }
  });

  it('admits later sends after an image normalization rejection', async () => {
    const requests: ModelMessage[][] = [];
    const session = await createSession(
      sessionOptions(requests, { images: { remoteUrls: false } }),
    );
    try {
      const rejected = session.send([
        { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
      ]);
      const next = session.send('B');
      await expect(rejected).rejects.toMatchObject({
        code: 'SESSION_INPUT_IMAGE_REJECTED',
        details: { index: 0, reason: 'remote_url' },
      });
      expect((await next).status).toBe('started');
      await drain(session);
      expect(
        session.messages
          .filter((message) => message.role === 'user')
          .map((message) => message.content),
      ).toEqual(['B']);
    } finally {
      await session.close();
    }
  });

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

  it('sends the stored image to the model as data while the transcript keeps the reference', async () => {
    const requests: ModelMessage[][] = [];
    const session = await createSession(
      sessionOptions(requests, { images: { store: new InMemoryImageStore() } }),
    );

    await session.send([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
    ]);
    await drain(session);

    expect(imagePart(session.messages.find((message) => message.role === 'user'))).toMatchObject({
      image_url: { url: expect.stringMatching(/^blade-image:sha256:/) },
    });
    const sent = imagePart(requests.at(-1)?.findLast((message) => message.role === 'user'));
    expect(sent).toEqual({
      type: 'image_url',
      image_url: {
        url: ONE_PIXEL_PNG_DATA_URL,
        mediaType: 'image/png',
        width: 1,
        height: 1,
        byteLength: 70,
      },
    });

    await session.close();
  });

  it('sends a placeholder when the model cannot see images and the policy keeps them', async () => {
    const requests: ModelMessage[][] = [];
    const session = await createSession(
      sessionOptions(requests, { vision: { images: false }, images: { whenUnsupported: 'omit' } }),
    );

    await session.send([
      { type: 'text', text: 'here' },
      { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL, alt: 'dot' } },
    ]);
    await drain(session);

    expect(requests.at(-1)?.findLast((message) => message.role === 'user')?.content).toEqual([
      { type: 'text', text: 'here' },
      {
        type: 'text',
        text: '[image omitted: the current model does not accept images — image/png 1×1 — dot]',
      },
    ]);
    expect(imagePart(session.messages.find((message) => message.role === 'user'))).toMatchObject({
      type: 'image_url',
    });

    await session.close();
  });

  it('downgrades the Session after provider rejection and refuses later image admission', async () => {
    const requests: ModelMessage[][] = [];
    const session = await createSession(
      sessionOptions(requests, { providerRegistry: captureRegistry(requests, undefined, true) }),
    );
    try {
      await session.send([{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } }]);
      await drain(session);
      expect(requests).toHaveLength(2);
      expect(imagePart(requests[0]?.findLast((message) => message.role === 'user'))).toBeDefined();
      expect(requests[1]?.findLast((message) => message.role === 'user')?.content).toEqual([
        {
          type: 'text',
          text: '[image omitted: the current model does not accept images — image/png 1×1]',
        },
      ]);
      await expect(
        session.send([{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } }]),
      ).rejects.toMatchObject({
        code: 'SESSION_INPUT_IMAGE_REJECTED',
        details: { index: 0, reason: 'unsupported_model' },
      });
    } finally {
      await session.close();
    }
  });

  it('reports the closed Session error if close wins while ensureInitialized awaits', async () => {
    const session = await createSession(sessionOptions([]));
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const original = SessionLifecycle.prototype.ensureInitialized;
    const ensure = vi
      .spyOn(SessionLifecycle.prototype, 'ensureInitialized')
      .mockImplementationOnce(async function (this: SessionLifecycle) {
        await original.call(this);
        entered.resolve();
        await gate.promise;
      });
    let pending: Promise<unknown> | undefined;
    try {
      pending = session.send([{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } }]);
      const assertion = expect(pending).rejects.toThrow(new Error('Session is closed'));
      await entered.promise;
      await session.close();
      gate.resolve();
      await assertion;
    } finally {
      gate.resolve();
      ensure.mockRestore();
      await Promise.allSettled(pending ? [pending] : []);
      await session.close();
    }
  });
});
