import { createHash } from 'node:crypto';
import {
  AGENT_PROTOCOL_VERSION,
  AgentCommandType,
  AgentProtocolError,
  parseAgentCommand,
  type AgentCommand,
  type AgentCommandFailure,
  type AgentCommandResult,
  type AgentEventPage,
  type AgentPrincipal,
  type AgentProtocolCapabilities,
  type AgentProtocolErrorCode,
  type AgentServerEvent,
  type AgentServerScope,
} from '../protocol/index.js';
import {
  createSession,
  forkSession,
  resumeSession,
} from '../session/Session.js';
import { canonicalJson } from '../session/events/canonicalJson.js';
import type {
  ISession,
  SessionOptions,
  StreamMessage,
} from '../session/types.js';
import {
  SessionId,
  type RequestId,
} from '../types/branded.js';
import type { JsonObject } from '../types/common.js';
import {
  getErrorCode,
  getErrorMessage,
  getErrorName,
} from '../utils/errorUtils.js';
import { toJsonValue } from '../utils/jsonValue.js';
import {
  InMemoryAgentServerStore,
  type AgentServerSessionRecord,
  type AgentServerStore,
} from './AgentServerStore.js';
import {
  NOOP_AGENT_SERVER_TELEMETRY,
  type AgentServerTelemetry,
} from './AgentServerTelemetry.js';
import { RemoteApprovalBroker } from './RemoteApprovalBroker.js';
import {
  TenantAdmissionController,
  type TenantAdmissionLimits,
} from './TenantAdmissionController.js';

const DEFAULT_COMMAND_LEASE_TTL_MS = 30_000;
const DEFAULT_EVENT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

export interface AgentServerSessionContext {
  readonly principal: AgentPrincipal;
  readonly operation: 'create' | 'resume' | 'fork';
  readonly sessionId?: SessionId;
  readonly metadata?: JsonObject;
}

export interface AgentServerOptions {
  readonly resolveSessionOptions: (
    context: AgentServerSessionContext,
  ) => SessionOptions | Promise<SessionOptions>;
  readonly authenticate?: (
    request: Request,
  ) => AgentPrincipal | null | Promise<AgentPrincipal | null>;
  readonly store?: AgentServerStore;
  readonly telemetry?: AgentServerTelemetry;
  readonly admission?: Partial<TenantAdmissionLimits> & {
    readonly maxActiveSessionsPerTenant?: number;
  };
  readonly commandLeaseTtlMs?: number;
  readonly approvalTimeoutMs?: number;
  readonly eventPollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxRequestBytes?: number;
  readonly basePath?: string;
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

function commandSessionId(command: AgentCommand): SessionId | undefined {
  return command.type === AgentCommandType.SESSION_CREATE
    || command.type === AgentCommandType.SESSION_LIST
    || command.type === AgentCommandType.INITIALIZE
    ? undefined
    : command.data.sessionId;
}

function requiredScopes(command: AgentCommand): readonly AgentServerScope[] {
  switch (command.type) {
    case AgentCommandType.INITIALIZE:
      return [];
    case AgentCommandType.SESSION_CREATE:
      return ['session:create'];
    case AgentCommandType.SESSION_READ:
    case AgentCommandType.SESSION_LIST:
      return ['session:read'];
    case AgentCommandType.SESSION_FORK:
      return ['session:read', 'session:create'];
    case AgentCommandType.PERMISSION_RESOLVE:
      return ['permission:resolve'];
    default:
      return ['session:write'];
  }
}

function statusForCode(code: AgentProtocolErrorCode): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'SESSION_NOT_FOUND':
    case 'PERMISSION_NOT_FOUND':
      return 404;
    case 'SESSION_CONFLICT':
    case 'COMMAND_CONFLICT':
    case 'COMMAND_IN_PROGRESS':
    case 'STALE_CURSOR':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'OVERLOADED':
      return 503;
    case 'PROTOCOL_VERSION_UNSUPPORTED':
    case 'INVALID_COMMAND':
      return 400;
    default:
      return 500;
  }
}

function json(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export class AgentServer {
  readonly capabilities: AgentProtocolCapabilities = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    commands: Object.values(AgentCommandType),
    transports: ['http-sse'],
    features: {
      approvals: true,
      durableEvents: true,
      eventReplay: true,
      idempotentCommands: true,
    },
  };

  private readonly activeSessions = new Map<string, ManagedSession>();
  private readonly sessionReservations = new Map<string, number>();
  private readonly sessionOperations = new Map<string, Promise<void>>();
  private readonly store: AgentServerStore;
  private readonly telemetry: AgentServerTelemetry;
  private readonly admission: TenantAdmissionController;
  private readonly approvals: RemoteApprovalBroker;
  private readonly maxActiveSessionsPerTenant: number;
  private readonly commandLeaseTtlMs: number;
  private readonly eventPollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxRequestBytes: number;
  private readonly basePath: string;

  constructor(private readonly options: AgentServerOptions) {
    this.store = options.store ?? new InMemoryAgentServerStore();
    this.telemetry = options.telemetry ?? NOOP_AGENT_SERVER_TELEMETRY;
    this.admission = new TenantAdmissionController(options.admission);
    this.maxActiveSessionsPerTenant =
      options.admission?.maxActiveSessionsPerTenant ?? 100;
    this.commandLeaseTtlMs =
      options.commandLeaseTtlMs ?? DEFAULT_COMMAND_LEASE_TTL_MS;
    this.eventPollIntervalMs =
      options.eventPollIntervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    for (const [name, value] of [
      ['maxActiveSessionsPerTenant', this.maxActiveSessionsPerTenant],
      ['commandLeaseTtlMs', this.commandLeaseTtlMs],
      ['eventPollIntervalMs', this.eventPollIntervalMs],
      ['heartbeatIntervalMs', this.heartbeatIntervalMs],
      ['maxRequestBytes', this.maxRequestBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    this.basePath = `/${(options.basePath ?? 'v1/agent').replace(/^\/+|\/+$/g, '')}`;
    this.approvals = new RemoteApprovalBroker({
      timeoutMs: options.approvalTimeoutMs,
      publish: (tenantId, sessionId, request) =>
        this.publish(tenantId, sessionId, 'permission.requested', request),
    });
  }

  async execute(
    command: AgentCommand,
    principal: AgentPrincipal,
    signal?: AbortSignal,
  ): Promise<AgentCommandResult> {
    this.assertPrincipal(principal);
    this.authorize(principal, command);

    const claim = await this.store.claimCommand(
      principal.tenantId,
      command.commandId,
      createHash('sha256').update(canonicalJson(command)).digest('hex'),
      this.commandLeaseTtlMs,
    );
    if (claim.status === 'completed') {
      return claim.result;
    }
    if (claim.status === 'conflict') {
      return this.failure(command.commandId, new AgentProtocolError(
        'COMMAND_CONFLICT',
        'This commandId was already used for a different command',
        409,
      ));
    }
    if (claim.status === 'in_progress') {
      return this.failure(command.commandId, new AgentProtocolError(
        'COMMAND_IN_PROGRESS',
        'A command with this commandId is already in progress',
        409,
        true,
        claim.retryAfterMs,
      ));
    }

    const startedAt = Date.now();
    let releaseAdmission: (() => void) | undefined;
    try {
      releaseAdmission = await this.admission.acquire(principal.tenantId, signal);
      await this.store.sealCommand(
        principal.tenantId,
        command.commandId,
        claim.leaseId,
      );
      const sessionId = commandSessionId(command);
      let result: AgentCommandResult;
      try {
        result = sessionId
          ? await this.runForSession(principal, sessionId, () =>
              this.dispatch(command, principal, signal))
          : await this.dispatch(command, principal, signal);
      } catch (error) {
        result = this.failure(command.commandId, error);
      }
      try {
        await this.store.completeCommand(
          principal.tenantId,
          command.commandId,
          claim.leaseId,
          result,
        );
      } catch (error) {
        result = this.failure(command.commandId, new AgentProtocolError(
          'COMMAND_IN_PROGRESS',
          'Command outcome is uncertain because idempotency completion failed',
          503,
          true,
          this.commandLeaseTtlMs,
          undefined,
          { cause: error },
        ));
      }
      await this.recordCommand(command, principal, startedAt, result);
      return result;
    } catch (error) {
      const result = this.failure(command.commandId, error);
      await this.store.releaseCommand(
        principal.tenantId,
        command.commandId,
        claim.leaseId,
      ).catch(() => undefined);
      await this.recordCommand(command, principal, startedAt, result);
      return result;
    } finally {
      releaseAdmission?.();
    }
  }

  async *events(
    principal: AgentPrincipal,
    sessionId: SessionId,
    options: {
      readonly after?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<AgentServerEvent> {
    this.assertPrincipal(principal);
    this.authorizeScope(principal, 'session:read');
    await this.requireSessionRecord(principal.tenantId, sessionId);

    let after = options.after ?? 0;
    while (!options.signal?.aborted) {
      let page: AgentEventPage;
      try {
        page = await this.store.readEvents(principal.tenantId, sessionId, {
          after,
          limit: 100,
        });
      } catch (error) {
        if (error instanceof RangeError) {
          throw new AgentProtocolError('STALE_CURSOR', error.message, 409);
        }
        throw error;
      }
      for (const event of page.events) {
        after = event.sequence;
        yield event;
        if (event.type === 'session.closed') {
          return;
        }
      }
      if (page.hasMore) {
        continue;
      }
      await this.waitForEvents(principal.tenantId, sessionId, after, options.signal);
    }
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === `${this.basePath}/healthz`) {
      return json({ status: 'ok' });
    }
    if (request.method === 'GET' && url.pathname === `${this.basePath}/readyz`) {
      const health = await this.store.healthCheck();
      return json(
        { status: health.ready ? 'ready' : 'not_ready', ...health.details },
        health.ready ? 200 : 503,
      );
    }

    let principal: AgentPrincipal;
    try {
      const authenticated = await this.options.authenticate?.(request);
      if (!authenticated) {
        throw new AgentProtocolError('UNAUTHENTICATED', 'Authentication required', 401);
      }
      principal = authenticated;
      this.assertPrincipal(principal);
    } catch (error) {
      return this.errorResponse('authentication', error);
    }

    if (request.method === 'POST' && url.pathname === `${this.basePath}/commands`) {
      try {
        const contentLength = Number(request.headers.get('content-length') ?? 0);
        if (Number.isFinite(contentLength) && contentLength > this.maxRequestBytes) {
          throw new AgentProtocolError('INVALID_COMMAND', 'Command body is too large', 413);
        }
        const text = await request.text();
        if (new TextEncoder().encode(text).byteLength > this.maxRequestBytes) {
          throw new AgentProtocolError('INVALID_COMMAND', 'Command body is too large', 413);
        }
        const command = parseAgentCommand(JSON.parse(text));
        const result = await this.execute(command, principal, request.signal);
        const retryHeaders =
          !result.ok && result.error.retryAfterMs
            ? { 'retry-after': String(Math.ceil(result.error.retryAfterMs / 1000)) }
            : undefined;
        return json(
          result,
          result.ok ? 200 : statusForCode(result.error.code),
          retryHeaders,
        );
      } catch (error) {
        return this.errorResponse('invalid', error);
      }
    }

    const match = new RegExp(
      `^${this.basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sessions/([^/]+)/events$`,
    ).exec(url.pathname);
    if (request.method === 'GET' && match?.[1]) {
      try {
        return await this.eventStreamResponse(
          principal,
          SessionId(decodeURIComponent(match[1])),
          url,
          request.headers.get('last-event-id'),
          request.signal,
        );
      } catch (error) {
        return this.errorResponse(
          'events',
          error instanceof URIError
            ? new AgentProtocolError(
                'INVALID_COMMAND',
                'Session identifier is not valid URL encoding',
                400,
              )
            : error,
        );
      }
    }

    return json({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commandId: 'routing',
      ok: false,
      error: {
        code: 'INVALID_COMMAND',
        message: 'Route not found',
        retryable: false,
      },
    } satisfies AgentCommandFailure, 404);
  }

  async close(): Promise<void> {
    const sessions = Array.from(this.activeSessions.values());
    this.activeSessions.clear();
    await Promise.allSettled(sessions.map(async ({ tenantId, session }) => {
      this.approvals.cancelSession(
        tenantId,
        session.sessionId,
        new Error('Agent server is closing'),
      );
      await session.close();
    }));
  }

  private async dispatch(
    command: AgentCommand,
    principal: AgentPrincipal,
    _signal?: AbortSignal,
  ): Promise<AgentCommandResult> {
    switch (command.type) {
      case AgentCommandType.INITIALIZE:
        return this.success(command.commandId, {
          ...this.capabilities,
          serverTime: new Date().toISOString(),
        });
      case AgentCommandType.SESSION_CREATE:
        return this.create(command.commandId, principal, command.data.metadata);
      case AgentCommandType.SESSION_READ:
        return this.read(command.commandId, principal, command.data.sessionId);
      case AgentCommandType.SESSION_LIST:
        return this.list(command.commandId, principal, command.data);
      case AgentCommandType.SESSION_RESUME:
        return this.resume(command.commandId, principal, command.data.sessionId);
      case AgentCommandType.SESSION_FORK:
        return this.fork(command.commandId, principal, command.data);
      case AgentCommandType.SESSION_CLOSE:
        return this.closeSession(command.commandId, principal, command.data.sessionId);
      case AgentCommandType.INPUT_SUBMIT:
        return this.submit(command.commandId, principal, command.data);
      case AgentCommandType.REQUEST_ABORT:
        return this.abort(command.commandId, principal, command.data.sessionId);
      case AgentCommandType.PERMISSION_RESOLVE:
        this.approvals.resolve(
          principal.tenantId,
          command.data.sessionId,
          command.data.permissionRequestId,
          {
            approved: command.data.approved,
            reason: command.data.reason,
            scope: command.data.scope,
          },
        );
        return this.success(command.commandId, {
          sessionId: command.data.sessionId,
          permissionRequestId: command.data.permissionRequestId,
          resolved: true,
        });
    }
  }

  private async create(
    commandId: string,
    principal: AgentPrincipal,
    metadata?: JsonObject,
  ): Promise<AgentCommandResult> {
    const releaseCapacity = this.reserveSessionCapacity(principal.tenantId);
    try {
      const options = await this.resolveSessionOptions({
        principal,
        operation: 'create',
        metadata,
      });
      const session = await createSession(options);
      const now = new Date().toISOString();
      const record: AgentServerSessionRecord = {
        tenantId: principal.tenantId,
        createdBy: principal.subject,
        sessionId: session.sessionId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        metadata,
      };
      try {
        await this.store.putSession(record);
      } catch (error) {
        await session.close().catch(() => undefined);
        throw error;
      }
      this.activeSessions.set(sessionKey(principal.tenantId, session.sessionId), {
        tenantId: principal.tenantId,
        session,
        metadata,
      });
      return this.success(commandId, { session: record });
    } finally {
      releaseCapacity();
    }
  }

  private async read(
    commandId: string,
    principal: AgentPrincipal,
    sessionId: SessionId,
  ): Promise<AgentCommandResult> {
    const record = await this.requireSessionRecord(principal.tenantId, sessionId);
    const managed = this.activeSessions.get(sessionKey(principal.tenantId, sessionId));
    return this.success(commandId, {
      session: record,
      messages: managed?.session.messages ?? [],
      pendingInputs: managed?.session.getPendingInputs() ?? [],
    });
  }

  private async list(
    commandId: string,
    principal: AgentPrincipal,
    options: { cursor?: string; limit?: number },
  ): Promise<AgentCommandResult> {
    const page = await this.store.listSessions(principal.tenantId, options);
    return this.success(commandId, {
      sessions: page.sessions,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }

  private async resume(
    commandId: string,
    principal: AgentPrincipal,
    sessionId: SessionId,
  ): Promise<AgentCommandResult> {
    const existing = this.activeSessions.get(sessionKey(principal.tenantId, sessionId));
    if (existing) {
      return this.success(commandId, {
        session: await this.requireSessionRecord(principal.tenantId, sessionId),
      });
    }
    const releaseCapacity = this.reserveSessionCapacity(principal.tenantId);
    try {
      const record = await this.requireSessionRecord(principal.tenantId, sessionId);
      if (record.status === 'closed') {
        throw new AgentProtocolError('SESSION_CONFLICT', 'Session is closed', 409);
      }
      const options = await this.resolveSessionOptions({
        principal,
        operation: 'resume',
        sessionId,
        metadata: record.metadata,
      });
      const session = await resumeSession({ ...options, sessionId });
      this.activeSessions.set(sessionKey(principal.tenantId, sessionId), {
        tenantId: principal.tenantId,
        session,
        metadata: record.metadata,
      });
      return this.success(commandId, { session: record });
    } finally {
      releaseCapacity();
    }
  }

  private async fork(
    commandId: string,
    principal: AgentPrincipal,
    data: {
      sessionId: SessionId;
      messageId?: string;
      metadata?: JsonObject;
    },
  ): Promise<AgentCommandResult> {
    const releaseCapacity = this.reserveSessionCapacity(principal.tenantId);
    try {
      const sourceRecord = await this.requireSessionRecord(
        principal.tenantId,
        data.sessionId,
      );
      const source = this.activeSessions.get(
        sessionKey(principal.tenantId, data.sessionId),
      );
      let forked: ISession;
      if (source) {
        forked = await source.session.fork({ messageId: data.messageId });
      } else {
        const options = await this.resolveSessionOptions({
          principal,
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
        tenantId: principal.tenantId,
        createdBy: principal.subject,
        sessionId: forked.sessionId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        metadata: data.metadata ?? sourceRecord.metadata,
      };
      try {
        await this.store.putSession(record);
      } catch (error) {
        await forked.close().catch(() => undefined);
        throw error;
      }
      this.activeSessions.set(sessionKey(principal.tenantId, forked.sessionId), {
        tenantId: principal.tenantId,
        session: forked,
        metadata: record.metadata,
      });
      return this.success(commandId, { session: record });
    } finally {
      releaseCapacity();
    }
  }

  private async submit(
    commandId: string,
    principal: AgentPrincipal,
    data: Extract<AgentCommand, { type: 'input.submit' }>['data'],
  ): Promise<AgentCommandResult> {
    const managed = this.requireActiveSession(principal.tenantId, data.sessionId);
    const submission = await managed.session.send(data.input, {
      priority: data.priority,
      expectedRequestId: data.expectedRequestId,
      maxTurns: data.maxTurns,
    });
    if (submission.status === 'started') {
      managed.activeRequestId = submission.requestId;
      this.startPump(managed);
    }
    return this.success(commandId, {
      sessionId: data.sessionId,
      ...submission,
    });
  }

  private async abort(
    commandId: string,
    principal: AgentPrincipal,
    sessionId: SessionId,
  ): Promise<AgentCommandResult> {
    const managed = this.requireActiveSession(principal.tenantId, sessionId);
    await managed.session.abort();
    return this.success(commandId, { sessionId, aborted: true });
  }

  private async closeSession(
    commandId: string,
    principal: AgentPrincipal,
    sessionId: SessionId,
  ): Promise<AgentCommandResult> {
    const record = await this.requireSessionRecord(principal.tenantId, sessionId);
    const key = sessionKey(principal.tenantId, sessionId);
    const managed = this.activeSessions.get(key);
    this.approvals.cancelSession(
      principal.tenantId,
      sessionId,
      new Error('Session closed'),
    );
    await managed?.session.close();
    this.activeSessions.delete(key);
    const updated: AgentServerSessionRecord = {
      ...record,
      status: 'closed',
      updatedAt: new Date().toISOString(),
    };
    await this.store.putSession(updated);
    await this.publish(principal.tenantId, sessionId, 'session.closed', {
      reason: 'user',
    });
    return this.success(commandId, { session: updated });
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
          await this.publish(
            managed.tenantId,
            managed.session.sessionId,
            'session.stream',
            message,
            'requestId' in message ? message.requestId : managed.activeRequestId,
          );
        }
      } while (
        !managed.session.isClosed &&
        managed.session.getPendingInputs().length > 0
      );
    } catch (error) {
      const message: StreamMessage = {
        type: 'error',
        message: getErrorMessage(error),
        code: getErrorCode(error),
        sessionId: managed.session.sessionId,
      };
      await this.publish(
        managed.tenantId,
        managed.session.sessionId,
        'session.stream',
        message,
        managed.activeRequestId,
      );
    }
  }

  private async publish(
    tenantId: string,
    sessionId: SessionId,
    type: AgentServerEvent['type'],
    data: AgentServerEvent['data'],
    requestId?: RequestId,
  ): Promise<void> {
    const serializableData = toJsonValue(data) as AgentServerEvent['data'];
    const event = await this.store.appendEvent(tenantId, sessionId, {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId,
      requestId,
      occurredAt: new Date().toISOString(),
      type,
      data: serializableData,
    } as Omit<AgentServerEvent, 'eventId' | 'sequence'>);
    try {
      await this.telemetry.recordEvent?.({
        tenantId,
        sessionId,
        eventType: event.type,
      });
    } catch {
      // Telemetry is observational and must not change delivery semantics.
    }
  }

  private async resolveSessionOptions(
    context: AgentServerSessionContext,
  ): Promise<SessionOptions> {
    const options = await this.options.resolveSessionOptions(context);
    if (this.options.requirePersistentSessions && !options.sessionRepository) {
      throw new AgentProtocolError(
        'SESSION_CONFLICT',
        'This server requires a persistent sessionRepository',
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
    const record = await this.store.getSession(tenantId, sessionId);
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

  private authorize(principal: AgentPrincipal, command: AgentCommand): void {
    for (const scope of requiredScopes(command)) {
      this.authorizeScope(principal, scope);
    }
  }

  private authorizeScope(principal: AgentPrincipal, scope: AgentServerScope): void {
    if (
      !principal.scopes.includes('session:admin') &&
      !principal.scopes.includes(scope)
    ) {
      throw new AgentProtocolError(
        'FORBIDDEN',
        `Missing required scope: ${scope}`,
        403,
      );
    }
  }

  private assertPrincipal(principal: AgentPrincipal): void {
    if (!principal.tenantId.trim() || !principal.subject.trim()) {
      throw new AgentProtocolError(
        'UNAUTHENTICATED',
        'Principal tenantId and subject are required',
        401,
      );
    }
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

  private async waitForEvents(
    tenantId: string,
    sessionId: SessionId,
    after: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.store.waitForEvents) {
      await this.store.waitForEvents(tenantId, sessionId, after, signal);
      return;
    }
    signal?.throwIfAborted();
    await new Promise<void>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      timeout = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, this.eventPollIntervalMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async eventStreamResponse(
    principal: AgentPrincipal,
    sessionId: SessionId,
    url: URL,
    lastEventId: string | null,
    requestSignal: AbortSignal,
  ): Promise<Response> {
    const cursor = url.searchParams.get('after') ?? lastEventId ?? '0';
    const afterValue =
      requestSignal.aborted
        ? 0
        : Number(cursor);
    if (!Number.isSafeInteger(afterValue) || afterValue < 0) {
      return this.errorResponse(
        'events',
        new AgentProtocolError('STALE_CURSOR', 'Event cursor is invalid', 409),
      );
    }
    try {
      await this.requireSessionRecord(principal.tenantId, sessionId);
      await this.store.readEvents(principal.tenantId, sessionId, {
        after: afterValue,
        limit: 1,
      });
    } catch (error) {
      return this.errorResponse(
        'events',
        error instanceof RangeError
          ? new AgentProtocolError('STALE_CURSOR', error.message, 409)
          : error,
      );
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([requestSignal, controller.signal]);
    const encoder = new TextEncoder();
    const iterator = this.events(principal, sessionId, {
      after: afterValue,
      signal,
    })[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<AgentServerEvent>> | undefined;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: async (output) => {
        if (closed) {
          return;
        }
        pending ??= iterator.next();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([
            pending.then((step) => ({ kind: 'event' as const, step })),
            new Promise<{ kind: 'heartbeat' }>((resolve) => {
              timeout = setTimeout(
                () => resolve({ kind: 'heartbeat' }),
                this.heartbeatIntervalMs,
              );
            }),
          ]);
          if (outcome.kind === 'heartbeat') {
            output.enqueue(encoder.encode(': heartbeat\n\n'));
            return;
          }
          pending = undefined;
          if (outcome.step.done) {
            closed = true;
            output.close();
            return;
          }
          const event = outcome.step.value;
          output.enqueue(encoder.encode(
            `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ));
        } catch (error) {
          closed = true;
          output.error(error);
        } finally {
          if (timeout) {
            clearTimeout(timeout);
          }
        }
      },
      cancel: async (reason) => {
        closed = true;
        controller.abort(reason);
        await iterator.return?.(undefined as never);
      },
    }, { highWaterMark: 1 });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  private success<TData>(
    commandId: string,
    data: TData,
  ): AgentCommandResult<TData> {
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commandId,
      ok: true,
      data: toJsonValue(data) as TData,
    };
  }

  private failure(commandId: string, error: unknown): AgentCommandFailure {
    const protocolError =
      error instanceof AgentProtocolError
        ? error
        : new AgentProtocolError(
            'INTERNAL_ERROR',
            'Internal server error',
            500,
            true,
            undefined,
            undefined,
            { cause: error },
          );
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commandId,
      ok: false,
      error: {
        code: protocolError.protocolCode,
        message: protocolError.message,
        retryable: protocolError.retryable,
        retryAfterMs: protocolError.retryAfterMs,
        details: protocolError.details,
      },
    };
  }

  private errorResponse(commandId: string, error: unknown): Response {
    const failure =
      error instanceof SyntaxError
        ? this.failure(commandId, new AgentProtocolError(
            'INVALID_COMMAND',
            'Command body is not valid JSON',
            400,
          ))
        : getErrorName(error) === 'ZodError'
          ? this.failure(commandId, new AgentProtocolError(
              'INVALID_COMMAND',
              'Command validation failed',
              400,
            ))
        : this.failure(commandId, error);
    return json(
      failure,
      error instanceof AgentProtocolError
        ? error.status
        : statusForCode(failure.error.code),
    );
  }

  private async recordCommand(
    command: AgentCommand,
    principal: AgentPrincipal,
    startedAt: number,
    result: AgentCommandResult,
  ): Promise<void> {
    const sessionId = commandSessionId(command);
    await Promise.allSettled([
      Promise.resolve().then(() =>
        this.telemetry.recordCommand?.({
          commandType: command.type,
          tenantId: principal.tenantId,
          subject: principal.subject,
          durationMs: Date.now() - startedAt,
          outcome: result.ok ? 'success' : 'error',
          errorCode: result.ok ? undefined : result.error.code,
        })),
      Promise.resolve().then(() =>
        this.telemetry.writeAudit?.({
          occurredAt: new Date().toISOString(),
          tenantId: principal.tenantId,
          subject: principal.subject,
          commandId: command.commandId,
          commandType: command.type,
          sessionId,
          outcome: result.ok ? 'success' : 'error',
          errorCode: result.ok ? undefined : result.error.code,
        })),
    ]);
  }
}
