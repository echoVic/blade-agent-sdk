import { describe, expect, it, vi } from 'vitest';
import type { HookRuntime } from '../../hooks/HookRuntime.js';
import { HookProcessContainmentError } from '../../hooks/WindowsProcessJob.js';
import { DurableExecutionLeaseError } from '../../session/events/DurableExecutionLeaseStore.js';
import { SessionId } from '../../types/branded.js';
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

  it('preserves the fail-safe stop fallback for ordinary Hook errors', async () => {
    const stopCheck = createStopCheck(vi.fn(async () => {
      throw new Error('hook failed');
    }));

    await expect(
      stopCheck({ content: 'done', turn: 1 }),
    ).resolves.toEqual({ shouldStop: true });
  });
});
