import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AgentCommandType, type AgentPrincipal } from '../../protocol/index.js';
import type { SessionId } from '../../types/branded.js';
import { AgentServer } from '../AgentServer.js';
import { PostgresRuntimeStore } from '../PostgresRuntimeStore.js';
import { assertRuntimeStoreConformance } from '../testing/RuntimeStoreConformance.js';

const connectionString = process.env.TEST_POSTGRES_URL;
const describePostgres = connectionString ? describe : describe.skip;
const schema = `blade_test_${process.pid}_${Date.now()}`;
const pool = connectionString ? new Pool({ connectionString }) : null;

const { createAgent } = vi.hoisted(() => ({
  createAgent: vi.fn(async () => ({
    async *streamChat() {
      yield { type: 'content_delta', delta: 'postgres-ok' };
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
  })),
}));

vi.mock('../../agent/Agent.js', () => ({
  Agent: { create: createAgent },
}));

const principal: AgentPrincipal = {
  tenantId: 'tenant-agent-server',
  subject: 'user-a',
  scopes: ['session:admin'],
};

describePostgres('PostgresRuntimeStore', () => {
  let store: PostgresRuntimeStore;

  beforeAll(async () => {
    if (!pool) {
      throw new Error('TEST_POSTGRES_URL is required');
    }
    store = new PostgresRuntimeStore({
      pool,
      schema,
      tablePrefix: 'runtime',
      maxAgentEventsPerSession: 100,
    });
    await store.initialize();
  });

  afterAll(async () => {
    if (!pool) {
      return;
    }
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('passes the public RuntimeStore conformance suite', async () => {
    const result = await assertRuntimeStoreConformance(store, {
      idPrefix: `postgres-${process.pid}`,
    });
    expect(result.checks).toEqual([
      'health',
      'session-projection',
      'tenant-isolation',
      'command-receipts',
      'agent-events',
      'durable-events',
      'atomic-runtime-commit',
      'transaction-rollback',
      'projection-checkpoint',
    ]);
  });

  it('rejects invalid transaction payloads before writing a receipt', async () => {
    const commandId = `invalid-${Date.now()}`;
    await expect(store.commitRuntimeTransaction({
      tenantId: 'tenant-invalid',
      sessionId: `session-${commandId}` as SessionId,
      command: {
        commandId,
        fingerprint: `fingerprint-${commandId}`,
        result: {
          protocolVersion: 1,
          commandId,
          ok: true,
          data: {},
        },
      },
      effects: [{
        effectId: `effect-${commandId}`,
        type: 'invalid',
        payload: { value: Number.NaN },
        idempotencyKey: `key-${commandId}`,
      }],
    })).rejects.toMatchObject({
      code: 'RUNTIME_STORE_INVALID_TRANSACTION',
    });
    await expect(store.claimCommand(
      'tenant-invalid',
      commandId,
      `fingerprint-${commandId}`,
      1000,
    )).resolves.toMatchObject({ status: 'claimed' });
  });

  it('maps duplicate event and effect identities to stable conflicts with rollback', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const tenantId = `tenant-conflict-${suffix}`;
    const seedSessionId = `session-seed-${suffix}` as SessionId;
    const duplicateEventId = `event-${suffix}`;
    const duplicateEffectKey = `effect-key-${suffix}`;
    await store.commitRuntimeTransaction({
      tenantId,
      sessionId: seedSessionId,
      command: {
        commandId: `seed-${suffix}`,
        fingerprint: `seed-fingerprint-${suffix}`,
        result: {
          protocolVersion: 1,
          commandId: `seed-${suffix}`,
          ok: true,
          data: {},
        },
      },
      expectedLastSequence: null,
      events: [{
        eventId: duplicateEventId,
        type: 'seeded',
        data: {},
      }],
      effects: [{
        effectId: `seed-effect-${suffix}`,
        type: 'seeded',
        payload: {},
        idempotencyKey: duplicateEffectKey,
      }],
    });

    for (const duplicate of ['event', 'effect'] as const) {
      const commandId = `duplicate-${duplicate}-${suffix}`;
      const sessionId = `session-${duplicate}-${suffix}` as SessionId;
      await expect(store.commitRuntimeTransaction({
        tenantId,
        sessionId,
        command: {
          commandId,
          fingerprint: `fingerprint-${commandId}`,
          result: {
            protocolVersion: 1,
            commandId,
            ok: true,
            data: {},
          },
        },
        expectedLastSequence: null,
        events: [{
          eventId: duplicate === 'event'
            ? duplicateEventId
            : `unique-event-${suffix}`,
          type: 'duplicate',
          data: { duplicate },
        }],
        effects: duplicate === 'effect'
          ? [{
              effectId: `effect-${suffix}`,
              type: 'duplicate',
              payload: {},
              idempotencyKey: duplicateEffectKey,
            }]
          : [],
      })).rejects.toMatchObject({
        code: 'RUNTIME_STORE_COMMAND_CONFLICT',
      });
      await expect(
        store.readDomainEvents(tenantId, sessionId),
      ).resolves.toMatchObject({ events: [] });
      await expect(store.claimCommand(
        tenantId,
        commandId,
        `fingerprint-${commandId}`,
        1000,
      )).resolves.toMatchObject({ status: 'claimed' });
    }
  });

  it('serializes concurrent schema initialization', async () => {
    if (!connectionString || !pool) {
      throw new Error('TEST_POSTGRES_URL is required');
    }
    const concurrentSchema = `${schema}_init`;
    const firstPool = new Pool({ connectionString });
    const secondPool = new Pool({ connectionString });
    const first = new PostgresRuntimeStore({
      pool: firstPool,
      schema: concurrentSchema,
      tablePrefix: 'runtime',
    });
    const second = new PostgresRuntimeStore({
      pool: secondPool,
      schema: concurrentSchema,
      tablePrefix: 'runtime',
    });
    try {
      await expect(Promise.all([
        first.initialize(),
        second.initialize(),
      ])).resolves.toEqual([undefined, undefined]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${concurrentSchema}" CASCADE`);
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  });

  it('runs AgentServer with one tenant-scoped PostgreSQL authority', async () => {
    const server = new AgentServer({
      runtimeStore: store,
      resolveSessionOptions: () => ({
        provider: {
          type: 'openai-compatible',
          apiKey: 'test-key',
        },
        model: 'test-model',
      }),
      requirePersistentSessions: true,
      eventPollIntervalMs: 5,
    });
    const created = await server.execute({
      protocolVersion: 1,
      commandId: 'postgres-create',
      type: AgentCommandType.SESSION_CREATE,
      data: {},
    }, principal);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    const sessionId = (
      created.data as { session: { sessionId: SessionId } }
    ).session.sessionId;
    const submitted = await server.execute({
      protocolVersion: 1,
      commandId: 'postgres-submit',
      type: AgentCommandType.INPUT_SUBMIT,
      data: { sessionId, input: 'hello' },
    }, principal);
    expect(submitted.ok).toBe(true);

    const events = [];
    for await (const event of server.events(principal, sessionId)) {
      events.push(event);
      if (event.type === 'session.stream' && event.data.type === 'result') {
        break;
      }
    }
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'session.stream',
        data: expect.objectContaining({
          type: 'content',
          delta: 'postgres-ok',
        }),
      }),
    ]));
    expect(
      await store.forTenant(principal.tenantId).loadState(sessionId),
    ).toMatchObject({
      sessionId,
      messages: expect.any(Array),
    });
    await server.close();
  });

  it('rejects Session-level persistence overrides when runtimeStore is set', async () => {
    const server = new AgentServer({
      runtimeStore: store,
      resolveSessionOptions: () => ({
        provider: {
          type: 'openai-compatible',
          apiKey: 'test-key',
        },
        model: 'test-model',
        sessionRepository: store.forTenant(principal.tenantId),
      }),
    });

    await expect(server.execute({
      protocolVersion: 1,
      commandId: `conflicting-store-${Date.now()}`,
      type: AgentCommandType.SESSION_CREATE,
      data: {},
    }, principal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'SESSION_CONFLICT' },
    });
    await server.close();
  });

  it('coordinates command claims and compare-and-append across Store instances', async () => {
    if (!connectionString) {
      throw new Error('TEST_POSTGRES_URL is required');
    }
    const secondPool = new Pool({ connectionString });
    const second = new PostgresRuntimeStore({
      pool: secondPool,
      schema,
      tablePrefix: 'runtime',
    });
    try {
      await second.initialize();
      const commandId = `shared-command-${Date.now()}`;
      const claims = await Promise.all([
        store.claimCommand(
          'tenant-shared',
          commandId,
          'fingerprint-shared',
          10_000,
        ),
        second.claimCommand(
          'tenant-shared',
          commandId,
          'fingerprint-shared',
          10_000,
        ),
      ]);
      expect(claims.map(({ status }) => status).sort()).toEqual([
        'claimed',
        'in_progress',
      ]);

      const sessionId = `shared-session-${Date.now()}` as SessionId;
      const makeCommit = (suffix: string) => ({
        tenantId: 'tenant-shared',
        sessionId,
        command: {
          commandId: `transaction-${suffix}`,
          fingerprint: `fingerprint-${suffix}`,
          result: {
            protocolVersion: 1 as const,
            commandId: `transaction-${suffix}`,
            ok: true as const,
            data: { committed: suffix },
          },
        },
        expectedLastSequence: null,
        events: [{ type: 'request.accepted', data: { source: suffix } }],
        effects: [{
          effectId: `effect-${suffix}`,
          type: 'tool.execute',
          payload: { source: suffix },
          idempotencyKey: `effect-${suffix}`,
        }],
        projection: {
          name: 'shared',
          expectedOffset: null,
          offset: 1,
          state: { source: suffix },
        },
      });
      const outcomes = await Promise.allSettled([
        store.commitRuntimeTransaction(makeCommit('a')),
        second.commitRuntimeTransaction(makeCommit('b')),
      ]);

      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      expect(
        (await store.readDomainEvents('tenant-shared', sessionId)).events,
      ).toHaveLength(1);
      expect(
        await store.listEffects('tenant-shared', { sessionId }),
      ).toHaveLength(1);
    } finally {
      await secondPool.end();
    }
  });
});
