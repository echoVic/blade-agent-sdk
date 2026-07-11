import { describe, expect, it, vi } from 'vitest';
import {
  createPackageLocalRuntimeHookRuntime,
  createPackageLocalRuntimeHookOperations,
  initializePackageLocalRuntimeHooks,
  streamWithPackageLocalRuntimeTraceCollector,
} from '../session/runtimeHooks.js';
import type { PackageLocalRuntimeHookManagerPort } from '../session/runtimeHooks.js';
import { HookEvent } from '../types/constants.js';

function hookManager(): PackageLocalRuntimeHookManagerPort {
  return {
    enable: vi.fn(),
  };
}

describe('agent-sdk package-local runtime hook helpers', () => {
  it('does not enable the hook manager when no hooks are configured', () => {
    const manager = hookManager();

    initializePackageLocalRuntimeHooks({
      hookManager: manager,
      hooks: undefined,
    });

    expect(manager.enable).not.toHaveBeenCalled();
  });

  it('enables the hook manager when hooks are configured', () => {
    const manager = hookManager();

    initializePackageLocalRuntimeHooks({
      hookManager: manager,
      hooks: {
        [HookEvent.UserPromptSubmit]: [async () => ({ action: 'continue' })],
      },
    });

    expect(manager.enable).toHaveBeenCalledTimes(1);
  });

  it('bundles hook initialization behind injected ports', () => {
    const manager = hookManager();
    const operations = createPackageLocalRuntimeHookOperations({
      hookManager: manager,
      hooks: {
        [HookEvent.UserPromptSubmit]: [async () => ({ action: 'continue' })],
      },
    });

    operations.initialize();

    expect(manager.enable).toHaveBeenCalledTimes(1);
  });

  it('sets and clears the trace collector around a successful stream', async () => {
    const collector = { id: 'trace' };
    const setTraceCollector = vi.fn();
    const chunks: string[] = [];

    for await (const chunk of streamWithPackageLocalRuntimeTraceCollector({
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector,
      },
      traceCollector: collector,
      stream: successfulStream(),
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['first', 'second']);
    expect(setTraceCollector).toHaveBeenNthCalledWith(1, collector);
    expect(setTraceCollector).toHaveBeenLastCalledWith(undefined);
  });

  it('clears the trace collector when the stream throws', async () => {
    const collector = { id: 'trace' };
    const setTraceCollector = vi.fn();

    await expect(async () => {
      for await (const _chunk of streamWithPackageLocalRuntimeTraceCollector({
        hookRuntime: {
          enable: vi.fn(),
          setTraceCollector,
        },
        traceCollector: collector,
        stream: failingStream(),
      })) {
        // Consume the stream until it fails.
      }
    }).rejects.toThrow('stream failed');

    expect(setTraceCollector).toHaveBeenNthCalledWith(1, collector);
    expect(setTraceCollector).toHaveBeenLastCalledWith(undefined);
  });

  it('passes each PreToolUse hook the input produced by the previous hook', async () => {
    const secondHook = vi.fn(async () => ({
      action: 'continue' as const,
      modifiedInput: { stage: 'second' },
    }));
    const runtime = createPackageLocalRuntimeHookRuntime({
      sessionId: 'hook-chain-session',
      hooks: {
        [HookEvent.PreToolUse]: [
          async () => ({
            action: 'continue',
            modifiedInput: { stage: 'first' },
          }),
          secondHook,
        ],
      },
    });

    const result = await runtime.applyPreToolUse?.('chain_tool', { stage: 'initial' });

    expect(secondHook).toHaveBeenCalledWith(expect.objectContaining({
      toolInput: { stage: 'first' },
    }));
    expect(result?.updatedInput).toEqual({ stage: 'second' });
  });

  it('passes each PostToolUse hook the output produced by the previous hook', async () => {
    const secondHook = vi.fn(async () => ({
      action: 'continue' as const,
      modifiedOutput: 'second output',
    }));
    const runtime = createPackageLocalRuntimeHookRuntime({
      sessionId: 'hook-chain-session',
      hooks: {
        [HookEvent.PostToolUse]: [
          async () => ({
            action: 'continue',
            modifiedOutput: 'first output',
          }),
          secondHook,
        ],
      },
    });

    const result = await runtime.applyPostToolUse?.(
      'chain_tool',
      {},
      { success: true, llmContent: 'initial output' },
    );

    expect(secondHook).toHaveBeenCalledWith(expect.objectContaining({
      toolOutput: 'first output',
    }));
    expect(result?.result.llmContent).toBe('second output');
  });
});

async function* successfulStream(): AsyncGenerator<string> {
  yield 'first';
  yield 'second';
}

async function* failingStream(): AsyncGenerator<string> {
  yield 'before-error';
  throw new Error('stream failed');
}
