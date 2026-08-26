import { randomUUID } from 'node:crypto';
import {
  InputId,
  RequestId,
  SessionId,
} from '@blade-ai/agent-sdk/core';
import { AgentProtocolError } from '@blade-ai/agent-sdk/protocol';

export const QUEUED_REQUEST_METADATA_KEY = 'bladeQueuedRequest';

function sessionId() {
  return SessionId(`session-${randomUUID()}`);
}

function requireQueuedRequest(metadata) {
  const value = metadata[QUEUED_REQUEST_METADATA_KEY];
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || typeof value.input !== 'string'
    || typeof value.inputId !== 'string'
    || typeof value.requestId !== 'string'
  ) {
    throw new Error('Session route does not contain a valid queued request');
  }
  return value;
}

export class QueuedSessionExecutor {
  constructor(store, publish) {
    this.store = store;
    this.publish = publish;
  }

  async create(context, data) {
    const now = new Date().toISOString();
    const record = {
      tenantId: context.principal.tenantId,
      createdBy: context.principal.subject,
      sessionId: sessionId(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ...(data.metadata ? { metadata: data.metadata } : {}),
    };
    await this.store.putSession(record);
    return record;
  }

  async read(context, data) {
    const session = await this.requireSession(
      context.principal.tenantId,
      data.sessionId,
    );
    const route = await this.store.getSessionRoute(
      context.principal.tenantId,
      data.sessionId,
    );
    const queuedRequest = route ? this.readQueuedRequest(route.metadata) : null;
    return {
      session,
      messages: [],
      pendingInputs:
        route?.state === 'queued' && queuedRequest
          ? [{
              inputId: InputId(queuedRequest.inputId),
              content: queuedRequest.input,
              priority: 'later',
              targetRequestId: RequestId(queuedRequest.requestId),
              acceptedAt: queuedRequest.acceptedAt,
            }]
          : [],
    };
  }

  async resume(context, data) {
    return this.requireSession(context.principal.tenantId, data.sessionId);
  }

  async fork(context, data) {
    const source = await this.requireSession(
      context.principal.tenantId,
      data.sessionId,
    );
    return this.create(context, {
      metadata: {
        ...(source.metadata ?? {}),
        ...(data.metadata ?? {}),
        forkedFrom: source.sessionId,
      },
    });
  }

  async submit(context, data) {
    const tenantId = context.principal.tenantId;
    const session = await this.requireSession(tenantId, data.sessionId);
    if (session.status === 'closed') {
      throw new AgentProtocolError('SESSION_CONFLICT', 'Session is closed', 409);
    }
    if (typeof data.input !== 'string') {
      throw new AgentProtocolError(
        'INVALID_COMMAND',
        'The production stack example accepts text input only',
        400,
      );
    }
    const current = await this.store.getSessionRoute(tenantId, data.sessionId);
    if (current && current.state !== 'idle') {
      throw new AgentProtocolError(
        'SESSION_CONFLICT',
        `Session ${data.sessionId} is ${current.state}`,
        409,
        true,
        250,
      );
    }

    const inputId = InputId(`input-${randomUUID()}`);
    const requestId = RequestId(`request-${randomUUID()}`);
    await this.store.enqueueSession(tenantId, data.sessionId, {
      metadata: {
        ...(session.metadata ?? {}),
        [QUEUED_REQUEST_METADATA_KEY]: {
          version: 1,
          inputId,
          requestId,
          input: data.input,
          acceptedAt: Date.now(),
        },
      },
    });
    return {
      sessionId: data.sessionId,
      inputId,
      requestId,
      status: 'started',
    };
  }

  async abort(context, data) {
    const route = await this.store.getSessionRoute(
      context.principal.tenantId,
      data.sessionId,
    );
    if (route && route.state !== 'idle') {
      throw new AgentProtocolError(
        'SESSION_CONFLICT',
        'This example can abort only after the active Docker execution settles',
        409,
        true,
        250,
      );
    }
  }

  async closeSession(context, data) {
    const tenantId = context.principal.tenantId;
    const record = await this.requireSession(tenantId, data.sessionId);
    const route = await this.store.getSessionRoute(tenantId, data.sessionId);
    if (
      route
      && route.state !== 'idle'
      && route.state !== 'completed'
      && route.state !== 'failed'
    ) {
      throw new AgentProtocolError(
        'SESSION_CONFLICT',
        `Session ${data.sessionId} cannot close while ${route.state}`,
        409,
        true,
        250,
      );
    }
    const closed = {
      ...record,
      status: 'closed',
      updatedAt: new Date().toISOString(),
    };
    await this.store.putSession(closed);
    await this.publish(tenantId, data.sessionId, 'session.closed', {
      reason: 'user',
    });
    return closed;
  }

  async resolvePermission() {
    throw new AgentProtocolError(
      'PERMISSION_NOT_FOUND',
      'This example does not request permissions',
      404,
    );
  }

  async shutdown() {}

  async requireSession(tenantId, id) {
    const record = await this.store.getSession(tenantId, id);
    if (!record) {
      throw new AgentProtocolError(
        'SESSION_NOT_FOUND',
        `Session ${id} was not found`,
        404,
      );
    }
    return record;
  }

  readQueuedRequest(metadata) {
    try {
      return requireQueuedRequest(metadata);
    } catch {
      return null;
    }
  }
}

export { requireQueuedRequest };
