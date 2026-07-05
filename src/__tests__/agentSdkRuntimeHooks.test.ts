import { describe, expect, it, vi } from 'vitest';
import {
  initializePackageLocalRuntimeHooks,
  streamWithPackageLocalRuntimeTraceCollector,
} from '../../packages/agent-sdk/src/session/runtimeHooks.js';
import type { PackageLocalRuntimeHookManagerPort } from '../../packages/agent-sdk/src/session/runtimeHooks.js';
import { HookEvent } from '../../packages/agent-sdk/src/types/constants.js';

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
});

async function* successfulStream(): AsyncGenerator<string> {
  yield 'first';
  yield 'second';
}

async function* failingStream(): AsyncGenerator<string> {
  yield 'before-error';
  throw new Error('stream failed');
}
