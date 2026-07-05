import type { AgentStreamEvent } from '@blade-ai/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  finishPackageLocalKernelTraceError,
  updatePackageLocalKernelTraceFinalization,
  type PackageLocalKernelTraceFinalizationState,
} from '../../packages/agent-sdk/src/session/runtimeKernelTraceFinalization.js';

describe('agent-sdk package-local kernel trace finalization helpers', () => {
  it('stores usage and finalizes success results with the latest usage', async () => {
    const state: PackageLocalKernelTraceFinalizationState = {};
    const finalizer = {
      finish: vi.fn(async () => undefined),
    };
    const usageEvent: AgentStreamEvent = {
      type: 'usage',
      usage: {
        promptTokens: 4,
        completionTokens: 6,
        totalTokens: 10,
      },
    };
    const resultEvent: AgentStreamEvent = {
      type: 'result',
      content: 'done',
    };

    await updatePackageLocalKernelTraceFinalization(usageEvent, {
      state,
      traceFinalizer: finalizer,
    });
    await updatePackageLocalKernelTraceFinalization(resultEvent, {
      state,
      traceFinalizer: finalizer,
    });

    expect(state.usage).toBe(usageEvent.usage);
    expect(finalizer.finish).toHaveBeenCalledTimes(1);
    expect(finalizer.finish).toHaveBeenCalledWith('success', {
      content: 'done',
      usage: usageEvent.usage,
    });
  });

  it('finalizes kernel error events with message and code', async () => {
    const finalizer = {
      finish: vi.fn(async () => undefined),
    };

    await updatePackageLocalKernelTraceFinalization(
      {
        type: 'error',
        message: 'model failed',
        code: 'MODEL_ERROR',
      },
      {
        state: {},
        traceFinalizer: finalizer,
      },
    );

    expect(finalizer.finish).toHaveBeenCalledWith('error', {
      error: 'model failed',
      code: 'MODEL_ERROR',
    });
  });

  it('finalizes thrown errors without swallowing them', async () => {
    const finalizer = {
      finish: vi.fn(async () => undefined),
    };
    const error = new Error('stream failed');

    await finishPackageLocalKernelTraceError(error, finalizer);

    expect(finalizer.finish).toHaveBeenCalledWith('error', {
      error: 'stream failed',
    });
  });
});
