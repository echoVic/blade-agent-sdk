import { SdkError } from '../errors/SdkError.js';
import type {
  DurableExecutionLease,
  DurableExecutionLeaseAcquireOptions,
} from '../session/events/DurableExecutionLeaseStore.js';
import type {
  ExecutionLeaseId,
  FencingToken,
  SessionId,
  WorkerId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type {
  RuntimeEffectRecord,
  RuntimeEffectStatus,
} from './RuntimeStore.js';

export const RUNTIME_SESSION_STATES = [
  'queued',
  'provisioning',
  'running',
  'waiting_approval',
  'suspended',
  'idle',
  'completed',
  'failed',
] as const;

export type RuntimeSessionState = typeof RUNTIME_SESSION_STATES[number];
export type RuntimeWorkerStatus = 'active' | 'draining' | 'offline';
export type RuntimeEffectExecutionMode = 'idempotent' | 'at_most_once';

export interface RuntimeWorkerRegistration {
  readonly workerId: WorkerId;
  readonly capacity: number;
  readonly ttlMs: number;
  readonly metadata?: JsonObject;
}

export interface RuntimeWorkerRecord {
  readonly workerId: WorkerId;
  readonly status: RuntimeWorkerStatus;
  readonly capacity: number;
  readonly activeSessions: number;
  readonly metadata: JsonObject;
  readonly registeredAt: string;
  readonly lastHeartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly drainingAt?: string;
}

export interface RuntimeSessionRoute {
  readonly tenantId: string;
  readonly sessionId: SessionId;
  readonly state: RuntimeSessionState;
  readonly priority: number;
  readonly attempt: number;
  readonly fencingToken: FencingToken;
  readonly workerId?: WorkerId;
  readonly leaseId?: ExecutionLeaseId;
  readonly leaseExpiresAt?: string;
  readonly queuedAt: string;
  readonly updatedAt: string;
  readonly metadata: JsonObject;
  readonly failure?: JsonObject;
}

export interface RuntimeSessionClaim {
  readonly route: RuntimeSessionRoute;
  readonly lease: DurableExecutionLease;
}

export interface RuntimeSessionClaimOptions
  extends DurableExecutionLeaseAcquireOptions {
  readonly tenantId?: string;
}

export interface RuntimeSessionTransition {
  readonly expectedState: RuntimeSessionState;
  readonly state: RuntimeSessionState;
  readonly metadata?: JsonObject;
  readonly failure?: JsonObject;
}

export interface RuntimeSessionSettlement {
  readonly state: 'idle' | 'completed' | 'failed';
  readonly metadata?: JsonObject;
  readonly failure?: JsonObject;
}

export interface RuntimeRecoveryResult {
  readonly offlineWorkers: number;
  readonly suspendedSessions: number;
  readonly requeuedEffects: number;
  readonly uncertainEffects: number;
}

export interface RuntimeEffectLease {
  readonly tenantId: string;
  readonly sessionId: SessionId;
  readonly effectId: string;
  readonly workerId: WorkerId;
  readonly leaseId: ExecutionLeaseId;
  readonly fencingToken: FencingToken;
  readonly expiresAt: string;
}

export interface RuntimeEffectClaimOptions {
  readonly workerId: WorkerId;
  readonly leaseId?: ExecutionLeaseId;
  readonly tenantId?: string;
  readonly ttlMs: number;
  readonly limit?: number;
}

export interface RuntimeEffectClaim extends RuntimeEffectRecord {
  readonly status: 'claimed';
  readonly workerId: WorkerId;
  readonly leaseId: ExecutionLeaseId;
  readonly fencingToken: FencingToken;
  readonly leaseExpiresAt: string;
}

export interface RuntimeEffectFailureOptions {
  readonly retryAt?: string;
}

export type RuntimeEffectReconciliation =
  | {
      readonly status: 'completed';
      readonly result?: JsonObject;
    }
  | {
      readonly status: 'failed';
      readonly error: JsonObject;
    };

export interface WorkerRuntimeStore {
  registerWorker(
    registration: RuntimeWorkerRegistration,
  ): Promise<RuntimeWorkerRecord>;
  heartbeatWorker(workerId: WorkerId, ttlMs: number): Promise<RuntimeWorkerRecord>;
  drainWorker(workerId: WorkerId): Promise<RuntimeWorkerRecord>;
  getWorker(workerId: WorkerId): Promise<RuntimeWorkerRecord | null>;
  enqueueSession(
    tenantId: string,
    sessionId: SessionId,
    options?: {
      readonly priority?: number;
      readonly metadata?: JsonObject;
    },
  ): Promise<RuntimeSessionRoute>;
  claimSession(
    options: RuntimeSessionClaimOptions,
  ): Promise<RuntimeSessionClaim | null>;
  renewSessionLease(
    tenantId: string,
    lease: DurableExecutionLease,
    ttlMs: number,
  ): Promise<RuntimeSessionClaim>;
  transitionSession(
    tenantId: string,
    lease: DurableExecutionLease,
    transition: RuntimeSessionTransition,
  ): Promise<RuntimeSessionRoute>;
  settleSession(
    tenantId: string,
    lease: DurableExecutionLease,
    settlement: RuntimeSessionSettlement,
  ): Promise<RuntimeSessionRoute>;
  handoffSession(
    tenantId: string,
    lease: DurableExecutionLease,
    metadata?: JsonObject,
  ): Promise<RuntimeSessionRoute>;
  preemptSession(
    tenantId: string,
    sessionId: SessionId,
    options?: {
      readonly reason?: JsonObject;
      readonly requeue?: boolean;
    },
  ): Promise<RuntimeSessionRoute>;
  getSessionRoute(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<RuntimeSessionRoute | null>;
  listWorkerSessions(
    workerId: WorkerId,
  ): Promise<readonly RuntimeSessionRoute[]>;
  recoverExpiredWork(): Promise<RuntimeRecoveryResult>;
  claimEffects(
    options: RuntimeEffectClaimOptions,
  ): Promise<readonly RuntimeEffectClaim[]>;
  renewEffectLease(
    lease: RuntimeEffectLease,
    ttlMs: number,
  ): Promise<RuntimeEffectRecord>;
  startEffect(lease: RuntimeEffectLease): Promise<RuntimeEffectRecord>;
  completeEffect(
    lease: RuntimeEffectLease,
    result?: JsonObject,
  ): Promise<RuntimeEffectRecord>;
  failEffect(
    lease: RuntimeEffectLease,
    error: JsonObject,
    options?: RuntimeEffectFailureOptions,
  ): Promise<RuntimeEffectRecord>;
  markEffectUncertain(
    lease: RuntimeEffectLease,
    error: JsonObject,
  ): Promise<RuntimeEffectRecord>;
  reconcileEffect(
    tenantId: string,
    effectId: string,
    outcome: RuntimeEffectReconciliation,
  ): Promise<RuntimeEffectRecord>;
}

export type WorkerRuntimeErrorCode =
  | 'WORKER_INVALID'
  | 'WORKER_NOT_FOUND'
  | 'WORKER_UNAVAILABLE'
  | 'SESSION_ROUTE_NOT_FOUND'
  | 'SESSION_STATE_CONFLICT'
  | 'EFFECT_NOT_FOUND'
  | 'EFFECT_LEASE_LOST'
  | 'EFFECT_RETRY_NOT_ALLOWED';

export class WorkerRuntimeError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the public error-code contract
  constructor(
    code: WorkerRuntimeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
  }
}

const SESSION_TRANSITIONS: Readonly<
  Record<RuntimeSessionState, ReadonlySet<RuntimeSessionState>>
> = {
  queued: new Set(['provisioning', 'failed']),
  provisioning: new Set(['running', 'suspended', 'failed']),
  running: new Set([
    'waiting_approval',
    'suspended',
    'idle',
    'completed',
    'failed',
  ]),
  waiting_approval: new Set(['running', 'suspended', 'failed']),
  suspended: new Set(['queued', 'provisioning', 'idle', 'completed', 'failed']),
  idle: new Set(['queued', 'completed', 'failed']),
  completed: new Set(),
  failed: new Set(),
};

export function canTransitionRuntimeSession(
  from: RuntimeSessionState,
  to: RuntimeSessionState,
): boolean {
  return from === to || SESSION_TRANSITIONS[from].has(to);
}

export function assertRuntimeSessionTransition(
  from: RuntimeSessionState,
  to: RuntimeSessionState,
): void {
  if (!canTransitionRuntimeSession(from, to)) {
    throw new WorkerRuntimeError(
      'SESSION_STATE_CONFLICT',
      `Runtime Session cannot transition from ${from} to ${to}`,
    );
  }
}

export function effectLease(effect: RuntimeEffectRecord): RuntimeEffectLease {
  if (
    !effect.workerId
    || !effect.leaseId
    || effect.fencingToken === undefined
    || !effect.leaseExpiresAt
  ) {
    throw new WorkerRuntimeError(
      'EFFECT_LEASE_LOST',
      `Effect ${effect.tenantId}/${effect.effectId} has no active lease`,
    );
  }
  return {
    tenantId: effect.tenantId,
    sessionId: effect.sessionId,
    effectId: effect.effectId,
    workerId: effect.workerId,
    leaseId: effect.leaseId,
    fencingToken: effect.fencingToken,
    expiresAt: effect.leaseExpiresAt,
  };
}

export function isTerminalRuntimeEffectStatus(
  status: RuntimeEffectStatus,
): boolean {
  return status === 'completed' || status === 'failed' || status === 'uncertain';
}
