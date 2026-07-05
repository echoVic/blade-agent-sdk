import { describe, expect, it, vi } from 'vitest';
import { completeSessionStreamResult } from '../../packages/agent-sdk/src/session/streamCompletion.js';
import type { TokenUsage } from '../../packages/agent-sdk/src/types/common.js';

const usage: TokenUsage = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  maxContextTokens: 128000,
};

function createHarness() {
  return {
    hookRuntime: {
      runTaskCompleted: vi.fn(),
    },
    traceFinalizer: {
      finish: vi.fn(),
    },
  };
}

describe('agent-sdk session stream completion', () => {
  it('rejects a stream that ended without a loop result', async () => {
    const harness = createHarness();

    await expect(
      completeSessionStreamResult({
        sessionId: 'session-1',
        message: 'Hello',
        loopResult: undefined,
        usage,
        hookRuntime: harness.hookRuntime,
        traceFinalizer: harness.traceFinalizer,
      }),
    ).rejects.toThrow('Stream ended without result');

    expect(harness.hookRuntime.runTaskCompleted).not.toHaveBeenCalled();
    expect(harness.traceFinalizer.finish).not.toHaveBeenCalled();
  });

  it('returns an error stream message and finalizes an error trace for non-abort failures', async () => {
    const harness = createHarness();

    const messages = await completeSessionStreamResult({
      sessionId: 'session-1',
      message: 'Hello',
      loopResult: {
        success: false,
        error: { type: 'api_error', message: 'model failed' },
      },
      usage,
      hookRuntime: harness.hookRuntime,
      traceFinalizer: harness.traceFinalizer,
    });

    expect(messages).toEqual([{ type: 'error', message: 'model failed', sessionId: 'session-1' }]);
    expect(harness.hookRuntime.runTaskCompleted).not.toHaveBeenCalled();
    expect(harness.traceFinalizer.finish).toHaveBeenCalledWith('error', { error: 'model failed' });
  });

  it('reports task completion, usage, result, and success trace data', async () => {
    const harness = createHarness();

    const messages = await completeSessionStreamResult({
      sessionId: 'session-1',
      message: [
        { type: 'text', text: 'Describe' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ],
      loopResult: {
        success: true,
        finalMessage: 'Done',
        metadata: {
          turnsCount: 2,
          toolCallsCount: 3,
          duration: 456,
        },
      },
      usage,
      hookRuntime: harness.hookRuntime,
      traceFinalizer: harness.traceFinalizer,
    });

    expect(messages).toEqual([
      { type: 'usage', usage, sessionId: 'session-1' },
      { type: 'result', subtype: 'success', content: 'Done', sessionId: 'session-1' },
    ]);
    expect(harness.hookRuntime.runTaskCompleted).toHaveBeenCalledWith({
      taskId: 'session-1',
      taskDescription: 'Describe',
      hasImages: true,
      imageCount: 1,
      resultSummary: 'Done',
      success: true,
    });
    expect(harness.traceFinalizer.finish).toHaveBeenCalledWith('success', {
      content: 'Done',
      usage,
      turnsCount: 2,
      toolCallsCount: 3,
      duration: 456,
    });
  });

  it('treats aborted loop results as completed stream output with an aborted trace', async () => {
    const harness = createHarness();

    const messages = await completeSessionStreamResult({
      sessionId: 'session-1',
      message: 'Stop',
      loopResult: {
        success: false,
        finalMessage: '',
        error: { type: 'aborted', message: 'user aborted' },
        metadata: {
          turnsCount: 1,
          toolCallsCount: 0,
          duration: 12,
        },
      },
      usage,
      hookRuntime: harness.hookRuntime,
      traceFinalizer: harness.traceFinalizer,
    });

    expect(messages).toEqual([
      { type: 'usage', usage, sessionId: 'session-1' },
      { type: 'result', subtype: 'success', content: '', sessionId: 'session-1' },
    ]);
    expect(harness.hookRuntime.runTaskCompleted).toHaveBeenCalledWith({
      taskId: 'session-1',
      taskDescription: 'Stop',
      hasImages: false,
      imageCount: 0,
      resultSummary: '',
      success: false,
    });
    expect(harness.traceFinalizer.finish).toHaveBeenCalledWith('aborted', {
      content: '',
      usage,
      turnsCount: 1,
      toolCallsCount: 0,
      duration: 12,
    });
  });
});
