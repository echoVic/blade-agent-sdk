import { z } from 'zod';
import { SdkError } from '../../errors/SdkError.js';
import { ExecutionLeaseId, FencingToken, SessionId, WorkerId } from '../../types/identifiers.js';
import type { DurableEventOperationOptions, DurableEventStore } from './DurableEventStore.js';

export const DURABLE_EXECUTION_LEASE_FORMAT = 'blade.durable-execution-lease' as const;
export const DURABLE_EXECUTION_LEASE_FORMAT_VERSION = 1 as const;

export interface DurableExecutionFence {
  readonly leaseId: ExecutionLeaseId;
  readonly fencingToken: FencingToken;
}

export interface DurableExecutionLease extends DurableExecutionFence {
  readonly sessionId: SessionId;
  readonly ownerId: WorkerId;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
}

export interface DurableExecutionLeaseAcquireOptions extends DurableEventOperationOptions {
  readonly leaseId: ExecutionLeaseId;
  readonly ownerId: WorkerId;
  readonly ttlMs: number;
}

export interface PersistedDurableExecutionLeaseState {
  readonly format: typeof DURABLE_EXECUTION_LEASE_FORMAT;
  readonly version: typeof DURABLE_EXECUTION_LEASE_FORMAT_VERSION;
  readonly sessionId: SessionId;
  readonly fencingToken: FencingToken;
  readonly leaseId: ExecutionLeaseId;
  readonly ownerId: WorkerId;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
}

export type DurableExecutionLeaseErrorCode =
  | 'DURABLE_EXECUTION_LEASE_INVALID'
  | 'DURABLE_EXECUTION_LEASE_NOT_SUPPORTED'
  | 'DURABLE_EXECUTION_LEASE_CONFLICT'
  | 'DURABLE_EXECUTION_LEASE_REQUIRED'
  | 'DURABLE_EXECUTION_LEASE_LOST'
  | 'DURABLE_EXECUTION_LEASE_TIMEOUT'
  | 'DURABLE_EXECUTION_LEASE_CORRUPT'
  | 'DURABLE_EXECUTION_LEASE_WRITE_FAILED';

export class DurableExecutionLeaseError extends SdkError {
  readonly sessionId?: SessionId;
  readonly leaseId?: ExecutionLeaseId;
  readonly fencingToken?: FencingToken;
  readonly activeLease?: DurableExecutionLease;

  constructor(
    code: DurableExecutionLeaseErrorCode,
    message: string,
    options: {
      sessionId?: SessionId;
      leaseId?: ExecutionLeaseId;
      fencingToken?: FencingToken;
      activeLease?: DurableExecutionLease;
      cause?: unknown;
    } = {},
  ) {
    super(code, message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.sessionId = options.sessionId;
    this.leaseId = options.leaseId;
    this.fencingToken = options.fencingToken;
    this.activeLease = options.activeLease ? structuredClone(options.activeLease) : undefined;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.leaseId !== undefined ? { leaseId: this.leaseId } : {}),
      ...(this.fencingToken !== undefined ? { fencingToken: this.fencingToken } : {}),
      ...(this.activeLease !== undefined ? { activeLease: this.activeLease } : {}),
    };
  }
}

export type DurableExecutionLeaseOperation =
  | 'requires'
  | 'acquire'
  | 'renew'
  | 'assert'
  | 'with'
  | 'release';

export class DurableExecutionLeaseTimeoutError extends DurableExecutionLeaseError {
  constructor(
    readonly operation: DurableExecutionLeaseOperation,
    readonly timeoutMs: number,
    options: {
      sessionId: SessionId;
      leaseId?: ExecutionLeaseId;
      fencingToken?: FencingToken;
      cause?: unknown;
    },
  ) {
    super(
      'DURABLE_EXECUTION_LEASE_TIMEOUT',
      `Execution lease ${operation} timed out after ${timeoutMs}ms for Session ${options.sessionId}`,
      options,
    );
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      operation: this.operation,
      timeoutMs: this.timeoutMs,
    };
  }
}

const DURABLE_EXECUTION_LEASE_ERROR_CODES: ReadonlySet<string> = new Set([
  'DURABLE_EXECUTION_LEASE_INVALID',
  'DURABLE_EXECUTION_LEASE_NOT_SUPPORTED',
  'DURABLE_EXECUTION_LEASE_CONFLICT',
  'DURABLE_EXECUTION_LEASE_REQUIRED',
  'DURABLE_EXECUTION_LEASE_LOST',
  'DURABLE_EXECUTION_LEASE_TIMEOUT',
  'DURABLE_EXECUTION_LEASE_CORRUPT',
  'DURABLE_EXECUTION_LEASE_WRITE_FAILED',
] satisfies readonly DurableExecutionLeaseErrorCode[]);

export function isExecutionLeaseFailure(error: unknown): error is DurableExecutionLeaseError {
  if (error instanceof DurableExecutionLeaseError) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    DURABLE_EXECUTION_LEASE_ERROR_CODES.has(error.code)
  );
}

export interface ExecutionLeaseBoundary {
  signal?: AbortSignal;
  assertExecutionLease?: () => Promise<void>;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Runs short persistence work within the active execution-lease boundary. */
export async function runWithExecutionLeaseBoundary<T>(
  boundary: ExecutionLeaseBoundary,
  operation: () => Promise<T>,
): Promise<T> {
  boundary.signal?.throwIfAborted();
  if (boundary.runWithExecutionLease) {
    const result = await boundary.runWithExecutionLease(async () => {
      boundary.signal?.throwIfAborted();
      return operation();
    });
    boundary.signal?.throwIfAborted();
    return result;
  }
  await boundary.assertExecutionLease?.();
  const result = await operation();
  boundary.signal?.throwIfAborted();
  await boundary.assertExecutionLease?.();
  return result;
}

export interface DurableExecutionLeaseStore extends DurableEventStore {
  /**
   * Returns true once the Session has entered fenced execution mode.
   * This requirement remains sticky after expiry or release.
   */
  requiresExecutionLease(
    sessionId: SessionId,
    options?: DurableEventOperationOptions,
  ): Promise<boolean>;

  acquireExecutionLease(
    sessionId: SessionId,
    options: DurableExecutionLeaseAcquireOptions,
  ): Promise<DurableExecutionLease>;

  renewExecutionLease(
    lease: DurableExecutionLease,
    ttlMs: number,
    options?: DurableEventOperationOptions,
  ): Promise<DurableExecutionLease>;

  assertExecutionLease(
    lease: DurableExecutionLease,
    options?: DurableEventOperationOptions,
  ): Promise<void>;

  /**
   * Runs a short internal persistence operation while lease takeover is blocked.
   * Implementations must validate the lease before invoking the callback.
   * The callback must not re-enter this Store for the same Session.
   */
  withExecutionLease<T>(
    lease: DurableExecutionLease,
    operation: () => Promise<T>,
    options?: DurableEventOperationOptions,
  ): Promise<T>;

  releaseExecutionLease(
    lease: DurableExecutionLease,
    options?: DurableEventOperationOptions,
  ): Promise<void>;
}

export function isDurableExecutionLeaseStore(
  store: DurableEventStore,
): store is DurableExecutionLeaseStore {
  const candidate = store as Partial<DurableExecutionLeaseStore>;
  return (
    typeof candidate.requiresExecutionLease === 'function' &&
    typeof candidate.acquireExecutionLease === 'function' &&
    typeof candidate.renewExecutionLease === 'function' &&
    typeof candidate.assertExecutionLease === 'function' &&
    typeof candidate.withExecutionLease === 'function' &&
    typeof candidate.releaseExecutionLease === 'function'
  );
}

export function executionFence(lease: DurableExecutionLease): DurableExecutionFence {
  return {
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  };
}

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = z.string().datetime({ offset: true });
const PersistedDurableExecutionLeaseStateSchema = z
  .object({
    format: z.literal(DURABLE_EXECUTION_LEASE_FORMAT),
    version: z.literal(DURABLE_EXECUTION_LEASE_FORMAT_VERSION),
    sessionId: NonEmptyStringSchema,
    fencingToken: PositiveIntegerSchema,
    leaseId: NonEmptyStringSchema,
    ownerId: NonEmptyStringSchema,
    acquiredAt: TimestampSchema,
    renewedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    releasedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const acquiredAt = Date.parse(value.acquiredAt);
    const renewedAt = Date.parse(value.renewedAt);
    const expiresAt = Date.parse(value.expiresAt);
    const releasedAt = value.releasedAt ? Date.parse(value.releasedAt) : undefined;
    if (
      renewedAt < acquiredAt ||
      expiresAt <= renewedAt ||
      (releasedAt !== undefined && releasedAt < renewedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Durable execution lease timestamps are inconsistent',
      });
    }
  });

export function parsePersistedDurableExecutionLeaseState(
  value: unknown,
): PersistedDurableExecutionLeaseState {
  const parsed = PersistedDurableExecutionLeaseStateSchema.parse(value);
  return {
    ...parsed,
    sessionId: SessionId(parsed.sessionId),
    fencingToken: FencingToken(parsed.fencingToken),
    leaseId: ExecutionLeaseId(parsed.leaseId),
    ownerId: WorkerId(parsed.ownerId),
  };
}
