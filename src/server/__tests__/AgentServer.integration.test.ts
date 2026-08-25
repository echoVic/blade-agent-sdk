import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import {
  AGENT_PROTOCOL_VERSION,
  AgentCommandType,
  type AgentCommandResult,
  type AgentPrincipal,
  type AgentServerEvent,
} from '../../protocol/index.js';
import type { ConfirmationHandler } from '../../tools/types/index.js';
import type { SessionId } from '../../types/branded.js';

const createAgent = vi.fn(async () => ({
  async *streamChat(message: unknown, context: unknown) {
    yield { type: 'turn_start', turn: 1 };
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    if (text.includes('approval')) {
      const handler = (context as { confirmationHandler?: ConfirmationHandler })
        .confirmationHandler;
      if (!handler) {
        throw new Error('confirmationHandler missing');
      }
      const response = await handler.requestConfirmation({
        toolName: 'Deploy',
        args: { environment: 'production' },
        title: 'Deploy production',
        message: 'Allow deployment?',
        risks: ['production change'],
      });
      yield {
        type: 'content_delta',
        delta: response.approved ? 'approved' : 'denied',
      };
    } else {
      yield { type: 'content_delta', delta: 'ok' };
    }
    return {
      success: true,
      finalMessage: 'done',
      metadata: {
        turnsCount: 1,
        toolCallsCount: 0,
        duration: 0,
      },
    };
  },
  async setModel() {},
}));

vi.mock('../../agent/Agent.js', () => ({
  Agent: { create: createAgent },
}));

const { AgentClient } = await import('../../browser/AgentClient.js');
const { AgentServer } = await import('../AgentServer.js');
const { InMemoryAgentServerStore } = await import('../AgentServerStore.js');

class FailOnceCompletionStore extends InMemoryAgentServerStore {
  private failed = false;

  override async completeCommand(
    tenantId: string,
    commandId: string,
    leaseId: string,
    result: AgentCommandResult,
  ): Promise<void> {
    if (commandId === 'uncertain-create' && !this.failed) {
      this.failed = true;
      throw new Error('injected completion failure');
    }
    await super.completeCommand(tenantId, commandId, leaseId, result);
  }
}

const principal: AgentPrincipal = {
  tenantId: 'tenant-a',
  subject: 'user-a',
  scopes: [
    'session:create',
    'session:read',
    'session:write',
    'permission:resolve',
  ],
};

function command<TType extends string, TData>(
  type: TType,
  commandId: string,
  data: TData,
) {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    commandId,
    type,
    data,
  };
}

function createTestServer() {
  const root = mkdtempSync(join(tmpdir(), 'agent-server-integration-'));
  const repository = new PersistentStore(root);
  const store = new InMemoryAgentServerStore();
  const server = new AgentServer({
    store,
    authenticate: (request) =>
      request.headers.get('authorization') === 'Bearer test'
        ? principal
        : null,
    resolveSessionOptions: () => ({
      provider: {
        type: 'openai-compatible',
        apiKey: 'test-key',
      },
      model: 'test-model',
      sessionRepository: repository,
    }),
    requirePersistentSessions: true,
    eventPollIntervalMs: 5,
    heartbeatIntervalMs: 50,
  });
  return { server, store };
}

async function createSession(server: InstanceType<typeof AgentServer>) {
  const result = await server.execute(
    command(AgentCommandType.SESSION_CREATE, `create-${Date.now()}-${Math.random()}`, {}),
    principal,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return (result.data as { session: { sessionId: SessionId } }).session.sessionId;
}

async function collectUntilResult(
  events: AsyncIterable<AgentServerEvent>,
): Promise<AgentServerEvent[]> {
  const collected: AgentServerEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (
      event.type === 'session.stream' &&
      event.data.type === 'result'
    ) {
      break;
    }
  }
  return collected;
}

describe('AgentServer', () => {
  it('executes idempotent commands without creating duplicate Sessions', async () => {
    const { server } = createTestServer();
    const createCommand = command(
      AgentCommandType.SESSION_CREATE,
      'idempotent-create',
      {},
    );
    const first = await server.execute(createCommand, principal);
    const second = await server.execute(createCommand, principal);
    expect(second).toEqual(first);
    await expect(server.execute(
      command(AgentCommandType.SESSION_CREATE, 'idempotent-create', {
        metadata: { different: true },
      }),
      principal,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_CONFLICT', retryable: false },
    });

    const list = await server.execute(
      command(AgentCommandType.SESSION_LIST, 'list-1', {}),
      principal,
    );
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect((list.data as { sessions: unknown[] }).sessions).toHaveLength(1);
    }
    await server.close();
  });

  it('reserves active Session capacity across concurrent creates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-server-session-capacity-'));
    let signalOptionsStarted: (() => void) | undefined;
    let releaseOptions: (() => void) | undefined;
    const optionsStarted = new Promise<void>((resolve) => {
      signalOptionsStarted = resolve;
    });
    const optionsGate = new Promise<void>((resolve) => {
      releaseOptions = resolve;
    });
    const server = new AgentServer({
      admission: {
        maxActiveSessionsPerTenant: 1,
        maxConcurrentCommands: 2,
      },
      resolveSessionOptions: async () => {
        signalOptionsStarted?.();
        await optionsGate;
        return {
          provider: {
            type: 'openai-compatible',
            apiKey: 'test-key',
          },
          model: 'test-model',
          sessionRepository: new PersistentStore(root),
        };
      },
    });

    const first = server.execute(
      command(AgentCommandType.SESSION_CREATE, 'capacity-create-1', {}),
      principal,
    );
    await optionsStarted;
    const second = await server.execute(
      command(AgentCommandType.SESSION_CREATE, 'capacity-create-2', {}),
      principal,
    );
    expect(second).toMatchObject({
      ok: false,
      error: { code: 'OVERLOADED' },
    });
    releaseOptions?.();
    await expect(first).resolves.toMatchObject({ ok: true });

    const listed = await server.execute(
      command(AgentCommandType.SESSION_LIST, 'capacity-list', {}),
      principal,
    );
    expect(listed).toMatchObject({
      ok: true,
      data: { sessions: [expect.any(Object)] },
    });
    await server.close();
  });

  it('keeps an uncertain command sealed when completion persistence fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-server-completion-failure-'));
    const store = new FailOnceCompletionStore();
    const server = new AgentServer({
      store,
      resolveSessionOptions: () => ({
        provider: {
          type: 'openai-compatible',
          apiKey: 'test-key',
        },
        model: 'test-model',
        sessionRepository: new PersistentStore(root),
      }),
    });
    const createCommand = command(
      AgentCommandType.SESSION_CREATE,
      'uncertain-create',
      {},
    );

    await expect(server.execute(createCommand, principal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_IN_PROGRESS' },
    });
    await expect(server.execute(createCommand, principal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_IN_PROGRESS' },
    });
    const listed = await server.execute(
      command(AgentCommandType.SESSION_LIST, 'list-after-uncertain-create', {}),
      principal,
    );
    expect(listed).toMatchObject({
      ok: true,
      data: { sessions: [expect.any(Object)] },
    });
    await server.close();
  });

  it('streams Session events through the typed server API', async () => {
    const { server } = createTestServer();
    const sessionId = await createSession(server);
    const submitted = await server.execute(
      command(AgentCommandType.INPUT_SUBMIT, 'submit-1', {
        sessionId,
        input: 'hello',
      }),
      principal,
    );
    expect(submitted.ok).toBe(true);

    const events = await collectUntilResult(server.events(principal, sessionId));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'session.stream',
        data: expect.objectContaining({ type: 'content', delta: 'ok' }),
      }),
      expect.objectContaining({
        type: 'session.stream',
        data: expect.objectContaining({ type: 'result', subtype: 'success' }),
      }),
    ]));
    await server.close();
  });

  it('keeps telemetry failures outside command and event semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-server-telemetry-failure-'));
    const server = new AgentServer({
      telemetry: {
        recordCommand() {
          throw new Error('metric unavailable');
        },
        recordEvent() {
          throw new Error('metric unavailable');
        },
        writeAudit() {
          throw new Error('audit unavailable');
        },
      },
      resolveSessionOptions: () => ({
        provider: {
          type: 'openai-compatible',
          apiKey: 'test-key',
        },
        model: 'test-model',
        sessionRepository: new PersistentStore(root),
      }),
    });

    const sessionId = await createSession(server);
    await expect(server.execute(
      command(AgentCommandType.INPUT_SUBMIT, 'telemetry-submit', {
        sessionId,
        input: 'hello',
      }),
      principal,
    )).resolves.toMatchObject({ ok: true });
    const events = await collectUntilResult(server.events(principal, sessionId));
    expect(events.some(
      (serverEvent) =>
        serverEvent.type === 'session.stream'
        && serverEvent.data.type === 'result',
    )).toBe(true);
    await server.close();
  });

  it('resumes SSE delivery from Last-Event-ID', async () => {
    const { server, store } = createTestServer();
    const sessionId = await createSession(server);
    await store.appendEvent('tenant-a', sessionId, {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId,
      occurredAt: '2026-08-25T00:00:00.000Z',
      type: 'session.stream',
      data: { type: 'content', delta: 'already-delivered', sessionId },
    });
    await store.appendEvent('tenant-a', sessionId, {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId,
      occurredAt: '2026-08-25T00:00:01.000Z',
      type: 'session.closed',
      data: { reason: 'test' },
    });

    const response = await server.handle(new Request(
      `https://agent.test/v1/agent/sessions/${sessionId}/events`,
      {
        headers: {
          authorization: 'Bearer test',
          'last-event-id': '1',
        },
      },
    ));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('id: 2');
    expect(body).not.toContain('already-delivered');
    await server.close();
  });

  it('keeps Session ownership tenant scoped', async () => {
    const { server } = createTestServer();
    const sessionId = await createSession(server);
    const other: AgentPrincipal = {
      ...principal,
      tenantId: 'tenant-b',
      subject: 'user-b',
    };
    const result = await server.execute(
      command(AgentCommandType.SESSION_READ, 'cross-tenant-read', { sessionId }),
      other,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND' },
    });
    await server.close();
  });

  it('resumes a persisted Session on another server instance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-server-cross-instance-'));
    const repository = new PersistentStore(root);
    const store = new InMemoryAgentServerStore();
    const options = {
      store,
      resolveSessionOptions: () => ({
        provider: { type: 'openai-compatible' as const, apiKey: 'test-key' },
        model: 'test-model',
        sessionRepository: repository,
      }),
      requirePersistentSessions: true,
      eventPollIntervalMs: 5,
    };
    const first = new AgentServer(options);
    const second = new AgentServer(options);
    const sessionId = await createSession(first);
    await first.close();

    const resumed = await second.execute(
      command(AgentCommandType.SESSION_RESUME, 'cross-instance-resume', {
        sessionId,
      }),
      principal,
    );
    expect(resumed.ok).toBe(true);
    const submitted = await second.execute(
      command(AgentCommandType.INPUT_SUBMIT, 'cross-instance-submit', {
        sessionId,
        input: 'continue',
      }),
      principal,
    );
    expect(submitted.ok).toBe(true);
    const events = await collectUntilResult(second.events(principal, sessionId));
    expect(events.some(
      (event) => event.type === 'session.stream' && event.data.type === 'result',
    )).toBe(true);
    await second.close();
  });

  it('provides an HTTP and SSE browser-client loop with remote approval', async () => {
    const { server } = createTestServer();
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input, init);
      return server.handle(request);
    };
    const client = new AgentClient({
      baseUrl: 'https://agent.test/v1/agent',
      client: { name: 'integration-test', version: '1.0.0' },
      headers: { authorization: 'Bearer test' },
      fetch: fetchImpl,
      retryBaseDelayMs: 1,
    });

    const session = await client.createSession({ purpose: 'approval-test' });
    await session.send('needs approval');
    const events: AgentServerEvent[] = [];
    for await (const event of session.events()) {
      events.push(event);
      if (event.type === 'permission.requested') {
        await client.resolvePermission(
          session.sessionId,
          event.data.permissionRequestId,
          { approved: true, scope: 'once' },
        );
      }
      if (event.type === 'session.stream' && event.data.type === 'result') {
        break;
      }
    }

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'permission.requested' }),
      expect.objectContaining({
        type: 'session.stream',
        data: expect.objectContaining({ type: 'content', delta: 'approved' }),
      }),
    ]));
    await session.close();
    await server.close();
  });
});
