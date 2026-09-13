import { randomUUID } from 'node:crypto';
import { createSession, resumeSession } from '@blade-ai/agent-sdk/session';
import { AgentProtocolError } from '@blade-ai/agent-sdk/protocol';
import { createRepositorySessionOptions } from './RepositoryDemoProvider.mjs';

export const QUEUED_REQUEST_METADATA_KEY = 'bladeQueuedRequest';

export function requireQueuedRequest(metadata) {
  const value = metadata[QUEUED_REQUEST_METADATA_KEY];
  if (!value || typeof value.input !== 'string' || typeof value.inputId !== 'string'
      || typeof value.requestId !== 'string') {
    throw new Error('Session route does not contain a valid queued request');
  }
  return value;
}

/** One local API process accepts input; independent Workers execute it. */
export class QueuedSessionExecutor {
  constructor(store, publish, { state, smoke = false }) {
    this.store = store;
    this.publish = publish;
    this.state = state;
    this.smoke = smoke;
    this.operations = new Map();
    this.closed = false;
  }

  options(tenantId) {
    const persistence = this.store.forTenant(tenantId);
    return {
      ...createRepositorySessionOptions({ smoke: this.smoke, tools: [] }),
      sessionRepository: persistence,
      sessionEventStore: persistence,
      durableEventStore: persistence,
      executionLease: {
        ownerId: `production-api-${process.pid}`,
        leaseId: `accept-${randomUUID()}`,
        ttlMs: 15_000,
      },
    };
  }

  async create(context, data) {
    const session = await createSession(this.options(context.principal.tenantId));
    try {
      const now = new Date().toISOString();
      const record = {
        tenantId: context.principal.tenantId,
        createdBy: context.principal.subject,
        sessionId: session.sessionId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ...(data.metadata ? { metadata: data.metadata } : {}),
      };
      await this.store.putSession(record);
      return record;
    } finally {
      await session.suspendForHandoff();
    }
  }

  async read(context, data) {
    const session = await this.requireSession(context.principal.tenantId, data.sessionId);
    // The persistent snapshot is authoritative for this executor, so the messages
    // are known even though this process holds no live Session. Reporting
    // `loaded: false` would tell the client the projection is unknown and drop
    // `pendingInputCount` from the recovery snapshot.
    const snapshot = await this.store.forTenant(session.tenantId).loadState(data.sessionId);
    return {
      session,
      messages: snapshot?.messages ?? [],
      pendingInputs: snapshot?.pendingInputs ?? [],
      loaded: true,
      // Forwarded so the Server can see a recorded history gap: without it the
      // database says `failed` and the Server still picks a terminal event as
      // the recovery boundary.
      ...(snapshot?.historyProgress
        ? { historyProgress: snapshot.historyProgress }
        : {}),
    };
  }

  async resume(context, data) {
    const session = await this.requireSession(context.principal.tenantId, data.sessionId);
    if (session.status === 'closed') {
      throw new AgentProtocolError('SESSION_CONFLICT', 'Session is closed', 409);
    }
    return session;
  }

  async fork() {
    throw new AgentProtocolError('INVALID_COMMAND', 'This repository example does not support workspace forks', 400);
  }

  submit(context, data) {
    return this.serialize(data.sessionId, async () => {
      const tenantId = context.principal.tenantId;
      const record = await this.requireSession(tenantId, data.sessionId);
      if (record.status === 'closed') {
        throw new AgentProtocolError('SESSION_CONFLICT', 'Session is closed', 409);
      }
      if (typeof data.input !== 'string' || data.input.length > 16_384) {
        throw new AgentProtocolError('INVALID_COMMAND', 'Enter a text task of at most 16,384 characters', 400);
      }
      const route = await this.store.getSessionRoute(tenantId, data.sessionId);
      // A previous attempt may have accepted this input and then failed to enqueue
      // it. The input is already durable in the Session journal, so enqueue that
      // record instead of sending it again. Recovery is bound to the command that
      // was accepted: a different input, command or execution option must never be
      // silently replaced by, or returned as, the pending record.
      const accepted = await this.state.getPendingSubmission(data.sessionId);
      if (accepted) {
        if (accepted.value.input !== data.input
            || accepted.value.commandId !== context.commandId
            || (accepted.value.maxTurns ?? undefined) !== data.maxTurns
            || (data.expectedRequestId !== undefined
                && data.expectedRequestId !== accepted.value.requestId)) {
          throw new AgentProtocolError(
            'SESSION_CONFLICT',
            'A different submission is already pending recovery for this Session',
            409,
          );
        }
        const queuedRequest = route?.metadata?.[QUEUED_REQUEST_METADATA_KEY];
        if (route && route.state === 'queued' && queuedRequest?.requestId === accepted.value.requestId) {
          // A previous attempt enqueued this exact submission before crashing;
          // the same command observing that work is already in flight is success.
          return { sessionId: data.sessionId, ...accepted.value };
        }
        if (route && route.state !== 'idle') {
          throw new AgentProtocolError('SESSION_CONFLICT', `Session is ${route.state}`, 409);
        }
        await this.enqueueAccepted(tenantId, data.sessionId, route, accepted, record);
        return { sessionId: data.sessionId, ...accepted.value };
      }
      if (route && route.state !== 'idle') {
        throw new AgentProtocolError('SESSION_CONFLICT', `Session is ${route.state}`, 409);
      }
      const session = await resumeSession({ ...this.options(tenantId), sessionId: data.sessionId });
      let submission;
      let acceptedValue;
      try {
        submission = await session.send(data.input, {
          ...(data.maxTurns !== undefined ? { maxTurns: data.maxTurns } : {}),
          ...(data.expectedRequestId ? { expectedRequestId: data.expectedRequestId } : {}),
        });
        acceptedValue = {
          ...submission,
          input: data.input,
          commandId: context.commandId,
          ...(data.maxTurns !== undefined ? { maxTurns: data.maxTurns } : {}),
        };
        // The acceptance record is written before anything else can fail: the
        // startup sweep reads it, and when even this write is lost it rebuilds
        // the pending request from the Session journal itself.
        await this.state.recordSubmissionAccepted({
          sessionId: data.sessionId,
          requestId: submission.requestId,
          input: data.input,
          value: acceptedValue,
        });
        await this.state.update(data.sessionId, { submission: acceptedValue });
      } finally {
        await session.suspendForHandoff();
      }
      await this.enqueueAccepted(tenantId, data.sessionId, route, {
        requestId: submission.requestId,
        value: acceptedValue,
      }, record);
      return { sessionId: data.sessionId, ...submission };
    });
  }

  /** Enqueue an accepted submission and clear its pending record only afterwards. */
  async enqueueAccepted(tenantId, sessionId, route, accepted, record) {
    await this.store.enqueueSession(tenantId, sessionId, {
      metadata: {
        ...(route?.metadata ?? {}),
        [QUEUED_REQUEST_METADATA_KEY]: {
          version: 1,
          ...accepted.value,
          acceptedAt: Date.now(),
          crashAfterWrite: this.smoke && record.metadata?.smokeCrashAfterWrite === true,
        },
      },
    });
    await this.state.markSubmissionQueued(sessionId, accepted.requestId);
  }

  async abort(context, data) {
    const tenantId = context.principal.tenantId;
    await this.requireSession(tenantId, data.sessionId);
    const route = await this.store.getSessionRoute(tenantId, data.sessionId);
    if (!route || ['idle', 'completed', 'failed'].includes(route.state)) return;
    const request = requireQueuedRequest(route.metadata);
    await this.state.requestCancel(data.sessionId, request.requestId);
    // Keep the command in progress across transport reconnects. A cached timeout
    // failure would prevent the same commandId ever observing the eventual ACK.
    while (!this.closed) {
      const [cancellation, current] = await Promise.all([
        this.state.getCancellation(data.sessionId, request.requestId),
        this.store.getSessionRoute(tenantId, data.sessionId),
      ]);
      if (cancellation?.status === 'completed') return;
      // A finished route does not prove the execution environment stopped. The
      // runner records that separately, and a failed cleanup surfaces as an error
      // instead of a confirmation that would be false.
      if (cancellation?.cleanup === 'failed') {
        throw new AgentProtocolError(
          'SESSION_CONFLICT',
          `Cancellation is recorded but the execution environment was not confirmed stopped: ${cancellation.cleanupDetail ?? 'cleanup failed'}`,
          409,
        );
      }
      const routeFinished = ['idle', 'completed', 'failed'].includes(current?.state);
      if (routeFinished && cancellation?.cleanup === 'stopped') {
        await this.state.markCancelled(data.sessionId, request.requestId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new AgentProtocolError('SESSION_CONFLICT', 'The API is shutting down; cancellation remains persisted', 409);
  }

  closeSession(context, data) {
    return this.serialize(data.sessionId, async () => {
      const tenantId = context.principal.tenantId;
      const record = await this.requireSession(tenantId, data.sessionId);
      if (record.status === 'closed') return record;
      const route = await this.store.getSessionRoute(tenantId, data.sessionId);
      if (route && !['idle', 'completed', 'failed'].includes(route.state)) {
        throw new AgentProtocolError('SESSION_CONFLICT', `Session cannot close while ${route.state}`, 409);
      }
      // A failed recovery may need operator reconciliation before Session.close can run.
      if (route?.state !== 'failed') {
        const session = await resumeSession({ ...this.options(tenantId), sessionId: data.sessionId });
        await session.close();
      }
      const closed = { ...record, status: 'closed', updatedAt: new Date().toISOString() };
      await this.store.putSession(closed);
      await this.publish(tenantId, data.sessionId, 'session.closed', { reason: 'user' });
      return closed;
    });
  }

  async resolvePermission(context, data) {
    await this.requireSession(context.principal.tenantId, data.sessionId);
    const route = await this.store.getSessionRoute(context.principal.tenantId, data.sessionId);
    const permission = await this.state.getPermission(data.sessionId, data.permissionRequestId);
    if (!route || !['running', 'waiting_approval'].includes(route.state)
        || !permission || permission.status !== 'pending'
        || permission.requestId !== requireQueuedRequest(route.metadata).requestId
        || await this.state.isCancelled(data.sessionId, permission.requestId)) {
      throw new AgentProtocolError('PERMISSION_NOT_FOUND', 'This permission is no longer pending', 404);
    }
    if (data.scope && data.scope !== 'once') {
      throw new AgentProtocolError('INVALID_COMMAND', 'Repository writes require approval for each operation', 400);
    }
    await this.state.resolvePermission(data.sessionId, permission.requestId, data.permissionRequestId, {
      approved: data.approved,
      scope: 'once',
      ...(data.reason ? { reason: data.reason } : {}),
    });
  }

  async shutdown() {
    this.closed = true;
    await Promise.allSettled(this.operations.values());
  }

  async requireSession(tenantId, id) {
    const record = await this.store.getSession(tenantId, id);
    if (!record) throw new AgentProtocolError('SESSION_NOT_FOUND', `Session ${id} was not found`, 404);
    return record;
  }

  serialize(id, operation) {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(id, current);
    void current.finally(() => {
      if (this.operations.get(id) === current) this.operations.delete(id);
    }).catch(() => undefined);
    return current;
  }
}
