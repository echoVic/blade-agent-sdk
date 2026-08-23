import { describe, expect, it, vi } from 'vitest';
import { CompactionService } from '../../context/CompactionService.js';
import type { HookRuntime } from '../../hooks/HookRuntime.js';
import { HookProcessContainmentError } from '../../hooks/WindowsProcessJob.js';
import { DurableExecutionLeaseError } from '../../session/events/DurableExecutionLeaseStore.js';
import { InputId, RequestId, SessionId } from '../../types/branded.js';
import { buildLoopConfig } from '../LoopHookBuilder.js';

function createStopCheck(
  executeStopCheck: HookRuntime['executeStopCheck'],
  signal?: AbortSignal,
) {
  const config = buildLoopConfig({
    context: {
      messages: [],
      userId: 'test-user',
      sessionId: SessionId('loop-hook-builder-test'),
      signal,
    },
    options: { signal },
    loopState: { conversationState: {} } as never,
    maxTurns: 1,
    isYoloMode: false,
    getLastUuid: () => null,
    setLastUuid: () => {},
    executionPipeline: {} as never,
    logger: {} as never,
    hookRuntime: { executeStopCheck } as HookRuntime,
    modelManager: {} as never,
    runtimePatchManager: {} as never,
  });
  const stopCheck = config.hooks?.stop?.check;
  if (!stopCheck) {
    throw new Error('Stop check was not configured');
  }
  return stopCheck;
}

describe('LoopHookBuilder stop hook', () => {
  it('propagates request cancellation from a running Stop hook', async () => {
    const controller = new AbortController();
    const cancellation = new Error('request cancelled');
    const stopCheck = createStopCheck(vi.fn(async () => {
      controller.abort(cancellation);
      controller.signal.throwIfAborted();
      return { shouldStop: true };
    }), controller.signal);

    await expect(
      stopCheck({ content: 'done', turn: 1 }),
    ).rejects.toBe(cancellation);
  });

  it('propagates execution lease failures from a Stop hook', async () => {
    const leaseError = new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      'worker is stale',
    );
    const stopCheck = createStopCheck(vi.fn(async () => {
      throw leaseError;
    }));

    await expect(
      stopCheck({ content: 'done', turn: 1 }),
    ).rejects.toBe(leaseError);
  });

  it('propagates process-containment failures from a Stop hook', async () => {
    const containmentError = new HookProcessContainmentError(
      'Windows Job Object support is unavailable',
    );
    const stopCheck = createStopCheck(vi.fn(async () => {
      throw containmentError;
    }));

    await expect(
      stopCheck({ content: 'done', turn: 1 }),
    ).rejects.toBe(containmentError);
  });

  it('preserves a containment failure when Stop hook cancellation races cleanup', async () => {
    const controller = new AbortController();
    const containmentError = new HookProcessContainmentError(
      'Hook process cleanup failed',
    );
    const stopCheck = createStopCheck(vi.fn(async () => {
      controller.abort(new Error('request cancelled'));
      throw containmentError;
    }), controller.signal);

    await expect(
      stopCheck({ content: 'done', turn: 1 }),
    ).rejects.toBe(containmentError);
  });

  it('preserves the fail-safe stop fallback for ordinary Hook errors', async () => {
    const stopCheck = createStopCheck(vi.fn(async () => {
      throw new Error('hook failed');
    }));

    await expect(
      stopCheck({ content: 'done', turn: 1 }),
    ).resolves.toEqual({ shouldStop: true });
  });
});

describe('LoopHookBuilder request signal', () => {
  it('uses the explicit request signal for steering input hooks and persistence', async () => {
    const contextController = new AbortController();
    const requestController = new AbortController();
    contextController.abort(new Error('stale context signal'));
    const applyUserPromptSubmit = vi.fn<HookRuntime['applyUserPromptSubmit']>(async (
      content,
      options = {},
    ) => {
      options.abortSignal?.throwIfAborted();
      return content;
    });
    const getContextManager = vi.fn(() => undefined);
    const config = buildLoopConfig({
      context: {
        messages: [],
        userId: 'test-user',
        sessionId: SessionId('loop-hook-builder-input-signal'),
        signal: contextController.signal,
      },
      options: { signal: requestController.signal },
      loopState: { conversationState: {} } as never,
      maxTurns: 1,
      isYoloMode: false,
      getLastUuid: () => null,
      setLastUuid: () => {},
      executionPipeline: {} as never,
      logger: { warn: vi.fn() } as never,
      hookRuntime: { applyUserPromptSubmit } as unknown as HookRuntime,
      modelManager: { getContextManager } as never,
      runtimePatchManager: {} as never,
      runControl: {
        requestId: RequestId('request-input-signal'),
      } as never,
    });
    const applyInput = config.hooks?.input?.apply;
    if (!applyInput) {
      throw new Error('Input hook was not configured');
    }

    await expect(applyInput({
      input: {
        inputId: InputId('steering-input'),
        content: 'Apply this input',
        priority: 'next',
        acceptedAt: 1,
      },
      turn: 1,
    })).resolves.toMatchObject({
      role: 'user',
      content: 'Apply this input',
    });

    expect(applyUserPromptSubmit).toHaveBeenCalledWith(
      'Apply this input',
      { abortSignal: requestController.signal },
    );
    expect(getContextManager).toHaveBeenCalledOnce();
  });

  it('uses the explicit request signal for every compaction path', async () => {
    const contextController = new AbortController();
    const requestController = new AbortController();
    contextController.abort(new Error('stale context signal'));
    const observedSignals: Array<AbortSignal | undefined> = [];
    const checkAndCompactInLoop = vi.fn(async function* (
      _conversationState,
      runtimeContext: { signal?: AbortSignal },
    ) {
      observedSignals.push(runtimeContext.signal);
      yield* [] as never[];
      return false;
    });
    const reactiveCompact = vi.fn(async function* (
      _conversationState,
      runtimeContext: { signal?: AbortSignal },
    ) {
      observedSignals.push(runtimeContext.signal);
      yield* [] as never[];
      return false;
    });
    const compact = vi.spyOn(CompactionService, 'compact').mockImplementation(
      async (_messages, options) => {
        observedSignals.push(options.signal);
        return {
          success: true,
          summary: 'summary',
          preTokens: 10,
          postTokens: 5,
          filesIncluded: [],
          compactedMessages: [],
          boundaryMessage: { role: 'system', content: '' },
          summaryMessage: { role: 'user', content: 'summary' },
        };
      },
    );
    const config = buildLoopConfig({
      context: {
        messages: [],
        userId: 'test-user',
        sessionId: SessionId('loop-hook-builder-compaction-signal'),
        signal: contextController.signal,
      },
      options: { signal: requestController.signal },
      loopState: {
        conversationState: {
          getContextMessages: () => [],
        },
        getChatService: () => ({
          getConfig: () => ({
            model: 'test-model',
            maxContextTokens: 128000,
          }),
        }),
      } as never,
      maxTurns: 1,
      isYoloMode: false,
      getLastUuid: () => null,
      setLastUuid: () => {},
      executionPipeline: {} as never,
      logger: { error: vi.fn(), warn: vi.fn() } as never,
      compactionHandler: {
        checkAndCompactInLoop,
        reactiveCompact,
      } as never,
      modelManager: {
        getContextManager: () => undefined,
      } as never,
      runtimePatchManager: {} as never,
    });
    const beforeTurn = config.hooks?.turn?.beforeTurn;
    const turnLimitCompact = config.hooks?.turn?.onTurnLimitCompact;
    const recover = config.hooks?.recovery?.reactiveCompact;
    if (!beforeTurn || !turnLimitCompact || !recover) {
      throw new Error('Compaction hooks were not configured');
    }

    await beforeTurn({
      turn: 1,
      messages: [],
      lastPromptTokens: 100,
    }).next();
    await turnLimitCompact({ contextMessages: [] });
    await recover({ messages: [] }).next();

    expect(observedSignals).toEqual([
      requestController.signal,
      requestController.signal,
      requestController.signal,
    ]);
    compact.mockRestore();
  });
});
