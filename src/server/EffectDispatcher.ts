import { SdkError } from '../errors/SdkError.js';
import type { WorkerId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import { getErrorCode, getErrorMessage } from '../utils/errorUtils.js';
import type {
  RuntimeEffectClaim,
  RuntimeEffectLease,
  WorkerRuntimeStore,
} from './WorkerRuntime.js';
import { effectLease } from './WorkerRuntime.js';

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_CLAIM_LIMIT = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

export interface RuntimeEffectHandlerContext {
  readonly effect: RuntimeEffectClaim;
  readonly signal: AbortSignal;
}

export interface RuntimeEffectHandler {
  readonly type: string;
  execute(context: RuntimeEffectHandlerContext): Promise<JsonObject> | Promise<void>;
}

export interface EffectDispatcherMetrics {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly retried: number;
  readonly uncertain: number;
  readonly handlerDurationMs: number;
}

export interface EffectDispatcherOptions {
  readonly store: WorkerRuntimeStore;
  readonly workerId: WorkerId;
  readonly handlers: readonly RuntimeEffectHandler[];
  readonly tenantId?: string;
  readonly leaseTtlMs?: number;
  readonly pollIntervalMs?: number;
  readonly claimLimit?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly onMetrics?: (metrics: EffectDispatcherMetrics) => void;
}

export class RetryableRuntimeEffectError extends SdkError {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super('RUNTIME_EFFECT_RETRYABLE', message, options);
  }
}

export class UncertainRuntimeEffectError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('RUNTIME_EFFECT_UNCERTAIN', message, options);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function errorData(error: unknown): JsonObject {
  const code = getErrorCode(error);
  return {
    message: getErrorMessage(error),
    ...(code ? { code } : {}),
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Claims and executes durable outbox effects.
 *
 * An effect is marked executing before its handler is invoked. Idempotent
 * effects may be retried explicitly; at-most-once effects become uncertain
 * when the handler cannot prove an outcome.
 */
export class EffectDispatcher {
  private readonly handlers: ReadonlyMap<string, RuntimeEffectHandler>;
  private readonly leaseTtlMs: number;
  private readonly pollIntervalMs: number;
  private readonly claimLimit: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly metrics: {
    claimed: number;
    completed: number;
    failed: number;
    retried: number;
    uncertain: number;
    handlerDurationMs: number;
  } = {
    claimed: 0,
    completed: 0,
    failed: 0,
    retried: 0,
    uncertain: 0,
    handlerDurationMs: 0,
  };

  constructor(private readonly options: EffectDispatcherOptions) {
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.claimLimit = options.claimLimit ?? DEFAULT_CLAIM_LIMIT;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    for (const [name, value] of [
      ['leaseTtlMs', this.leaseTtlMs],
      ['pollIntervalMs', this.pollIntervalMs],
      ['claimLimit', this.claimLimit],
      ['maxAttempts', this.maxAttempts],
      ['retryDelayMs', this.retryDelayMs],
      ['maxRetryDelayMs', this.maxRetryDelayMs],
    ] as const) {
      assertPositiveInteger(value, name);
    }
    if (this.claimLimit > 100) {
      throw new RangeError('claimLimit must not exceed 100');
    }
    if (this.maxRetryDelayMs < this.retryDelayMs) {
      throw new RangeError('maxRetryDelayMs must be greater than or equal to retryDelayMs');
    }
    const handlers = new Map<string, RuntimeEffectHandler>();
    for (const handler of options.handlers) {
      if (!handler.type.trim()) {
        throw new TypeError('Runtime effect handler type must not be empty');
      }
      if (handlers.has(handler.type)) {
        throw new TypeError(`Runtime effect handler "${handler.type}" is already registered`);
      }
      handlers.set(handler.type, handler);
    }
    this.handlers = handlers;
  }

  getMetrics(): EffectDispatcherMetrics {
    return { ...this.metrics };
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const claimed = await this.runOnce(signal);
      if (claimed === 0) {
        await abortableDelay(this.pollIntervalMs, signal).catch((error) => {
          if (!signal.aborted) {
            throw error;
          }
        });
      }
    }
  }

  async runOnce(signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const claims = await this.options.store.claimEffects({
      workerId: this.options.workerId,
      ttlMs: this.leaseTtlMs,
      limit: this.claimLimit,
      ...(this.options.tenantId ? { tenantId: this.options.tenantId } : {}),
    });
    this.metrics.claimed += claims.length;
    this.publishMetrics();
    await Promise.all(claims.map((claim) => this.dispatch(claim, signal)));
    return claims.length;
  }

  private async dispatch(claim: RuntimeEffectClaim, parentSignal?: AbortSignal): Promise<void> {
    const lease = effectLease(claim);
    if (parentSignal?.aborted) {
      return;
    }
    await this.options.store.startEffect(lease);
    const controller = new AbortController();
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal;
    let heartbeatFailure: unknown;
    const heartbeat = this.renewLease(lease, controller.signal).catch((error) => {
      heartbeatFailure = error;
      controller.abort(error);
    });
    const startedAt = performance.now();
    let handlerCompleted = false;
    try {
      const handler = this.handlers.get(claim.type);
      if (!handler) {
        throw new Error(`No runtime effect handler is registered for "${claim.type}"`);
      }
      signal.throwIfAborted();
      const result = await handler.execute({ effect: claim, signal });
      handlerCompleted = true;
      if (heartbeatFailure !== undefined) {
        throw heartbeatFailure;
      }
      signal.throwIfAborted();
      await this.options.store.completeEffect(lease, result ?? {});
      this.metrics.completed += 1;
    } catch (error) {
      const settlementError = handlerCompleted
        ? claim.executionMode === 'at_most_once'
          ? new UncertainRuntimeEffectError(
              'Effect handler completed but its durable completion is unknown',
              { cause: error },
            )
          : new RetryableRuntimeEffectError(
              'Effect handler completed but its durable completion failed',
              undefined,
              { cause: error },
            )
        : error;
      await this.settleFailure(
        claim,
        lease,
        settlementError,
        parentSignal?.aborted === true,
      );
    } finally {
      this.metrics.handlerDurationMs += performance.now() - startedAt;
      controller.abort();
      await heartbeat;
      this.publishMetrics();
    }
  }

  private async settleFailure(
    claim: RuntimeEffectClaim,
    lease: RuntimeEffectLease,
    error: unknown,
    shuttingDown: boolean,
  ): Promise<void> {
    const details = errorData(error);
    if (
      claim.executionMode === 'at_most_once' &&
      (error instanceof UncertainRuntimeEffectError || shuttingDown)
    ) {
      await this.options.store.markEffectUncertain(lease, details);
      this.metrics.uncertain += 1;
      return;
    }
    if (
      claim.executionMode === 'idempotent' &&
      (error instanceof RetryableRuntimeEffectError || shuttingDown) &&
      claim.attempts + 1 < this.maxAttempts
    ) {
      const requestedDelay =
        error instanceof RetryableRuntimeEffectError ? error.retryAfterMs : undefined;
      const exponentialDelay = Math.min(
        this.maxRetryDelayMs,
        this.retryDelayMs * 2 ** claim.attempts,
      );
      const delay = requestedDelay ?? exponentialDelay;
      assertPositiveInteger(delay, 'retryAfterMs');
      await this.options.store.failEffect(lease, details, {
        retryAt: new Date(Date.now() + delay).toISOString(),
      });
      this.metrics.retried += 1;
      return;
    }
    await this.options.store.failEffect(lease, details);
    this.metrics.failed += 1;
  }

  private async renewLease(lease: RuntimeEffectLease, signal: AbortSignal): Promise<void> {
    const intervalMs = Math.max(1, Math.floor(this.leaseTtlMs / 3));
    while (!signal.aborted) {
      await abortableDelay(intervalMs, signal).catch((error) => {
        if (!signal.aborted) {
          throw error;
        }
      });
      if (signal.aborted) {
        return;
      }
      await this.options.store.renewEffectLease(lease, this.leaseTtlMs);
    }
  }

  private publishMetrics(): void {
    try {
      this.options.onMetrics?.(this.getMetrics());
    } catch {
      // Metrics are observational and must not change effect settlement.
    }
  }
}
