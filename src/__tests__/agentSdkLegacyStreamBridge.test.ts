import { describe, expect, it, vi } from 'vitest';
import { createLegacyStreamTurnBridge } from '../../packages/agent-sdk/src/session/legacyStreamBridge.js';
import type { LegacyStreamAgentEvent } from '../../packages/agent-sdk/src/session/legacyStreamEvents.js';
import type { SessionStreamLoopResult } from '../../packages/agent-sdk/src/session/streamCompletion.js';
import type { ActiveSessionTurn } from '../../packages/agent-sdk/src/session/turn.js';
import type {
  PackageLocalSessionStreamContext,
} from '../../packages/agent-sdk/src/session/sessionInstance.js';
import type { SessionOptions, StreamMessage } from '../../packages/agent-sdk/src/session/types.js';
import type { TokenUsage } from '../../packages/agent-sdk/src/types/common.js';

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

const sessionOptions: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
  maxTurns: 9,
};

const usage: TokenUsage = {
  inputTokens: 5,
  outputTokens: 3,
  totalTokens: 8,
  maxContextTokens: 128000,
};

describe('agent-sdk legacy stream bridge', () => {
  it('adapts package-local turns into the migrated legacy stream runner', async () => {
    const controller = new AbortController();
    const turn: ActiveSessionTurn = {
      message: 'original',
      sendOptions: {
        signal: controller.signal,
        maxTurns: 4,
      },
      snapshot: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        context: {},
        filesystemRoots: [],
        cwd: undefined,
        environment: {},
      },
      signal: controller.signal,
      cleanup: vi.fn(),
    };
    const context: PackageLocalSessionStreamContext = {
      sessionId: 'session-1',
      options: sessionOptions,
    };
    const hookRuntime = {
      setTraceCollector: vi.fn(),
      applyUserPromptSubmit: vi.fn(async () => 'rewritten'),
      runTaskCompleted: vi.fn(),
    };
    const traceFinalizer = {
      finish: vi.fn(),
    };
    const streamAgent = vi.fn(async function* (
      message,
      options,
    ): AsyncGenerator<LegacyStreamAgentEvent, SessionStreamLoopResult> {
      expect(message).toBe('rewritten');
      expect(options).toEqual({
        signal: controller.signal,
        maxTurns: 4,
      });
      yield { type: 'thinking_delta', delta: 'plan' };
      yield { type: 'content_delta', delta: 'done' };
      yield { type: 'token_usage', usage };
      return {
        success: true,
        finalMessage: 'done',
        metadata: {
          turnsCount: 1,
          toolCallsCount: 0,
          duration: 10,
        },
      };
    });
    const prepareTurn = vi.fn();
    const bridge = createLegacyStreamTurnBridge({
      context,
      driver: {
        prepareTurn,
        hookRuntime,
        traceFinalizer,
        streamAgent,
      },
    });

    const messages = await collect(bridge(turn, { includeThinking: true }, context));

    expect(prepareTurn).toHaveBeenCalledWith(turn, context);
    expect(messages).toEqual([
      { type: 'thinking', delta: 'plan', sessionId: 'session-1' },
      { type: 'content', delta: 'done', sessionId: 'session-1' },
      { type: 'usage', usage, sessionId: 'session-1' },
      { type: 'result', subtype: 'success', content: 'done', sessionId: 'session-1' },
    ]);
    expect(hookRuntime.applyUserPromptSubmit).toHaveBeenCalledWith('original', {
      abortSignal: controller.signal,
    });
    expect(traceFinalizer.finish).toHaveBeenCalledWith('success', {
      content: 'done',
      usage,
      turnsCount: 1,
      toolCallsCount: 0,
      duration: 10,
    });
    expect(streamAgent).toHaveBeenCalledTimes(1);
  });
});
