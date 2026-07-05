import { describe, expect, it, vi } from 'vitest';
import type { HookTraceCollector } from '../../packages/agent-sdk/src/observability/types.js';
import { applySessionPromptSubmit } from '../../packages/agent-sdk/src/session/promptSubmit.js';

describe('agent-sdk session prompt submit', () => {
  it('sets the trace collector before applying prompt-submit hooks', async () => {
    const traceCollector: HookTraceCollector = {
      recordHookStart: vi.fn(),
      recordHookEnd: vi.fn(),
      recordHookError: vi.fn(),
    };
    const abortSignal = new AbortController().signal;
    const hookRuntime = {
      setTraceCollector: vi.fn(),
      applyUserPromptSubmit: vi.fn(async () => 'rewritten'),
    };
    const traceFinalizer = {
      finish: vi.fn(),
    };

    const result = await applySessionPromptSubmit({
      sessionId: 'session-1',
      message: 'original',
      abortSignal,
      traceCollector,
      hookRuntime,
      traceFinalizer,
    });

    expect(result).toEqual({ ok: true, message: 'rewritten' });
    expect(hookRuntime.setTraceCollector).toHaveBeenCalledWith(traceCollector);
    expect(hookRuntime.applyUserPromptSubmit).toHaveBeenCalledWith('original', { abortSignal });
    expect(traceFinalizer.finish).not.toHaveBeenCalled();
  });

  it('finalizes the trace and returns an error stream message when prompt-submit hooks fail', async () => {
    const hookRuntime = {
      setTraceCollector: vi.fn(),
      applyUserPromptSubmit: vi.fn(async () => {
        throw new Error('hook failed');
      }),
    };
    const traceFinalizer = {
      finish: vi.fn(),
    };

    const result = await applySessionPromptSubmit({
      sessionId: 'session-1',
      message: 'original',
      abortSignal: new AbortController().signal,
      traceCollector: undefined,
      hookRuntime,
      traceFinalizer,
    });

    expect(result).toEqual({
      ok: false,
      messages: [{ type: 'error', message: 'hook failed', sessionId: 'session-1' }],
    });
    expect(traceFinalizer.finish).toHaveBeenCalledWith('error', { error: 'hook failed' });
    expect(hookRuntime.setTraceCollector).toHaveBeenNthCalledWith(1, undefined);
    expect(hookRuntime.setTraceCollector).toHaveBeenNthCalledWith(2, undefined);
  });
});
