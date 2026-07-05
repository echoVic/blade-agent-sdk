import { describe, expect, it, vi } from 'vitest';
import type { LegacyStreamAgentEvent } from '../../packages/agent-sdk/src/session/legacyStreamEvents.js';
import { runLegacySessionStreamTurn } from '../../packages/agent-sdk/src/session/legacyStreamRunner.js';
import type { SessionStreamLoopResult } from '../../packages/agent-sdk/src/session/streamCompletion.js';
import type { StreamMessage } from '../../packages/agent-sdk/src/session/types.js';
import type { TokenUsage } from '../../packages/agent-sdk/src/types/common.js';

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

function createHarness() {
  return {
    hookRuntime: {
      setTraceCollector: vi.fn(),
      applyUserPromptSubmit: vi.fn(async () => 'rewritten'),
      runTaskCompleted: vi.fn(),
    },
    traceFinalizer: {
      finish: vi.fn(),
    },
  };
}

const usage: TokenUsage = {
  inputTokens: 11,
  outputTokens: 7,
  totalTokens: 18,
  maxContextTokens: 128000,
};

describe('agent-sdk legacy stream runner', () => {
  it('applies prompt hooks, projects stream events, and completes the stream result', async () => {
    const harness = createHarness();
    const abortSignal = new AbortController().signal;
    const streamAgent = vi.fn(
      async function* (
        message,
        options,
      ): AsyncGenerator<LegacyStreamAgentEvent, SessionStreamLoopResult> {
        expect(message).toBe('rewritten');
        expect(options).toEqual({ signal: abortSignal, maxTurns: 3 });
        yield { type: 'turn_start', turn: 1, maxTurns: 3 };
        yield { type: 'content_delta', delta: 'Done' };
        yield { type: 'token_usage', usage };
        return {
          success: true,
          finalMessage: 'Done',
          metadata: {
            turnsCount: 1,
            toolCallsCount: 0,
            duration: 12,
          },
        };
      },
    );

    const messages = await collect(
      runLegacySessionStreamTurn({
        sessionId: 'session-1',
        message: 'original',
        abortSignal,
        maxTurns: 3,
        includeThinking: false,
        traceRecorder: undefined,
        traceCollector: undefined,
        hookRuntime: harness.hookRuntime,
        traceFinalizer: harness.traceFinalizer,
        streamAgent,
      }),
    );

    expect(messages).toEqual([
      { type: 'turn_start', turn: 1, sessionId: 'session-1' },
      { type: 'content', delta: 'Done', sessionId: 'session-1' },
      { type: 'usage', usage, sessionId: 'session-1' },
      { type: 'result', subtype: 'success', content: 'Done', sessionId: 'session-1' },
    ]);
    expect(streamAgent).toHaveBeenCalledTimes(1);
    expect(harness.hookRuntime.applyUserPromptSubmit).toHaveBeenCalledWith('original', {
      abortSignal,
    });
    expect(harness.hookRuntime.runTaskCompleted).toHaveBeenCalledWith({
      taskId: 'session-1',
      taskDescription: 'rewritten',
      hasImages: false,
      imageCount: 0,
      resultSummary: 'Done',
      success: true,
    });
    expect(harness.traceFinalizer.finish).toHaveBeenCalledWith('success', {
      content: 'Done',
      usage,
      turnsCount: 1,
      toolCallsCount: 0,
      duration: 12,
    });
  });

  it('yields prompt-submit errors without starting the legacy stream source', async () => {
    const harness = createHarness();
    harness.hookRuntime.applyUserPromptSubmit.mockRejectedValue(new Error('hook failed'));
    const streamAgent = vi.fn();

    const messages = await collect(
      runLegacySessionStreamTurn({
        sessionId: 'session-1',
        message: 'original',
        abortSignal: new AbortController().signal,
        maxTurns: 3,
        includeThinking: false,
        traceRecorder: undefined,
        traceCollector: undefined,
        hookRuntime: harness.hookRuntime,
        traceFinalizer: harness.traceFinalizer,
        streamAgent,
      }),
    );

    expect(messages).toEqual([{ type: 'error', message: 'hook failed', sessionId: 'session-1' }]);
    expect(streamAgent).not.toHaveBeenCalled();
  });
});
