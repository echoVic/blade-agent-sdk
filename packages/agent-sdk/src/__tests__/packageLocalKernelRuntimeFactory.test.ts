import { describe, expect, it, vi } from 'vitest';
import { SessionId } from '../local/branded.js';
import type { KernelStreamBridgeRuntime } from '../session/kernelStreamBridge.js';
import { createPackageLocalKernelSessionRuntimeFactory } from '../session/packageLocalKernelRuntimeFactory.js';
import type { PackageLocalSessionRuntimeContext } from '../session/packageLocalRuntimeFactory.js';
import { PackageLocalSession } from '../session/sessionInstance.js';
import type { SessionOptions, StreamMessage } from '../session/types.js';

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
  maxTurns: 7,
};

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

function createRuntime(contexts: PackageLocalSessionRuntimeContext[]) {
  return (context: PackageLocalSessionRuntimeContext): KernelStreamBridgeRuntime => {
    contexts.push(context);
    return {
      prepareTurn: vi.fn(),
      streamAgentKernelTurn: vi.fn(async function* (
        streamOptions,
      ): AsyncGenerator<StreamMessage> {
        expect(streamOptions.input).toBe('hello');
        expect(streamOptions.turnId).toBe(`turn:${context.sessionId}`);
        expect(streamOptions.maxSteps).toBe(4);
        yield {
          type: 'content',
          delta: `session:${context.sessionId}`,
          sessionId: context.sessionId,
        };
        yield {
          type: 'result',
          subtype: 'success',
          content: 'done',
          sessionId: context.sessionId,
        };
      }),
    };
  };
}

describe('agent-sdk package-local kernel runtime factory', () => {
  it('creates package-local sessions wired to kernel stream runtimes', async () => {
    const contexts: PackageLocalSessionRuntimeContext[] = [];
    const cleanup = vi.fn();
    const factory = createPackageLocalKernelSessionRuntimeFactory({
      createSessionId: () => SessionId('session-created'),
      createTurnId: () => 'turn:session-created',
      createRuntime: createRuntime(contexts),
      cleanup,
    });

    const session = await factory.create(options);

    expect(session).toBeInstanceOf(PackageLocalSession);
    expect(session.sessionId).toBe('session-created');
    await session.send('hello', { maxTurns: 4 });
    await expect(collect(session.stream())).resolves.toEqual([
      { type: 'content', delta: 'session:session-created', sessionId: SessionId('session-created') },
      { type: 'result', subtype: 'success', content: 'done', sessionId: SessionId('session-created') },
    ]);
    await session.close();

    expect(contexts).toEqual([
      {
        sessionId: SessionId('session-created'),
        options,
        isResume: false,
      },
    ]);
    expect(cleanup).toHaveBeenCalledWith(contexts[0]);
  });

  it('resumes package-local sessions with resume context for runtime construction', async () => {
    const contexts: PackageLocalSessionRuntimeContext[] = [];
    const factory = createPackageLocalKernelSessionRuntimeFactory({
      createSessionId: () => {
        throw new Error('createSessionId should not run for resume');
      },
      createTurnId: () => 'turn:session-resumed',
      createRuntime: createRuntime(contexts),
    });

    const session = await factory.resume({ ...options, sessionId: SessionId('session-resumed') });

    expect(session).toBeInstanceOf(PackageLocalSession);
    expect(session.sessionId).toBe('session-resumed');
    await session.send('hello', { maxTurns: 4 });
    await expect(collect(session.stream())).resolves.toMatchObject([
      { type: 'content', delta: 'session:session-resumed', sessionId: SessionId('session-resumed') },
      { type: 'result', content: 'done', sessionId: SessionId('session-resumed') },
    ]);
    expect(contexts).toEqual([
      {
        sessionId: SessionId('session-resumed'),
        options,
        isResume: true,
      },
    ]);
  });
});
