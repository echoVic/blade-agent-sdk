import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentCommandType, type AgentPrincipal } from '../../protocol/index.js';
import { createSession } from '../../session/Session.js';
import { DurableExecutionLease } from '../../session/events/DurableExecutionLease.js';
import {
  CommandId,
  EventId,
  ExecutionLeaseId,
  SessionId,
  WorkerId,
} from '../../types/identifiers.js';
import { AgentServer } from '../AgentServer.js';
import { AgentRuntimeOperations } from '../AgentRuntimeOperations.js';
import { AgentWorker } from '../AgentWorker.js';
import {
  EffectDispatcher,
  UncertainRuntimeEffectError,
} from '../EffectDispatcher.js';
import { PostgresRuntimeStore } from '../PostgresRuntimeStore.js';
import { SdkSessionRunner } from '../SdkSessionRunner.js';
import { assertRuntimeStoreConformance } from '../testing/RuntimeStoreConformance.js';
import { effectLease } from '../WorkerRuntime.js';

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
      'queue-metrics',
      'worker-routing',
      'worker-recovery',
      'effect-delivery',
    ]);
  });

  it('rejects invalid transaction payloads before writing a receipt', async () => {
    const commandId = CommandId(`invalid-${Date.now()}`);
    await expect(
      store.commitRuntimeTransaction({
        tenantId: 'tenant-invalid',
        sessionId: SessionId(`session-${commandId}`),
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
        effects: [
          {
            effectId: `effect-${commandId}`,
            type: 'invalid',
            payload: { value: Number.NaN },
            idempotencyKey: `key-${commandId}`,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'RUNTIME_STORE_INVALID_TRANSACTION',
    });
    await expect(
      store.claimCommand('tenant-invalid', commandId, `fingerprint-${commandId}`, 1000),
    ).resolves.toMatchObject({ status: 'claimed' });
  });

  it('uses the database clock for immediately available effects', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const tenantId = `tenant-database-clock-${suffix}`;
    const workerId = WorkerId(`worker-database-clock-${suffix}`);
    const sessionId = SessionId(`session-database-clock-${suffix}`);
    const commandId = CommandId(`command-database-clock-${suffix}`);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2035-01-01T00:00:00.000Z'));
    try {
      await store.commitRuntimeTransaction({
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
        effects: [
          {
            effectId: `effect-${suffix}`,
            type: 'database-clock',
            payload: {},
            idempotencyKey: `effect-key-${suffix}`,
          },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
    await store.registerWorker({
      workerId,
      capacity: 1,
      ttlMs: 10_000,
    });

    await expect(
      store.claimEffects({
        tenantId,
        workerId,
        ttlMs: 10_000,
        limit: 1,
      }),
    ).resolves.toHaveLength(1);
  });

  it('maps duplicate event and effect identities to stable conflicts with rollback', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const tenantId = `tenant-conflict-${suffix}`;
    const seedSessionId = SessionId(`session-seed-${suffix}`);
    const duplicateEventId = EventId(`event-${suffix}`);
    const duplicateEffectKey = `effect-key-${suffix}`;
    const seedCommandId = CommandId(`seed-${suffix}`);
    await store.commitRuntimeTransaction({
      tenantId,
      sessionId: seedSessionId,
      command: {
        commandId: seedCommandId,
        fingerprint: `seed-fingerprint-${suffix}`,
        result: {
          protocolVersion: 1,
          commandId: seedCommandId,
          ok: true,
          data: {},
        },
      },
      expectedLastSequence: null,
      events: [
        {
          eventId: duplicateEventId,
          type: 'seeded',
          data: {},
        },
      ],
      effects: [
        {
          effectId: `seed-effect-${suffix}`,
          type: 'seeded',
          payload: {},
          idempotencyKey: duplicateEffectKey,
        },
      ],
    });

    for (const duplicate of ['event', 'effect'] as const) {
      const commandId = CommandId(`duplicate-${duplicate}-${suffix}`);
      const sessionId = SessionId(`session-${duplicate}-${suffix}`);
      await expect(
        store.commitRuntimeTransaction({
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
          events: [
            {
              eventId: duplicate === 'event' ? duplicateEventId : EventId(`unique-event-${suffix}`),
              type: 'duplicate',
              data: { duplicate },
            },
          ],
          effects:
            duplicate === 'effect'
              ? [
                  {
                    effectId: `effect-${suffix}`,
                    type: 'duplicate',
                    payload: {},
                    idempotencyKey: duplicateEffectKey,
                  },
                ]
              : [],
        }),
      ).rejects.toMatchObject({
        code: 'RUNTIME_STORE_COMMAND_CONFLICT',
      });
      await expect(store.readDomainEvents(tenantId, sessionId)).resolves.toMatchObject({
        events: [],
      });
      await expect(
        store.claimCommand(tenantId, commandId, `fingerprint-${commandId}`, 1000),
      ).resolves.toMatchObject({ status: 'claimed' });
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
      await expect(Promise.all([first.initialize(), second.initialize()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${concurrentSchema}" CASCADE`);
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  });

  it('migrates a v1 Runtime Store schema without metadata in place', async () => {
    if (!pool) {
      throw new Error('TEST_POSTGRES_URL is required');
    }
    const migrationSchema = `${schema}_migration`;
    await pool.query(`
      CREATE SCHEMA "${migrationSchema}";
      CREATE TABLE "${migrationSchema}"."runtime_metadata" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE "${migrationSchema}"."runtime_outbox" (
        tenant_id TEXT NOT NULL,
        effect_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        effect_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        result JSONB,
        error JSONB,
        PRIMARY KEY (tenant_id, effect_id),
        UNIQUE (tenant_id, idempotency_key)
      );
    `);
    const migrated = new PostgresRuntimeStore({
      pool,
      schema: migrationSchema,
      tablePrefix: 'runtime',
    });
    try {
      await migrated.initialize();
      await migrated.registerWorker({
        workerId: WorkerId('migration-worker'),
        capacity: 1,
        ttlMs: 10_000,
      });
      const version = await pool.query(
        `SELECT value
           FROM "${migrationSchema}"."runtime_metadata"
          WHERE key = 'schema_version'`,
      );
      const columns = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'runtime_outbox'`,
        [migrationSchema],
      );
      expect(version.rows[0]?.value).toBe('3');
      expect(columns.rows.map(({ column_name }) => column_name)).toEqual(
        expect.arrayContaining([
          'execution_mode',
          'worker_id',
          'lease_id',
          'fencing_token',
          'lease_expires_at',
          'started_at',
          'completed_at',
        ]),
      );
      const commandId = CommandId(`migration-command-${Date.now()}`);
      const sessionId = SessionId(`migration-session-${Date.now()}`);
      await migrated.commitRuntimeTransaction({
        tenantId: 'migration-tenant',
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
        effects: [{
          effectId: `migration-effect-${Date.now()}`,
          type: 'migration-check',
          payload: {},
          idempotencyKey: `migration-key-${Date.now()}`,
          executionMode: 'at_most_once',
        }],
      });
      const [claim] = await migrated.claimEffects({
        tenantId: 'migration-tenant',
        workerId: WorkerId('migration-worker'),
        ttlMs: 10_000,
        limit: 1,
      });
      expect(claim).toBeDefined();
      if (!claim) {
        throw new Error('Migrated outbox effect was not claimed');
      }
      await expect(
        migrated.startEffect(effectLease(claim)),
      ).resolves.toMatchObject({ status: 'executing' });
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
    }
  });

  it('migrates v2 Session routes to support the idle state', async () => {
    if (!pool) {
      throw new Error('TEST_POSTGRES_URL is required');
    }
    const migrationSchema = `${schema}_migration_v2`;
    const original = new PostgresRuntimeStore({
      pool,
      schema: migrationSchema,
      tablePrefix: 'runtime',
    });
    await original.initialize();
    const constraints = await pool.query(
      `SELECT constraint_row.conname
         FROM pg_constraint constraint_row
         JOIN LATERAL unnest(constraint_row.conkey)
           AS column_number(attnum) ON TRUE
         JOIN pg_attribute attribute
           ON attribute.attrelid = constraint_row.conrelid
          AND attribute.attnum = column_number.attnum
        WHERE constraint_row.conrelid =
              '"${migrationSchema}"."runtime_session_routes"'::regclass
          AND constraint_row.contype = 'c'
          AND attribute.attname = 'state'`,
    );
    for (const { conname } of constraints.rows) {
      await pool.query(
        `ALTER TABLE "${migrationSchema}"."runtime_session_routes"
           DROP CONSTRAINT "${conname}"`,
      );
    }
    await pool.query(`
      ALTER TABLE "${migrationSchema}"."runtime_session_routes"
        ADD CONSTRAINT runtime_session_routes_state_check CHECK (
          state IN (
            'queued', 'provisioning', 'running', 'waiting_approval',
            'suspended', 'completed', 'failed'
          )
        );
      UPDATE "${migrationSchema}"."runtime_metadata"
         SET value = '2'
       WHERE key = 'schema_version';
    `);

    const migrated = new PostgresRuntimeStore({
      pool,
      schema: migrationSchema,
      tablePrefix: 'runtime',
    });
    try {
      await migrated.initialize();
      const workerId = WorkerId('migration-v2-worker');
      const sessionId = SessionId('migration-v2-session');
      await migrated.registerWorker({
        workerId,
        capacity: 1,
        ttlMs: 10_000,
      });
      await migrated.enqueueSession('migration-v2-tenant', sessionId);
      const claim = await migrated.claimSession({
        tenantId: 'migration-v2-tenant',
        ownerId: workerId,
        leaseId: ExecutionLeaseId('migration-v2-lease'),
        ttlMs: 10_000,
      });
      expect(claim).not.toBeNull();
      if (!claim) {
        throw new Error('Migrated Session route was not claimed');
      }
      await migrated.transitionSession(
        'migration-v2-tenant',
        claim.lease,
        { expectedState: 'provisioning', state: 'running' },
      );
      await expect(
        migrated.transitionSession(
          'migration-v2-tenant',
          claim.lease,
          { expectedState: 'running', state: 'idle' },
        ),
      ).resolves.toMatchObject({ state: 'idle' });
      const version = await pool.query(
        `SELECT value
           FROM "${migrationSchema}"."runtime_metadata"
          WHERE key = 'schema_version'`,
      );
      expect(version.rows[0]?.value).toBe('3');
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
    }
  });

  it('keeps fenced persistence reentrant with a single-connection Pool', async () => {
    if (!connectionString) {
      throw new Error('TEST_POSTGRES_URL is required');
    }
    const singlePool = new Pool({ connectionString, max: 1 });
    const singleStore = new PostgresRuntimeStore({
      pool: singlePool,
      schema,
      tablePrefix: 'runtime',
    });
    const sessionId = SessionId(`single-pool-${Date.now()}`);
    const tenantId = 'tenant-single-pool';
    const tenantStore = singleStore.forTenant(tenantId);
    const seedCommandId = CommandId(`single-pool-seed-${Date.now()}`);
    const duplicateEffectId = `single-pool-effect-${Date.now()}`;
    await singleStore.commitRuntimeTransaction({
      tenantId,
      sessionId,
      command: {
        commandId: seedCommandId,
        fingerprint: `fingerprint-${seedCommandId}`,
        result: {
          protocolVersion: 1,
          commandId: seedCommandId,
          ok: true,
          data: {},
        },
      },
      effects: [{
        effectId: duplicateEffectId,
        type: 'seed',
        payload: {},
        idempotencyKey: `key-${duplicateEffectId}`,
      }],
    });
    const lease = await DurableExecutionLease.acquire(
      tenantStore,
      sessionId,
      {
        ownerId: WorkerId('worker-single-pool'),
        leaseId: ExecutionLeaseId(`lease-${sessionId}`),
        ttlMs: 1_000,
        heartbeatIntervalMs: 250,
        storeTimeoutMs: 500,
      },
    );
    try {
      await lease.runFenced(async () => {
        const conflictingCommandId = CommandId(`single-pool-conflict-${Date.now()}`);
        await expect(singleStore.commitRuntimeTransaction({
          tenantId,
          sessionId,
          command: {
            commandId: conflictingCommandId,
            fingerprint: `fingerprint-${conflictingCommandId}`,
            result: {
              protocolVersion: 1,
              commandId: conflictingCommandId,
              ok: true,
              data: {},
            },
          },
          effects: [{
            effectId: duplicateEffectId,
            type: 'duplicate',
            payload: {},
            idempotencyKey: `different-${duplicateEffectId}`,
          }],
        })).rejects.toMatchObject({
          code: 'RUNTIME_STORE_COMMAND_CONFLICT',
        });
        await tenantStore.createSession(sessionId);
      });
      await expect(tenantStore.loadState(sessionId)).resolves.toMatchObject({
        sessionId,
      });
    } finally {
      await lease.release();
      await singlePool.end();
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
    const created = await server.execute(
      {
        protocolVersion: 1,
        commandId: CommandId('postgres-create'),
        type: AgentCommandType.SESSION_CREATE,
        data: {},
      },
      principal,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    const sessionId = (created.data as { session: { sessionId: SessionId } }).session.sessionId;
    const submitted = await server.execute(
      {
        protocolVersion: 1,
        commandId: CommandId('postgres-submit'),
        type: AgentCommandType.INPUT_SUBMIT,
        data: { sessionId, input: 'hello' },
      },
      principal,
    );
    expect(submitted.ok).toBe(true);

    const events = [];
    for await (const event of server.events(principal, sessionId)) {
      events.push(event);
      if (event.type === 'session.stream' && event.data.type === 'result') {
        break;
      }
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'session.stream',
          data: expect.objectContaining({
            type: 'content',
            delta: 'postgres-ok',
          }),
        }),
      ]),
    );
    expect(await store.forTenant(principal.tenantId).loadState(sessionId)).toMatchObject({
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

    await expect(
      server.execute(
        {
          protocolVersion: 1,
          commandId: CommandId(`conflicting-store-${Date.now()}`),
          type: AgentCommandType.SESSION_CREATE,
          data: {},
        },
        principal,
      ),
    ).resolves.toMatchObject({
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
      const commandId = CommandId(`shared-command-${Date.now()}`);
      const claims = await Promise.all([
        store.claimCommand('tenant-shared', commandId, 'fingerprint-shared', 10_000),
        second.claimCommand('tenant-shared', commandId, 'fingerprint-shared', 10_000),
      ]);
      expect(claims.map(({ status }) => status).sort()).toEqual(['claimed', 'in_progress']);

      const sessionId = SessionId(`shared-session-${Date.now()}`);
      const makeCommit = (suffix: string) => {
        const transactionCommandId = CommandId(`transaction-${suffix}`);
        return {
          tenantId: 'tenant-shared',
          sessionId,
          command: {
            commandId: transactionCommandId,
            fingerprint: `fingerprint-${suffix}`,
            result: {
              protocolVersion: 1 as const,
              commandId: transactionCommandId,
              ok: true as const,
              data: { committed: suffix },
            },
          },
          expectedLastSequence: null,
          events: [{ type: 'request.accepted', data: { source: suffix } }],
          effects: [
            {
              effectId: `effect-${suffix}`,
              type: 'tool.execute',
              payload: { source: suffix },
              idempotencyKey: `effect-${suffix}`,
            },
          ],
          projection: {
            name: 'shared',
            expectedOffset: null,
            offset: 1,
            state: { source: suffix },
          },
        };
      };
      const outcomes = await Promise.allSettled([
        store.commitRuntimeTransaction(makeCommit('a')),
        second.commitRuntimeTransaction(makeCommit('b')),
      ]);

      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      expect((await store.readDomainEvents('tenant-shared', sessionId)).events).toHaveLength(1);
      expect(await store.listEffects('tenant-shared', { sessionId })).toHaveLength(1);
    } finally {
      await secondPool.end();
    }
  });

  it('claims each Session and effect only once across Store instances', async () => {
    if (!connectionString) {
      throw new Error('TEST_POSTGRES_URL is required');
    }
    const secondPool = new Pool({ connectionString });
    const second = new PostgresRuntimeStore({
      pool: secondPool,
      schema,
      tablePrefix: 'runtime',
    });
    const suffix = `scheduler-${Date.now()}`;
    const tenantId = `tenant-${suffix}`;
    const sessionId = SessionId(`session-${suffix}`);
    const firstWorkerId = WorkerId(`worker-a-${suffix}`);
    const secondWorkerId = WorkerId(`worker-b-${suffix}`);
    try {
      await second.initialize();
      await Promise.all([
        store.registerWorker({
          workerId: firstWorkerId,
          capacity: 1,
          ttlMs: 10_000,
        }),
        second.registerWorker({
          workerId: secondWorkerId,
          capacity: 1,
          ttlMs: 10_000,
        }),
      ]);
      await store.enqueueSession(tenantId, sessionId);
      const sessionClaims = await Promise.all([
        store.claimSession({
          tenantId,
          ownerId: firstWorkerId,
          leaseId: ExecutionLeaseId(`lease-a-${suffix}`),
          ttlMs: 10_000,
        }),
        second.claimSession({
          tenantId,
          ownerId: secondWorkerId,
          leaseId: ExecutionLeaseId(`lease-b-${suffix}`),
          ttlMs: 10_000,
        }),
      ]);
      expect(sessionClaims.filter((claim) => claim !== null)).toHaveLength(1);

      const effectCommandId = CommandId(`effect-command-${suffix}`);
      await store.commitRuntimeTransaction({
        tenantId,
        sessionId,
        command: {
          commandId: effectCommandId,
          fingerprint: `fingerprint-${effectCommandId}`,
          result: {
            protocolVersion: 1,
            commandId: effectCommandId,
            ok: true,
            data: {},
          },
        },
        effects: [{
          effectId: `effect-${suffix}`,
          type: 'concurrent',
          payload: {},
          idempotencyKey: `effect-key-${suffix}`,
        }],
      });
      const effectClaims = await Promise.all([
        store.claimEffects({
          tenantId,
          workerId: firstWorkerId,
          ttlMs: 10_000,
          limit: 1,
        }),
        second.claimEffects({
          tenantId,
          workerId: secondWorkerId,
          ttlMs: 10_000,
          limit: 1,
        }),
      ]);
      expect(effectClaims.flat()).toHaveLength(1);
    } finally {
      await secondPool.end();
    }
  });

  it('reports tenant-scoped queue metrics with global worker capacity', async () => {
    const suffix = `metrics-${Date.now()}`;
    const tenantId = `tenant-${suffix}`;
    const otherTenantId = `tenant-other-${suffix}`;
    const workerId = WorkerId(`worker-${suffix}`);
    await store.registerWorker({
      workerId,
      capacity: 3,
      ttlMs: 60_000,
    });
    await Promise.all([
      store.enqueueSession(tenantId, SessionId(`session-a-${suffix}`)),
      store.enqueueSession(tenantId, SessionId(`session-b-${suffix}`)),
      store.enqueueSession(otherTenantId, SessionId(`session-other-${suffix}`)),
    ]);
    const commandId = CommandId(`command-${suffix}`);
    await store.commitRuntimeTransaction({
      tenantId,
      sessionId: SessionId(`effect-session-${suffix}`),
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
        effectId: `effect-${suffix}`,
        type: 'metrics',
        payload: {},
        idempotencyKey: `effect-${suffix}`,
      }],
    });

    const metrics = await store.getQueueMetrics(tenantId);

    expect(metrics).toMatchObject({
      tenantId,
      sessions: {
        counts: { queued: 2 },
        claimable: 2,
      },
      effects: {
        counts: { pending: 1 },
        claimable: 1,
      },
      workers: {
        counts: {
          active: expect.any(Number),
          draining: expect.any(Number),
          offline: expect.any(Number),
        },
        capacity: expect.any(Number),
        activeSessions: expect.any(Number),
        availableCapacity: expect.any(Number),
      },
    });
    expect(metrics.sessions.oldestClaimableAgeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.effects.oldestClaimableAgeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.workers.capacity).toBeGreaterThanOrEqual(3);

    const claimed = await store.claimSession({
      tenantId,
      ownerId: workerId,
      leaseId: ExecutionLeaseId(`metrics-lease-${suffix}`),
      ttlMs: 60_000,
    });
    expect(claimed).not.toBeNull();
    const claimedMetrics = await store.getQueueMetrics(tenantId);
    expect(claimedMetrics.workers.activeSessions).toBe(
      metrics.workers.activeSessions + 1,
    );
    expect(claimedMetrics.workers.availableCapacity).toBe(
      metrics.workers.availableCapacity - 1,
    );

    await store.drainWorker(workerId);
    const drainingMetrics = await store.getQueueMetrics(tenantId);
    expect(drainingMetrics.workers.capacity).toBe(
      claimedMetrics.workers.capacity - 3,
    );
    expect(drainingMetrics.workers.activeSessions).toBe(
      claimedMetrics.workers.activeSessions - 1,
    );
  });

  it('dispatches persisted effects with explicit terminal outcomes', async () => {
    const suffix = `dispatcher-${Date.now()}`;
    const tenantId = `tenant-${suffix}`;
    const sessionId = SessionId(`session-${suffix}`);
    const commandId = CommandId(`command-${suffix}`);
    const workerId = WorkerId(`worker-${suffix}`);
    await store.registerWorker({
      workerId,
      capacity: 1,
      ttlMs: 10_000,
    });
    await store.commitRuntimeTransaction({
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
      effects: [
        {
          effectId: `complete-${suffix}`,
          type: 'complete',
          payload: {},
          idempotencyKey: `complete-${suffix}`,
        },
        {
          effectId: `uncertain-${suffix}`,
          type: 'uncertain',
          payload: {},
          idempotencyKey: `uncertain-${suffix}`,
          executionMode: 'at_most_once',
        },
      ],
    });
    const dispatcher = new EffectDispatcher({
      store,
      workerId,
      tenantId,
      claimLimit: 2,
      handlers: [
        {
          type: 'complete',
          async execute() {
            return { delivered: true };
          },
        },
        {
          type: 'uncertain',
          async execute() {
            throw new UncertainRuntimeEffectError('receipt unavailable');
          },
        },
      ],
    });

    await expect(dispatcher.runOnce()).resolves.toBe(2);
    await expect(dispatcher.runOnce()).resolves.toBe(0);
    await expect(store.listEffects(tenantId, { sessionId })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectId: `complete-${suffix}`,
          status: 'completed',
          attempts: 1,
        }),
        expect.objectContaining({
          effectId: `uncertain-${suffix}`,
          status: 'uncertain',
          attempts: 1,
        }),
      ]),
    );

    const operations = new AgentRuntimeOperations({
      store,
      authorize: () => ({ tenantId, subject: 'operator' }),
    });
    const listResponse = await operations.handle(
      new Request('http://localhost/v1/runtime/effects/uncertain'),
    );
    const listed = (await listResponse.json()) as {
      effects: Record<string, unknown>[];
    };
    expect(listResponse.status).toBe(200);
    expect(listed.effects).toEqual([
      expect.objectContaining({
        effectId: `uncertain-${suffix}`,
        status: 'uncertain',
      }),
    ]);
    expect(listed.effects[0]).not.toHaveProperty('payload');

    const reconcileResponse = await operations.handle(
      new Request(
        `http://localhost/v1/runtime/effects/uncertain-${suffix}/reconcile`,
        {
          method: 'POST',
          body: JSON.stringify({
            status: 'completed',
            result: { receiptId: `receipt-${suffix}` },
          }),
        },
      ),
    );
    expect(reconcileResponse.status).toBe(200);
    await expect(
      store.listEffects(tenantId, {
        sessionId,
        status: 'completed',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectId: `uncertain-${suffix}`,
          status: 'completed',
          result: { receiptId: `receipt-${suffix}` },
        }),
      ]),
    );
  });

  it('runs an accepted durable Session request through AgentWorker', async () => {
    const tenantId = `tenant-sdk-worker-${Date.now()}`;
    const tenantStore = store.forTenant(tenantId);
    const session = await createSession({
      provider: {
        type: 'openai-compatible',
        apiKey: 'test-key',
      },
      model: 'test-model',
      sessionRepository: tenantStore,
      sessionEventStore: tenantStore,
      durableEventStore: tenantStore,
      allowedTools: [],
    });
    await session.send('run on a worker');
    await session.suspendForHandoff();
    await store.enqueueSession(tenantId, session.sessionId);

    const workerErrors: unknown[] = [];
    const worker = new AgentWorker({
      store,
      workerId: WorkerId(`sdk-worker-${Date.now()}`),
      capacity: 1,
      tenantId,
      sessionRunner: new SdkSessionRunner({
        resolveSessionOptions: () => ({
          provider: {
            type: 'openai-compatible',
            apiKey: 'test-key',
          },
          model: 'test-model',
          allowedTools: [],
        }),
      }),
      workerTtlMs: 5_000,
      sessionLeaseTtlMs: 5_000,
      heartbeatIntervalMs: 500,
      pollIntervalMs: 10,
      recoveryIntervalMs: 500,
      onError: (error) => workerErrors.push(error),
    });
    await worker.start();
    try {
      try {
        await vi.waitFor(
          async () => {
            await expect(
              store.getSessionRoute(tenantId, session.sessionId),
            ).resolves.toMatchObject({ state: 'idle' });
          },
          { timeout: 10_000 },
        );
      } catch (error) {
        throw new AggregateError([error, ...workerErrors]);
      }
    } finally {
      await worker.shutdown();
    }

    const durable = await tenantStore.read(session.sessionId);
    expect(durable.events.some(({ type }) => type === 'request_completed')).toBe(true);
    expect(worker.getSnapshot().metrics.sessionsIdle).toBe(1);
  });
});
