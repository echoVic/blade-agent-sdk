export interface ActiveTurnAbort {
  signal: AbortSignal;
  cleanup: () => void;
}

function combineAbortSignals(signal1: AbortSignal, signal2: AbortSignal): ActiveTurnAbort {
  const controller = new AbortController();

  if (signal1.aborted || signal2.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }

  const cleanup = () => {
    signal1.removeEventListener('abort', onAbort);
    signal2.removeEventListener('abort', onAbort);
  };

  const onAbort = () => {
    cleanup();
    controller.abort();
  };

  signal1.addEventListener('abort', onAbort);
  signal2.addEventListener('abort', onAbort);

  return { signal: controller.signal, cleanup };
}

export class TurnAbortController {
  private active: { controller: AbortController; cleanup: () => void } | null = null;

  hasActiveTurn(): boolean {
    return this.active !== null;
  }

  start(externalSignal?: AbortSignal): ActiveTurnAbort {
    if (this.active !== null) {
      throw new Error('Cannot start a new turn while a previous turn abort scope is active.');
    }

    const controller = new AbortController();
    const combined = externalSignal
      ? combineAbortSignals(externalSignal, controller.signal)
      : { signal: controller.signal, cleanup: () => {} };
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      combined.cleanup();
      if (this.active?.controller === controller) {
        this.active = null;
      }
    };

    if (combined.signal.aborted) {
      cleanup();
    } else {
      combined.signal.addEventListener('abort', cleanup, { once: true });
      this.active = { controller, cleanup };
    }

    return {
      signal: combined.signal,
      cleanup,
    };
  }

  abort(): void {
    const active = this.active;
    if (!active) {
      return;
    }

    active.controller.abort();
    active.cleanup();
  }

  clear(): void {
    const active = this.active;
    if (!active) {
      return;
    }

    active.cleanup();
  }
}
