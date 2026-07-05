import type { AgentStreamEvent } from '@blade-ai/agent';
import { describe, expect, it, vi } from 'vitest';
import type { TraceRecorder } from '../../packages/agent-sdk/src/observability/TraceRecorder.js';
import { streamPackageLocalAgentKernelTurn } from '../../packages/agent-sdk/src/session/runtimeKernelTurnStream.js';

describe('agent-sdk package-local kernel turn stream helper', () => {
  it('projects kernel events and finalizes successful traces with retained usage', async () => {
    const usage = {
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
    };
    const events: AgentStreamEvent[] = [
      { type: 'content', delta: 'hello' },
      { type: 'usage', usage },
      { type: 'result', content: 'hello' },
    ];
    const trace = { id: 'trace-1' };
    const traceRecorder = {
      finish: vi.fn(() => trace),
    } as unknown as TraceRecorder;
    const traceManager = {
      remember: vi.fn(),
      notifySink: vi.fn(async () => undefined),
    };
    const hookRuntime = {
      enable: vi.fn(),
      setTraceCollector: vi.fn(),
    };

    const messages = [];
    for await (const message of streamPackageLocalAgentKernelTurn({
      sessionId: 'session-1',
      streamOptions: {
        input: 'hi',
      },
      kernel: {
        async *runTurn() {
          yield* events;
        },
      },
      traceRecorder,
      traceManager,
      hookRuntime,
      maxContextTokens: 99,
    })) {
      messages.push(message);
    }

    expect(messages).toEqual([
      { type: 'turn_start', turn: 1, sessionId: 'session-1' },
      { type: 'content', delta: 'hello', sessionId: 'session-1' },
      {
        type: 'usage',
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          totalTokens: 8,
          maxContextTokens: 99,
        },
        sessionId: 'session-1',
      },
      { type: 'turn_end', turn: 1, sessionId: 'session-1' },
      {
        type: 'result',
        subtype: 'success',
        content: 'hello',
        sessionId: 'session-1',
      },
    ]);
    expect(traceRecorder.finish).toHaveBeenCalledWith('success', {
      content: 'hello',
      usage,
    });
    expect(traceManager.remember).toHaveBeenCalledWith(trace);
    expect(traceManager.notifySink).toHaveBeenCalledWith(trace);
    expect(hookRuntime.setTraceCollector).toHaveBeenNthCalledWith(1, traceRecorder);
    expect(hookRuntime.setTraceCollector).toHaveBeenLastCalledWith(undefined);
  });

  it('finalizes thrown stream errors and rethrows them', async () => {
    const error = new Error('stream failed');
    const trace = { id: 'trace-2' };
    const traceRecorder = {
      finish: vi.fn(() => trace),
    } as unknown as TraceRecorder;

    const stream = streamPackageLocalAgentKernelTurn({
      sessionId: 'session-1',
      streamOptions: {
        input: 'hi',
        turnId: 'turn-1',
      },
      kernel: {
        async *runTurn(turn) {
          expect(turn).toEqual({
            input: 'hi',
            turnId: 'turn-1',
            signal: undefined,
          });
          yield { type: 'content', delta: 'before failure' };
          throw error;
        },
      },
      traceRecorder,
      traceManager: {
        remember: vi.fn(),
        notifySink: vi.fn(async () => undefined),
      },
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn(),
      },
      maxContextTokens: 99,
    });

    await expect(async () => {
      for await (const _message of stream) {
        // drain
      }
    }).rejects.toThrow(error);
    expect(traceRecorder.finish).toHaveBeenCalledWith('error', {
      error: 'stream failed',
    });
  });
});
