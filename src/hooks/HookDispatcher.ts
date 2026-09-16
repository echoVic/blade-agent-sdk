import { HookTimeoutError } from '../errors/HookTimeoutError.js';
import type { HookCallback, HookInput, HookOutput } from '../session/types.js';
import type { HookEvent } from '../types/constants.js';
import { awaitWithAbortSignal } from '../utils/abortPromise.js';

interface DispatchOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export class HookDispatcher {
  private readonly pendingCleanups = new Set<Promise<void>>();

  constructor(private readonly callbacks: Partial<Record<HookEvent, HookCallback[]>> = {}) {}

  has(event: HookEvent): boolean {
    return (this.callbacks[event]?.length ?? 0) > 0;
  }

  hasPendingCleanup(): boolean {
    return this.pendingCleanups.size > 0;
  }

  async dispatch(
    event: HookEvent,
    input: HookInput,
    options: DispatchOptions,
  ): Promise<HookOutput[]> {
    const callbacks = this.callbacks[event];
    if (!callbacks?.length) {
      return [];
    }
    if (this.hasPendingCleanup()) {
      throw new Error('An inline hook callback is still cleaning up');
    }

    options.signal?.throwIfAborted();
    const timeout = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;
    let activeCleanup: Promise<void> | undefined;
    const rememberActiveCleanup = (): void => {
      if (activeCleanup) {
        this.track(activeCleanup);
      }
    };
    signal.addEventListener('abort', rememberActiveCleanup, { once: true });
    const timer = setTimeout(
      () => timeout.abort(new HookTimeoutError(event, options.timeoutMs)),
      options.timeoutMs,
    );

    try {
      const outputs: HookOutput[] = [];
      for (const callback of callbacks) {
        signal.throwIfAborted();
        const result = Promise.resolve().then(() => callback({ ...input, abortSignal: signal }));
        activeCleanup = result.then(
          () => undefined,
          () => undefined,
        );
        outputs.push(await awaitWithAbortSignal(() => result, signal));
        activeCleanup = undefined;
      }
      signal.throwIfAborted();
      return outputs;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', rememberActiveCleanup);
    }
  }

  private track(cleanup: Promise<void>): void {
    this.pendingCleanups.add(cleanup);
    void cleanup.finally(() => this.pendingCleanups.delete(cleanup));
  }
}
