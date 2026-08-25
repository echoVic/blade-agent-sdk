import { SdkError } from '../errors/SdkError.js';
import type {
  AgentCommandResult,
} from '../protocol/index.js';
import type { DurableEventStore } from '../session/events/DurableEventStore.js';
import type { SessionPersistence } from '../session/SessionRepository.js';
import type { SessionId } from '../types/branded.js';
import type { JsonObject } from '../types/common.js';
import type { AgentServerStore } from './AgentServerStore.js';

export const RUNTIME_STORE_SCHEMA_VERSION = 1 as const;

export interface RuntimeDomainEventDraft {
  readonly eventId?: string;
  readonly type: string;
  readonly data: JsonObject;
  readonly occurredAt?: string;
}

export interface RuntimeDomainEvent extends RuntimeDomainEventDraft {
  readonly schemaVersion: typeof RUNTIME_STORE_SCHEMA_VERSION;
  readonly eventId: string;
  readonly tenantId: string;
  readonly sessionId: SessionId;
  readonly commandId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export interface RuntimeEffectIntent {
  readonly effectId: string;
  readonly type: string;
  readonly payload: JsonObject;
  readonly idempotencyKey: string;
  readonly availableAt?: string;
}

export type RuntimeEffectStatus = 'pending' | 'completed' | 'failed';

export interface RuntimeEffectRecord extends RuntimeEffectIntent {
  readonly tenantId: string;
  readonly sessionId: SessionId;
  readonly commandId: string;
  readonly status: RuntimeEffectStatus;
  readonly attempts: number;
  readonly createdAt: string;
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
    readonly commandId: string;
    readonly fingerprint: string;
    readonly leaseId?: string;
    readonly result: AgentCommandResult;
  };
  readonly expectedLastSequence?: number | null;
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
  readonly headSequence: number | null;
  readonly hasMore: boolean;
}

export interface RuntimeStore extends AgentServerStore {
  initialize(): Promise<void>;
  forTenant(tenantId: string): RuntimeTenantStore;
  commitRuntimeTransaction(
    commit: RuntimeCommandCommit,
  ): Promise<RuntimeCommitResult>;
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
  extends SessionPersistence, DurableEventStore {}

export type RuntimeStoreErrorCode =
  | 'RUNTIME_STORE_COMMAND_CONFLICT'
  | 'RUNTIME_STORE_LEASE_LOST'
  | 'RUNTIME_STORE_SEQUENCE_CONFLICT'
  | 'RUNTIME_STORE_PROJECTION_CONFLICT'
  | 'RUNTIME_STORE_INVALID_TRANSACTION';

export class RuntimeStoreError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the public error-code contract
  constructor(
    code: RuntimeStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
  }
}
