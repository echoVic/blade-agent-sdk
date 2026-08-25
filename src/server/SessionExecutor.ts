import { AgentProtocolError } from '../protocol/AgentProtocolError.js';
import type {
  AbortRequestCommand,
  AgentInputSubmissionData,
  AgentPrincipal,
  AgentServerEvent,
  CloseSessionCommand,
  CreateSessionCommand,
  ForkSessionCommand,
  ReadSessionCommand,
  ResolvePermissionCommand,
  ResumeSessionCommand,
  SubmitInputCommand,
} from '../protocol/index.js';
import type { Message } from '../services/ChatServiceInterface.js';
import {
  createSession,
  forkSession,
  resumeSession,
} from '../session/Session.js';
import { isSessionEventStore } from '../session/SessionRepository.js';
import type {
  ISession,
  PendingSessionInput,
  SessionOptions,
  StreamMessage,
} from '../session/types.js';
import type {
  RequestId,
  SessionId,
} from '../types/branded.js';
import type { JsonObject } from '../types/common.js';
import {
  getErrorCode,
  getErrorMessage,
} from '../utils/errorUtils.js';
import type {
  AgentServerSessionRecord,
  AgentServerStore,
} from './AgentServerStore.js';
import { RemoteApprovalBroker } from './RemoteApprovalBroker.js';

export interface AgentServerSessionContext {
  readonly principal: AgentPrincipal;
  readonly operation: 'create' | 'resume' | 'fork';
  readonly sessionId?: SessionId;
  readonly metadata?: JsonObject;
}

export interface SessionExecutorCommandContext {
  readonly principal: AgentPrincipal;
  readonly commandId: string;
  readonly signal?: AbortSignal;
}

export interface SessionExecutorReadResult {
  readonly session: AgentServerSessionRecord;
  readonly messages: readonly Message[];
  readonly pendingInputs: readonly PendingSessionInput[];
}

export type SessionExecutorEventPublisher = (
  tenantId: string,
  sessionId: SessionId,
  type: AgentServerEvent['type'],
  data: AgentServerEvent['data'],
  requestId?: RequestId,
) => Promise<void>;

/**
 * Runtime boundary between command transport and Session execution.
 *
 * Implementations own active execution state, per-Session serialization,
 * approval correlation, and runtime shutdown. They must publish stream events
 * through the event publisher associated with the AgentServerStore used by the
 * transport.
 */
export interface SessionExecutor {
  create(
    context: SessionExecutorCommandContext,
    data: CreateSessionCommand['data'],
  ): Promise<AgentServerSessionRecord>;
  read(
    context: SessionExecutorCommandContext,
    data: ReadSessionCommand['data'],
  ): Promise<SessionExecutorReadResult>;
  resume(
    context: SessionExecutorCommandContext,
    data: ResumeSessionCommand['data'],
  ): Promise<AgentServerSessionRecord>;
  fork(
    context: SessionExecutorCommandContext,
    data: ForkSessionCommand['data'],
  ): Promise<AgentServerSessionRecord>;
  submit(
    context: SessionExecutorCommandContext,
    data: SubmitInputCommand['data'],
  ): Promise<AgentInputSubmissionData>;
  abort(
    context: SessionExecutorCommandContext,
    data: AbortRequestCommand['data'],
  ): Promise<void>;
  closeSession(
    context: SessionExecutorCommandContext,
    data: CloseSessionCommand['data'],
  ): Promise<AgentServerSessionRecord>;
  resolvePermission(
    context: SessionExecutorCommandContext,
    data: ResolvePermissionCommand['data'],
  ): Promise<void>;
  shutdown(): Promise<void>;
}

export interface InProcessSessionExecutorOptions {
  readonly store: AgentServerStore;
  readonly resolveSessionOptions: (
    context: AgentServerSessionContext,
  ) => SessionOptions | Promise<SessionOptions>;
  readonly publish: SessionExecutorEventPublisher;
  readonly maxActiveSessionsPerTenant?: number;
  readonly approvalTimeoutMs?: number;
  readonly requirePersistentSessions?: boolean;
}

interface ManagedSession {
  readonly tenantId: string;
  readonly session: ISession;
  readonly metadata?: JsonObject;
  pump?: Promise<void>;
  activeRequestId?: RequestId;
}

function sessionKey(tenantId: string, sessionId: SessionId): string {
  return `${tenantId}\0${sessionId}`;
}

export class InProcessSessionExecutor implements SessionExecutor {
  private readonly activeSessions = new Map<string, ManagedSession>();
  private readonly sessionReservations = new Map<string, number>();
  private readonly sessionOperations = new Map<string, Promise<void>>();
  private readonly approvals: RemoteApprovalBroker;
  private readonly maxActiveSessionsPerTenant: number;

  constructor(private readonly options: InProcessSessionExecutorOptions) {
    this.maxActiveSessionsPerTenant =
      options.maxActiveSessionsPerTenant ?? 100;
    if (
      !Number.isSafeInteger(this.maxActiveSessionsPerTenant)
      || this.maxActiveSessionsPerTenant < 1
    ) {
      throw new RangeError(
        'maxActiveSessionsPerTenant must be a positive safe integer',
      );
    }
    this.approvals = new RemoteApprovalBroker({
      timeoutMs: options.approvalTimeoutMs,
      publish: (tenantId, sessionId, request) =>
        options.publish(
          tenantId,
          sessionId,
          'permission.requested',
          request,
        ),
    });
  }

  async create(
    context: SessionExecutorCommandContext,
    data: CreateSessionCommand['data'],
  ): Promise<AgentServerSessionRecord> {
    const releaseCapacity = this.reserveSessionCapacity(
      context.principal.tenantId,
    );
    try {
      const options = await this.resolveSessionOptions({
        principal: context.principal,
        operation: 'create',
        metadata: data.metadata,
      });
      const session = await createSession(options);
      const now = new Date().toISOString();
      const record: AgentServerSessionRecord = {
        tenantId: context.principal.tenantId,
        createdBy: context.principal.subject,
        sessionId: session.sessionId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        metadata: data.metadata,
      };
      try {
        await this.options.store.putSession(record);
      } catch (error) {
        await session.close().catch(() => undefined);
        throw error;
      }
      this.activeSessions.set(
        sessionKey(context.principal.tenantId, session.sessionId),
        {
          tenantId: context.principal.tenantId,
          session,
          metadata: data.metadata,
        },
      );
      return record;
    } finally {
      releaseCapacity();
    }
  }

  read(
    context: SessionExecutorCommandContext,
    data: ReadSessionCommand['data'],
  ): Promise<SessionExecutorReadResult> {
    return this.runForSession(context.principal, data.sessionId, async () => {
      const record = await this.requireSessionRecord(
        context.principal.tenantId,
        data.sessionId,
      );
      const managed = this.activeSessions.get(
        sessionKey(context.principal.tenantId, data.sessionId),
      );
      return {
        session: record,
        messages: managed?.session.messages ?? [],
        pendingInputs: managed?.session.getPendingInputs() ?? [],
      };
    });
  }

  resume(
    context: SessionExecutorCommandContext,
    data: ResumeSessionCommand['data'],
  ): Promise<AgentServerSessionRecord> {
    return this.runForSession(context.principal, data.sessionId, async () => {
      const existing = this.activeSessions.get(
        sessionKey(context.principal.tenantId, data.sessionId),
      );
      if (existing) {
        return this.requireSessionRecord(
          context.principal.tenantId,
          data.sessionId,
        );
      }
      const releaseCapacity = this.reserveSessionCapacity(
        context.principal.tenantId,
      );
      try {
        const record = await this.requireSessionRecord(
          context.principal.tenantId,
          data.sessionId,
        );
        if (record.status === 'closed') {
          throw new AgentProtocolError(
            'SESSION_CONFLICT',
            'Session is closed',
            409,
          );
        }
        const options = await this.resolveSessionOptions({
          principal: context.principal,
          operation: 'resume',
          sessionId: data.sessionId,
          metadata: record.metadata,
        });
        const session = await resumeSession({
          ...options,
          sessionId: data.sessionId,
        });
        this.activeSessions.set(
          sessionKey(context.principal.tenantId, data.sessionId),
          {
            tenantId: context.principal.tenantId,
            session,
            metadata: record.metadata,
          },
        );
        return record;
      } finally {
        releaseCapacity();
      }
    });
  }

  fork(
    context: SessionExecutorCommandContext,
    data: ForkSessionCommand['data'],
  ): Promise<AgentServerSessionRecord> {
    return this.runForSession(context.principal, data.sessionId, async () => {
      const releaseCapacity = this.reserveSessionCapacity(
        context.principal.tenantId,
      );
      try {
        const sourceRecord = await this.requireSessionRecord(
          context.principal.tenantId,
          data.sessionId,
        );
        const source = this.activeSessions.get(
          sessionKey(context.principal.tenantId, data.sessionId),
        );
        let forked: ISession;
        if (source) {
          forked = await source.session.fork({ messageId: data.messageId });
        } else {
          const options = await this.resolveSessionOptions({
            principal: context.principal,
            operation: 'fork',
            sessionId: data.sessionId,
            metadata: sourceRecord.metadata,
          });
          forked = await forkSession({
            ...options,
            sessionId: data.sessionId,
            messageId: data.messageId,
          });
        }
        const now = new Date().toISOString();
        const record: AgentServerSessionRecord = {
          tenantId: context.principal.tenantId,
          createdBy: context.principal.subject,
          sessionId: forked.sessionId,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          metadata: data.metadata ?? sourceRecord.metadata,
        };
        try {
          await this.options.store.putSession(record);
        } catch (error) {
          await forked.close().catch(() => undefined);
          throw error;
        }
        this.activeSessions.set(
          sessionKey(context.principal.tenantId, forked.sessionId),
          {
            tenantId: context.principal.tenantId,
            session: forked,
            metadata: record.metadata,
          },
        );
        return record;
      } finally {
        releaseCapacity();
      }
    });
  }

  submit(
    context: SessionExecutorCommandContext,
    data: SubmitInputCommand['data'],
  ): Promise<AgentInputSubmissionData> {
    return this.runForSession(context.principal, data.sessionId, async () => {
      const managed = this.requireActiveSession(
        context.principal.tenantId,
        data.sessionId,
      );
      const submission = await managed.session.send(data.input, {
        priority: data.priority,
        expectedRequestId: data.expectedRequestId,
        maxTurns: data.maxTurns,
      });
      if (submission.status === 'started') {
        managed.activeRequestId = submission.requestId;
        this.startPump(managed);
      }
      return {
        sessionId: data.sessionId,
        ...submission,
      };
    });
  }

  abort(
    context: SessionExecutorCommandContext,
    data: AbortRequestCommand['data'],
  ): Promise<void> {
    return this.runForSession(context.principal, data.sessionId, async () => {
      const managed = this.requireActiveSession(
        context.principal.tenantId,
        data.sessionId,
      );
      await managed.session.abort();
    });
  }

  closeSession(
    context: SessionExecutorCommandContext,
    data: CloseSessionCommand['data'],
  ): Promise<AgentServerSessionRecord> {
    return this.runForSession(context.principal, data.sessionId, async () => {
      const record = await this.requireSessionRecord(
        context.principal.tenantId,
        data.sessionId,
      );
      const key = sessionKey(context.principal.tenantId, data.sessionId);
      const managed = this.activeSessions.get(key);
      this.approvals.cancelSession(
        context.principal.tenantId,
        data.sessionId,
        new Error('Session closed'),
      );
      await managed?.session.close();
      this.activeSessions.delete(key);
      const updated: AgentServerSessionRecord = {
        ...record,
        status: 'closed',
        updatedAt: new Date().toISOString(),
      };
      await this.options.store.putSession(updated);
      await this.options.publish(
        context.principal.tenantId,
        data.sessionId,
        'session.closed',
        { reason: 'user' },
      );
      return updated;
    });
  }

  resolvePermission(
    context: SessionExecutorCommandContext,
    data: ResolvePermissionCommand['data'],
  ): Promise<void> {
    return this.runForSession(context.principal, data.sessionId, async () => {
      this.approvals.resolve(
        context.principal.tenantId,
        data.sessionId,
        data.permissionRequestId,
        {
          approved: data.approved,
          reason: data.reason,
          scope: data.scope,
        },
      );
    });
  }

  async shutdown(): Promise<void> {
    const sessions = Array.from(this.activeSessions.values());
    this.activeSessions.clear();
    await Promise.allSettled(sessions.map(async ({ tenantId, session }) => {
      this.approvals.cancelSession(
        tenantId,
        session.sessionId,
        new Error('Session executor is shutting down'),
      );
      await session.close();
    }));
  }

  private startPump(managed: ManagedSession): void {
    if (managed.pump) {
      return;
    }
    managed.pump = this.pump(managed)
      .catch(async () => {
        await managed.session.abort().catch(() => undefined);
      })
      .finally(() => {
        managed.pump = undefined;
        managed.activeRequestId = undefined;
      });
  }

  private async pump(managed: ManagedSession): Promise<void> {
    try {
      do {
        for await (const message of managed.session.stream()) {
          await this.options.publish(
            managed.tenantId,
            managed.session.sessionId,
            'session.stream',
            message,
            'requestId' in message ? message.requestId : managed.activeRequestId,
          );
        }
      } while (
        !managed.session.isClosed
        && managed.session.getPendingInputs().length > 0
      );
    } catch (error) {
      const message: StreamMessage = {
        type: 'error',
        message: getErrorMessage(error),
        code: getErrorCode(error),
        sessionId: managed.session.sessionId,
      };
      await this.options.publish(
        managed.tenantId,
        managed.session.sessionId,
        'session.stream',
        message,
        managed.activeRequestId,
      );
    }
  }

  private async resolveSessionOptions(
    context: AgentServerSessionContext,
  ): Promise<SessionOptions> {
    const options = await this.options.resolveSessionOptions(context);
    const hasEventStore = options.sessionEventStore
      || isSessionEventStore(options.sessionRepository);
    if (
      this.options.requirePersistentSessions
      && (!options.sessionRepository || !hasEventStore)
    ) {
      throw new AgentProtocolError(
        'SESSION_CONFLICT',
        'This executor requires sessionRepository and sessionEventStore',
        409,
      );
    }
    const configuredFactory = options.confirmationHandlerFactory;
    const configuredHandler = options.confirmationHandler;
    return {
      ...options,
      confirmationHandler: undefined,
      confirmationHandlerFactory: (sessionId) =>
        configuredFactory?.(sessionId)
        ?? configuredHandler
        ?? this.approvals.createHandler(context.principal.tenantId, sessionId),
    };
  }

  private requireActiveSession(
    tenantId: string,
    sessionId: SessionId,
  ): ManagedSession {
    const session = this.activeSessions.get(sessionKey(tenantId, sessionId));
    if (!session) {
      throw new AgentProtocolError(
        'SESSION_NOT_FOUND',
        `Session ${sessionId} is not active; resume it before issuing this command`,
        404,
      );
    }
    return session;
  }

  private async requireSessionRecord(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<AgentServerSessionRecord> {
    const record = await this.options.store.getSession(tenantId, sessionId);
    if (!record) {
      throw new AgentProtocolError(
        'SESSION_NOT_FOUND',
        `Session ${sessionId} was not found`,
        404,
      );
    }
    return record;
  }

  private reserveSessionCapacity(tenantId: string): () => void {
    const active = Array.from(this.activeSessions.values())
      .filter((session) => session.tenantId === tenantId).length;
    const reserved = this.sessionReservations.get(tenantId) ?? 0;
    if (active + reserved >= this.maxActiveSessionsPerTenant) {
      throw new AgentProtocolError(
        'OVERLOADED',
        'Tenant active Session limit exceeded',
        503,
        true,
        1000,
      );
    }
    this.sessionReservations.set(tenantId, reserved + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = (this.sessionReservations.get(tenantId) ?? 1) - 1;
      if (remaining === 0) {
        this.sessionReservations.delete(tenantId);
      } else {
        this.sessionReservations.set(tenantId, remaining);
      }
    };
  }

  private runForSession<T>(
    principal: AgentPrincipal,
    sessionId: SessionId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = sessionKey(principal.tenantId, sessionId);
    const previous = this.sessionOperations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const marker = current.then(() => undefined, () => undefined);
    this.sessionOperations.set(key, marker);
    void marker.finally(() => {
      if (this.sessionOperations.get(key) === marker) {
        this.sessionOperations.delete(key);
      }
    });
    return current;
  }
}
