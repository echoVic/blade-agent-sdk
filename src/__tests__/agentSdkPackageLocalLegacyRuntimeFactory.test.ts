import { describe, expect, it, vi } from 'vitest';
import { createPackageLocalLegacySessionRuntimeFactory } from '../../packages/agent-sdk/src/session/packageLocalLegacyRuntimeFactory.js';
import { PackageLocalSession } from '../../packages/agent-sdk/src/session/sessionInstance.js';
import type { LegacyStreamAgentEvent } from '../../packages/agent-sdk/src/session/legacyStreamEvents.js';
import type { PackageLocalSessionRuntimeContext } from '../../packages/agent-sdk/src/session/packageLocalRuntimeFactory.js';
import type { SessionStreamLoopResult } from '../../packages/agent-sdk/src/session/streamCompletion.js';
import type { SessionOptions, StreamMessage } from '../../packages/agent-sdk/src/session/types.js';
import type { TokenUsage } from '../../packages/agent-sdk/src/types/common.js';

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
  maxTurns: 7,
};

const usage: TokenUsage = {
  inputTokens: 3,
  outputTokens: 2,
  totalTokens: 5,
  maxContextTokens: 128000,
};

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

function createDriver(contexts: PackageLocalSessionRuntimeContext[]) {
  return (context: PackageLocalSessionRuntimeContext) => {
    contexts.push(context);
    return {
      prepareTurn: vi.fn(),
      hookRuntime: {
        setTraceCollector: vi.fn(),
        applyUserPromptSubmit: vi.fn(async () => 'rewritten prompt'),
        runTaskCompleted: vi.fn(),
      },
      traceFinalizer: {
        finish: vi.fn(),
      },
      streamAgent: vi.fn(async function* (
        message,
        runOptions,
      ): AsyncGenerator<LegacyStreamAgentEvent, SessionStreamLoopResult> {
        expect(message).toBe('rewritten prompt');
        expect(runOptions.maxTurns).toBe(4);
        yield { type: 'content_delta', delta: `session:${context.sessionId}` };
        yield { type: 'token_usage', usage };
        return {
          success: true,
          finalMessage: 'done',
          metadata: {
            turnsCount: 1,
            toolCallsCount: 0,
            duration: 9,
          },
        };
      }),
    };
  };
}

describe('agent-sdk package-local legacy runtime factory', () => {
  it('creates package-local sessions wired to legacy stream bridge drivers', async () => {
    const contexts: PackageLocalSessionRuntimeContext[] = [];
    const cleanup = vi.fn();
    const factory = createPackageLocalLegacySessionRuntimeFactory({
      createSessionId: () => 'session-created',
      createTurnId: () => 'turn-created',
      createDriver: createDriver(contexts),
      cleanup,
    });

    const session = await factory.create(options);

    expect(session).toBeInstanceOf(PackageLocalSession);
    expect(session.sessionId).toBe('session-created');
    await session.send('hello', { maxTurns: 4 });
    await expect(collect(session.stream())).resolves.toEqual([
      { type: 'content', delta: 'session:session-created', sessionId: 'session-created' },
      { type: 'usage', usage, sessionId: 'session-created' },
      { type: 'result', subtype: 'success', content: 'done', sessionId: 'session-created' },
    ]);
    await session.close();

    expect(contexts).toEqual([
      {
        sessionId: 'session-created',
        options,
        isResume: false,
      },
    ]);
    expect(cleanup).toHaveBeenCalledWith(contexts[0]);
  });

  it('resumes package-local sessions with resume context for driver construction', async () => {
    const contexts: PackageLocalSessionRuntimeContext[] = [];
    const factory = createPackageLocalLegacySessionRuntimeFactory({
      createSessionId: () => {
        throw new Error('createSessionId should not run for resume');
      },
      createTurnId: () => 'turn-resumed',
      createDriver: createDriver(contexts),
    });

    const session = await factory.resume({ ...options, sessionId: 'session-resumed' });

    expect(session).toBeInstanceOf(PackageLocalSession);
    expect(session.sessionId).toBe('session-resumed');
    await session.send('hello', { maxTurns: 4 });
    await expect(collect(session.stream())).resolves.toMatchObject([
      { type: 'content', delta: 'session:session-resumed', sessionId: 'session-resumed' },
      { type: 'usage', usage, sessionId: 'session-resumed' },
      { type: 'result', content: 'done', sessionId: 'session-resumed' },
    ]);
    expect(contexts).toEqual([
      {
        sessionId: 'session-resumed',
        options,
        isResume: true,
      },
    ]);
  });
});
