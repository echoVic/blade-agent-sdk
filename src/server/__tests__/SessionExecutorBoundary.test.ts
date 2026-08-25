import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROTOCOL_VERSION,
  type AgentCommand,
  AgentCommandType,
  type AgentPrincipal,
} from '../../protocol/index.js';
import { InputId, PermissionRequestId, RequestId, SessionId } from '../../types/identifiers.js';
import { AgentServer } from '../AgentServer.js';
import { InMemoryAgentServerStore } from '../AgentServerStore.js';
import type { RuntimeStore, RuntimeTenantStore } from '../RuntimeStore.js';
import type { SessionExecutor, SessionExecutorCommandContext } from '../SessionExecutor.js';

const principal: AgentPrincipal = {
  tenantId: 'tenant-a',
  subject: 'user-a',
  scopes: ['session:admin'],
};

const sessionId = SessionId('session-1');
const forkedSessionId = SessionId('session-2');
const now = '2026-08-25T00:00:00.000Z';

function command<T extends AgentCommand>(type: T['type'], commandId: string, data: T['data']): T {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    commandId,
    type,
    data,
  } as T;
}

function createExecutor() {
  const calls: Array<{
    method: string;
    context?: SessionExecutorCommandContext;
  }> = [];
  const executor: SessionExecutor = {
    async create(context) {
      calls.push({ method: 'create', context });
      return {
        tenantId: principal.tenantId,
        createdBy: principal.subject,
        sessionId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
    },
    async read(context) {
      calls.push({ method: 'read', context });
      return {
        session: {
          tenantId: principal.tenantId,
          createdBy: principal.subject,
          sessionId,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
        messages: [],
        pendingInputs: [],
      };
    },
    async resume(context) {
      calls.push({ method: 'resume', context });
      return {
        tenantId: principal.tenantId,
        createdBy: principal.subject,
        sessionId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
    },
    async fork(context) {
      calls.push({ method: 'fork', context });
      return {
        tenantId: principal.tenantId,
        createdBy: principal.subject,
        sessionId: forkedSessionId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
    },
    async submit(context) {
      calls.push({ method: 'submit', context });
      return {
        sessionId,
        inputId: InputId('input-1'),
        requestId: RequestId('request-1'),
        status: 'started',
      };
    },
    async abort(context) {
      calls.push({ method: 'abort', context });
    },
    async closeSession(context) {
      calls.push({ method: 'closeSession', context });
      return {
        tenantId: principal.tenantId,
        createdBy: principal.subject,
        sessionId,
        status: 'closed',
        createdAt: now,
        updatedAt: now,
      };
    },
    async resolvePermission(context) {
      calls.push({ method: 'resolvePermission', context });
    },
    async shutdown() {
      calls.push({ method: 'shutdown' });
    },
  };
  return { executor, calls };
}

describe('SessionExecutor boundary', () => {
  it('routes every Session command through an injected executor', async () => {
    const { executor, calls } = createExecutor();
    const server = new AgentServer({ sessionExecutor: executor });
    const commands: AgentCommand[] = [
      command(AgentCommandType.SESSION_CREATE, 'create-1', {}),
      command(AgentCommandType.SESSION_READ, 'read-1', { sessionId }),
      command(AgentCommandType.SESSION_RESUME, 'resume-1', { sessionId }),
      command(AgentCommandType.SESSION_FORK, 'fork-1', { sessionId }),
      command(AgentCommandType.INPUT_SUBMIT, 'submit-1', {
        sessionId,
        input: 'hello',
      }),
      command(AgentCommandType.REQUEST_ABORT, 'abort-1', { sessionId }),
      command(AgentCommandType.PERMISSION_RESOLVE, 'permission-1', {
        sessionId,
        permissionRequestId: PermissionRequestId('approval-1'),
        approved: true,
      }),
      command(AgentCommandType.SESSION_CLOSE, 'close-1', { sessionId }),
    ];

    for (const agentCommand of commands) {
      await expect(server.execute(agentCommand, principal)).resolves.toMatchObject({
        ok: true,
        commandId: agentCommand.commandId,
      });
    }
    await server.close();

    expect(calls.map(({ method }) => method)).toEqual([
      'create',
      'read',
      'resume',
      'fork',
      'submit',
      'abort',
      'resolvePermission',
      'closeSession',
      'shutdown',
    ]);
    expect(calls.slice(0, -1).map(({ context }) => context?.commandId)).toEqual(
      commands.map(({ commandId }) => commandId),
    );
  });

  it('keeps AgentServer independent from Session implementation state', () => {
    const source = readFileSync(new URL('../AgentServer.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('../session/Session.js');
    expect(source).not.toContain('activeSessions');
  });

  it('passes the tenant-scoped runtime authority to a custom executor', async () => {
    const { executor, calls } = createExecutor();
    const tenantStore = {} as RuntimeTenantStore;
    const runtimeStore = Object.assign(new InMemoryAgentServerStore(), {
      forTenant: () => tenantStore,
    }) as unknown as RuntimeStore;
    const server = new AgentServer({ runtimeStore, sessionExecutor: executor });

    await expect(
      server.execute(
        command(AgentCommandType.SESSION_CREATE, 'create-runtime-store', {}),
        principal,
      ),
    ).resolves.toMatchObject({ ok: true });

    expect(calls[0]?.context?.runtimeStore).toBe(tenantStore);
    await server.close();
  });

  it('requires either an executor or a Session options resolver', () => {
    expect(() => new AgentServer({} as never)).toThrow(/sessionExecutor or resolveSessionOptions/);
  });
});
