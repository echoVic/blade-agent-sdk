import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import { HookTimeoutError } from '../../errors/HookTimeoutError.js';
import type { ModelContent } from '../../model/message.js';
import { HookEvent } from '../../types/constants.js';
import { SessionId, ToolUseId } from '../../types/identifiers.js';
import { HookRuntime } from '../HookRuntime.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('HookRuntime', () => {
  afterEach(() => vi.useRealTimers());

  it('bounds callbacks, propagates timeout, and blocks while cleanup is pending', async () => {
    vi.useFakeTimers();
    const started = deferred();
    const release = deferred();
    let callbackSignal: AbortSignal | undefined;
    const runtime = new HookRuntime({
      sessionId: SessionId('session-timeout'),
      hookTimeoutMs: 50,
      callbacks: {
        [HookEvent.UserPromptSubmit]: [
          async (input) => {
            callbackSignal = input.abortSignal;
            started.resolve();
            await release.promise;
            return { action: 'continue' };
          },
        ],
      },
    });

    const dispatch = runtime.applyUserPromptSubmit('prompt');
    const timeout = expect(dispatch).rejects.toMatchObject({
      code: 'HOOK_TIMEOUT',
      event: HookEvent.UserPromptSubmit,
      timeoutMs: 50,
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(50);

    await timeout;
    expect(callbackSignal?.aborted).toBe(true);
    expect(runtime.hasPendingCallbackCleanup()).toBe(true);
    await expect(runtime.applyUserPromptSubmit('blocked')).rejects.toThrow('still cleaning up');

    release.resolve();
    await vi.waitFor(() => expect(runtime.hasPendingCallbackCleanup()).toBe(false));
  });

  it('uses the dedicated SessionEnd timeout and runs it only once', async () => {
    vi.useFakeTimers();
    const started = deferred();
    const callback = vi.fn(async (input) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        input.abortSignal?.addEventListener('abort', () => reject(input.abortSignal?.reason), {
          once: true,
        });
      });
      return { action: 'continue' as const };
    });
    const runtime = new HookRuntime({
      sessionId: SessionId('session-end-timeout'),
      hookTimeoutMs: 10_000,
      sessionEndHookTimeoutMs: 50,
      callbacks: { [HookEvent.SessionEnd]: [callback] },
    });

    const dispatch = runtime.runSessionEnd({ reason: 'other' });
    const timeout = expect(dispatch).rejects.toBeInstanceOf(HookTimeoutError);
    await started.promise;
    await vi.advanceTimersByTimeAsync(50);
    await timeout;

    await expect(runtime.runSessionEnd({ reason: 'other' })).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('shares one timeout budget across callbacks in an event', async () => {
    vi.useFakeTimers();
    const secondStarted = deferred();
    const runtime = new HookRuntime({
      sessionId: SessionId('session-shared-budget'),
      hookTimeoutMs: 50,
      callbacks: {
        [HookEvent.UserPromptSubmit]: [
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { action: 'continue' };
          },
          async (input) => {
            secondStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              input.abortSignal?.addEventListener(
                'abort',
                () => reject(input.abortSignal?.reason),
                {
                  once: true,
                },
              );
            });
            return { action: 'continue' };
          },
        ],
      },
    });

    const dispatch = runtime.applyUserPromptSubmit('prompt');
    const timeout = expect(dispatch).rejects.toMatchObject({ code: 'HOOK_TIMEOUT', timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(30);
    await secondStarted.promise;
    await vi.advanceTimersByTimeAsync(20);
    await timeout;
  });

  it('propagates caller cancellation into the active callback', async () => {
    const controller = new AbortController();
    const started = deferred();
    const cancellation = new Error('request cancelled');
    let callbackSignal: AbortSignal | undefined;
    const runtime = new HookRuntime({
      sessionId: SessionId('session-cancel'),
      callbacks: {
        [HookEvent.UserPromptSubmit]: [
          async (input) => {
            callbackSignal = input.abortSignal;
            started.resolve();
            await new Promise<void>((_resolve, reject) => {
              input.abortSignal?.addEventListener(
                'abort',
                () => reject(input.abortSignal?.reason),
                {
                  once: true,
                },
              );
            });
            return { action: 'continue' };
          },
        ],
      },
    });

    const dispatch = runtime.applyUserPromptSubmit('prompt', {
      abortSignal: controller.signal,
    });
    const cancelled = expect(dispatch).rejects.toBe(cancellation);
    await started.promise;
    controller.abort(cancellation);

    await cancelled;
    expect(callbackSignal?.aborted).toBe(true);
  });

  it('rejects invalid timeout configuration', () => {
    for (const [name, value] of [
      ['hookTimeoutMs', 0],
      ['hookTimeoutMs', Number.NaN],
      ['sessionEndHookTimeoutMs', -1],
      ['sessionEndHookTimeoutMs', 2_147_483_648],
    ] as const) {
      expect(
        () =>
          new HookRuntime({
            sessionId: SessionId('session-invalid-timeout'),
            [name]: value,
          }),
      ).toThrow(ConfigError);
    }
  });

  it('rewrites prompt text once while preserving images', async () => {
    const runtime = new HookRuntime({
      sessionId: SessionId('session-prompt'),
      callbacks: {
        [HookEvent.UserPromptSubmit]: [
          async (input) => {
            expect(input).toMatchObject({ hasImages: true, imageCount: 2 });
            return {
              action: 'continue',
              modifiedInput: { userPrompt: 'updated prompt' },
            };
          },
        ],
      },
    });

    const rewritten = await runtime.applyUserPromptSubmit([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,before' } },
      { type: 'text', text: 'first chunk' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,after' } },
      { type: 'text', text: 'second chunk' },
    ] satisfies ModelContent[]);

    expect(rewritten).toEqual([
      { type: 'text', text: 'updated prompt' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,before' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,after' } },
    ]);
  });

  it('applies pre and post tool callbacks through the dispatcher', async () => {
    const runtime = new HookRuntime({
      sessionId: SessionId('session-tool-hooks'),
      callbacks: {
        [HookEvent.PreToolUse]: [
          async () => ({ action: 'continue', modifiedInput: { patched: true } }),
        ],
        [HookEvent.PostToolUse]: [
          async () => ({ action: 'continue', modifiedOutput: { ok: true } }),
        ],
      },
    });

    const pre = await runtime.applyPreToolUse(
      'Read',
      { file_path: 'a.ts' },
      { toolUseId: ToolUseId('tool-1') },
    );
    const post = await runtime.applyPostToolUse(
      'Read',
      pre.updatedInput,
      { status: 'success', model: 'original' },
      { toolUseId: pre.toolUseId },
    );

    expect(pre.updatedInput).toEqual({ file_path: 'a.ts', patched: true });
    expect(post.result.model).toBe('{"ok":true}');
  });

  it('preserves null as an explicit post-tool output', async () => {
    const runtime = new HookRuntime({
      sessionId: SessionId('session-null-output'),
      callbacks: {
        [HookEvent.PostToolUse]: [async () => ({ action: 'continue', modifiedOutput: null })],
      },
    });

    const post = await runtime.applyPostToolUse(
      'Read',
      {},
      { status: 'success', model: 'original' },
    );

    expect(post.result.model).toBe('null');
  });

  it('lets permission callbacks update input or deny execution', async () => {
    const runtime = new HookRuntime({
      sessionId: SessionId('session-permission'),
      callbacks: {
        [HookEvent.PermissionRequest]: [
          async () => ({ action: 'continue', modifiedInput: { approved: true } }),
          async () => ({ action: 'skip', reason: 'blocked' }),
        ],
      },
    });

    await expect(runtime.applyPermissionRequestHooks('Write', {}, {})).resolves.toEqual({
      updatedInput: { approved: true },
      decision: {
        behavior: 'deny',
        message: 'blocked',
        interrupt: false,
      },
    });
  });
});
