import type { DurableEventOperationOptions } from '../session/events/DurableEventStore.js';
import type {
  DurableExecutionLease,
  DurableExecutionLeaseAcquireOptions,
} from '../session/events/DurableExecutionLeaseStore.js';
import type {
  DurableEventAppendOptions,
  DurableEventAppendResult,
  DurableEventDraft,
  DurableEventPage,
  DurableEventReadOptions,
} from '../session/events/types.js';
import type {
  SessionRepositoryHealth,
  SessionRepositoryStorageStats,
} from '../session/SessionRepository.js';
import {
  ProjectedSessionRepository,
  type SessionState,
  type SessionStateMutation,
} from '../session/SessionStore.js';
import type { EventSequence, SessionId } from '../types/identifiers.js';
import type { PostgresRuntimeStore } from './PostgresRuntimeStore.js';
import type { RuntimeTenantStore } from './RuntimeStore.js';

export class PostgresTenantRuntimeStore
  extends ProjectedSessionRepository
  implements RuntimeTenantStore
{
  constructor(
    private readonly runtime: PostgresRuntimeStore,
    private readonly tenantId: string,
  ) {
    super();
  }

  initialize(): Promise<void> {
    return this.runtime.initialize();
  }
  protected readState(sessionId: SessionId): Promise<SessionState | null> {
    return this.runtime.loadSessionState(this.tenantId, sessionId);
  }
  protected updateState<T>(
    sessionId: SessionId,
    create: () => SessionState,
    mutation: SessionStateMutation<T>,
  ): Promise<T> {
    return this.runtime.mutateSessionState(this.tenantId, sessionId, create, mutation);
  }
  listSessions(): Promise<SessionId[]> {
    return this.runtime.listSessionProjectionIds(this.tenantId);
  }
  deleteSession(sessionId: SessionId): Promise<void> {
    return this.runtime.deleteSessionProjection(this.tenantId, sessionId);
  }
  cleanupOldSessions(): Promise<void> {
    return this.runtime.cleanupSessionProjections(this.tenantId);
  }
  getStorageStats(): Promise<SessionRepositoryStorageStats> {
    return this.runtime.sessionStorageStats(this.tenantId);
  }
  async checkStorageHealth(): Promise<SessionRepositoryHealth> {
    const health = await this.runtime.healthCheck();
    return {
      isAvailable: health.ready,
      canWrite: health.ready,
      ...(!health.ready && health.details?.error ? { error: String(health.details.error) } : {}),
    };
  }
  append(
    sessionId: SessionId,
    events: readonly DurableEventDraft[],
    options?: DurableEventAppendOptions,
  ): Promise<DurableEventAppendResult> {
    return this.runtime.appendDurableEvents(this.tenantId, sessionId, events, options);
  }
  read(sessionId: SessionId, options?: DurableEventReadOptions): Promise<DurableEventPage> {
    return this.runtime.readDurableEvents(this.tenantId, sessionId, options);
  }
  getHeadSequence(sessionId: SessionId): Promise<EventSequence | null> {
    return this.runtime.getDurableHead(this.tenantId, sessionId);
  }
  requiresExecutionLease(
    sessionId: SessionId,
    options?: DurableEventOperationOptions,
  ): Promise<boolean> {
    return this.runtime.requiresExecutionLease(this.tenantId, sessionId, options);
  }
  acquireExecutionLease(
    sessionId: SessionId,
    options: DurableExecutionLeaseAcquireOptions,
  ): Promise<DurableExecutionLease> {
    return this.runtime.acquireExecutionLease(this.tenantId, sessionId, options);
  }
  renewExecutionLease(
    lease: DurableExecutionLease,
    ttlMs: number,
    options?: DurableEventOperationOptions,
  ): Promise<DurableExecutionLease> {
    return this.runtime.renewExecutionLease(this.tenantId, lease, ttlMs, options);
  }
  assertExecutionLease(
    lease: DurableExecutionLease,
    options?: DurableEventOperationOptions,
  ): Promise<void> {
    return this.runtime.assertExecutionLease(this.tenantId, lease, options);
  }
  withExecutionLease<T>(
    lease: DurableExecutionLease,
    operation: () => Promise<T>,
    options?: DurableEventOperationOptions,
  ): Promise<T> {
    return this.runtime.withExecutionLease(this.tenantId, lease, operation, options);
  }
  releaseExecutionLease(
    lease: DurableExecutionLease,
    options?: DurableEventOperationOptions,
  ): Promise<void> {
    return this.runtime.releaseExecutionLease(this.tenantId, lease, options);
  }
}
