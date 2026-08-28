import { SdkError } from '../errors/SdkError.js';
import type { AgentCommandResult } from '../protocol/index.js';
import type { DurableExecutionLeaseStore } from '../session/events/DurableExecutionLeaseStore.js';
import type { SessionPersistence } from '../session/SessionRepository.js';
import type {
  CommandId,
  EventId,
  EventSequence,
  ExecutionLeaseId,
  FencingToken,
  SessionId,
  WorkerId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { AgentServerStore } from './AgentServerStore.js';
import type {
  RuntimeEffectExecutionMode,
  WorkerRuntimeStore,
} from './WorkerRuntime.js';

export const RUNTIME_STORE_SCHEMA_VERSION = 3 as const;
export const RUNTIME_DOMAIN_EVENT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_EFFECT_STATUSES = [
  'pending',
  'claimed',
  'executing',
  'completed',
  'failed',
  'uncertain',
] as const;

export interface RuntimeDomainEventDraft {
  readonly eventId?: EventId;
  readonly type: string;
  readonly data: JsonObject;
  readonly occurredAt?: string;
}

export interface RuntimeDomainEvent extends RuntimeDomainEventDraft {
  readonly schemaVersion: typeof RUNTIME_DOMAIN_EVENT_SCHEMA_VERSION;
  readonly eventId: EventId;
  readonly tenantId: string;
  readonly sessionId: SessionId;
  readonly commandId: CommandId;
  readonly sequence: EventSequence;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export interface RuntimeEffectIntent {
  readonly effectId: string;
  readonly type: string;
  readonly payload: JsonObject;
  readonly idempotencyKey: string;
  readonly availableAt?: string;
  readonly executionMode?: RuntimeEffectExecutionMode;
}

export type RuntimeEffectStatus = typeof RUNTIME_EFFECT_STATUSES[number];

export interface RuntimeEffectRecord extends RuntimeEffectIntent {
  readonly tenantId: string;
  readonly sessionId: SessionId;
  readonly commandId: CommandId;
  readonly executionMode: RuntimeEffectExecutionMode;
  readonly status: RuntimeEffectStatus;
  readonly attempts: number;
  readonly createdAt: string;
  readonly workerId?: WorkerId;
  readonly leaseId?: ExecutionLeaseId;
  readonly fencingToken?: FencingToken;
  readonly leaseExpiresAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly result?: JsonObject;
  readonly error?: JsonObject;
}

export interface RuntimeProjectionCheckpoint {
  readonly name: string;
  readonly offset: number;
  readonly expectedOffset?: number | null;
  readonly state: JsonObject;
}

export interface RuntimeProjectionRecord {
  readonly tenantId: string;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly offset: number;
  readonly state: JsonObject;
  readonly updatedAt: string;
}

export interface RuntimeCommandCommit {
  readonly tenantId: string;
  readonly sessionId: SessionId;
  readonly command: {
    readonly commandId: CommandId;
    readonly fingerprint: string;
    readonly leaseId?: ExecutionLeaseId;
    readonly result: AgentCommandResult;
  };
  readonly expectedLastSequence?: EventSequence | null;
  readonly events?: readonly RuntimeDomainEventDraft[];
  readonly effects?: readonly RuntimeEffectIntent[];
  readonly projection?: RuntimeProjectionCheckpoint;
}

export interface RuntimeCommitResult {
  readonly status: 'committed' | 'replayed';
  readonly events: readonly RuntimeDomainEvent[];
  readonly effects: readonly RuntimeEffectRecord[];
  readonly projection?: RuntimeProjectionRecord;
}

export interface RuntimeDomainEventPage {
  readonly events: readonly RuntimeDomainEvent[];
  readonly headSequence: EventSequence | null;
  readonly hasMore: boolean;
}

export interface RuntimeStore extends AgentServerStore, WorkerRuntimeStore {
  initialize(): Promise<void>;
  forTenant(tenantId: string): RuntimeTenantStore;
  commitRuntimeTransaction(commit: RuntimeCommandCommit): Promise<RuntimeCommitResult>;
  readDomainEvents(
    tenantId: string,
    sessionId: SessionId,
    options?: { readonly after?: number; readonly limit?: number },
  ): Promise<RuntimeDomainEventPage>;
  listEffects(
    tenantId: string,
    options?: {
      readonly sessionId?: SessionId;
      readonly status?: RuntimeEffectStatus;
      readonly limit?: number;
    },
  ): Promise<readonly RuntimeEffectRecord[]>;
  getProjection(
    tenantId: string,
    sessionId: SessionId,
    name: string,
  ): Promise<RuntimeProjectionRecord | null>;
  close(): Promise<void>;
}

export interface RuntimeTenantStore
  extends SessionPersistence, DurableExecutionLeaseStore {}

export type RuntimeStoreErrorCode =
  | 'RUNTIME_STORE_COMMAND_CONFLICT'
  | 'RUNTIME_STORE_LEASE_LOST'
  | 'RUNTIME_STORE_QUOTA_EXCEEDED'
  | 'RUNTIME_STORE_SEQUENCE_CONFLICT'
  | 'RUNTIME_STORE_PROJECTION_CONFLICT'
  | 'RUNTIME_STORE_INVALID_TRANSACTION';

export class RuntimeStoreError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the public error-code contract
  constructor(code: RuntimeStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
  }
}
