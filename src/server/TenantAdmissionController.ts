import { AgentProtocolError } from '../protocol/index.js';

export interface TenantAdmissionLimits {
  readonly maxConcurrentCommands: number;
  readonly maxQueuedCommands: number;
  readonly commandsPerMinute: number;
}

interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

interface TenantState {
  active: number;
  windowStartedAt: number;
  commandsInWindow: number;
  readonly queue: Waiter[];
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_LIMITS: TenantAdmissionLimits = {
  maxConcurrentCommands: 8,
  maxQueuedCommands: 64,
  commandsPerMinute: 600,
};

export class TenantAdmissionController {
  private readonly states = new Map<string, TenantState>();
  private readonly limits: TenantAdmissionLimits;

  constructor(
    limits: Partial<TenantAdmissionLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
  }

  async acquire(tenantId: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const state = this.getState(tenantId);
    this.consumeRateLimit(state);
    if (state.active < this.limits.maxConcurrentCommands) {
      state.active += 1;
      return this.createRelease(tenantId, state);
    }
    if (state.queue.length >= this.limits.maxQueuedCommands) {
      throw new AgentProtocolError(
        'OVERLOADED',
        'Tenant command queue is full',
        503,
        true,
        1000,
      );
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      const onAbort = () => {
        const index = state.queue.indexOf(waiter);
        if (index !== -1) {
          state.queue.splice(index, 1);
        }
        reject(signal?.reason ?? new DOMException('Command aborted', 'AbortError'));
      };
      if (signal) {
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      state.queue.push(waiter);
    });
  }

  private consumeRateLimit(state: TenantState): void {
    const now = this.now();
    const elapsed = now - state.windowStartedAt;
    if (elapsed >= 60_000) {
      state.windowStartedAt = now;
      state.commandsInWindow = 0;
    }
    if (state.commandsInWindow >= this.limits.commandsPerMinute) {
      throw new AgentProtocolError(
        'RATE_LIMITED',
        'Tenant command rate limit exceeded',
        429,
        true,
        Math.max(1, 60_000 - elapsed),
      );
    }
    state.commandsInWindow += 1;
  }

  private createRelease(tenantId: string, state: TenantState): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = state.queue.shift();
      if (next) {
        next.signal?.removeEventListener('abort', next.onAbort ?? (() => {}));
        next.resolve(this.createRelease(tenantId, state));
        return;
      }
      state.active -= 1;
      if (state.active === 0 && state.queue.length === 0) {
        const remaining = Math.max(
          1,
          60_000 - (this.now() - state.windowStartedAt),
        );
        state.cleanupTimer = setTimeout(() => {
          if (state.active === 0 && state.queue.length === 0) {
            this.states.delete(tenantId);
          }
        }, remaining);
        state.cleanupTimer.unref?.();
      }
    };
  }

  private getState(tenantId: string): TenantState {
    const existing = this.states.get(tenantId);
    if (existing) {
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = undefined;
      }
      return existing;
    }
    const created: TenantState = {
      active: 0,
      windowStartedAt: this.now(),
      commandsInWindow: 0,
      queue: [],
    };
    this.states.set(tenantId, created);
    return created;
  }
}
