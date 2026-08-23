import { HookTimeoutError } from '../errors/HookTimeoutError.js';
import type { HookCallback, HookInput, HookOutput } from '../session/types.js';
import type { HookEvent } from '../types/constants.js';
import { awaitWithAbortSignal } from '../utils/abortPromise.js';

interface HookDispatchOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export class HookBus {
  private readonly pendingCallbackCleanups = new Set<Promise<void>>();

  constructor(private readonly callbacks: Partial<Record<HookEvent, HookCallback[]>> = {}) {}

  has(event: HookEvent): boolean {
    return (this.callbacks[event]?.length ?? 0) > 0;
  }

  hasPendingCallbackCleanup(): boolean {
    return this.pendingCallbackCleanups.size > 0;
  }

  assertNoPendingCallbackCleanup(): void {
    if (this.hasPendingCallbackCleanup()) {
      throw new Error('An inline hook callback is still cleaning up');
    }
  }

  async dispatch(
    event: HookEvent,
    input: HookInput,
    options: HookDispatchOptions,
  ): Promise<HookOutput[]> {
    const hooks = this.callbacks[event];
    if (!hooks || hooks.length === 0) {
      return [];
    }
    this.assertNoPendingCallbackCleanup();

    options.signal?.throwIfAborted();
    const timeoutController = new AbortController();
    const timeoutError = new HookTimeoutError(event, options.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    let activeCallbackCleanup: Promise<void> | undefined;
    const trackActiveCallback = (): void => {
      if (activeCallbackCleanup) {
        this.trackPendingCallbackCleanup(activeCallbackCleanup);
      }
    };
    signal.addEventListener('abort', trackActiveCallback, { once: true });
    const timeout = setTimeout(() => timeoutController.abort(timeoutError), options.timeoutMs);

    const results: HookOutput[] = [];
    try {
      for (const hook of hooks) {
        signal.throwIfAborted();
        const callback = Promise.resolve().then(() =>
          hook({
            ...input,
            abortSignal: signal,
          }),
        );
        activeCallbackCleanup = callback.then(
          () => undefined,
          () => undefined,
        );
        results.push(await awaitWithAbortSignal(() => callback, signal));
        activeCallbackCleanup = undefined;
      }
      signal.throwIfAborted();
      return results;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', trackActiveCallback);
    }
  }

  private trackPendingCallbackCleanup(cleanup: Promise<void>): void {
    this.pendingCallbackCleanups.add(cleanup);
    void cleanup.finally(() => {
      this.pendingCallbackCleanups.delete(cleanup);
    });
  }
}
