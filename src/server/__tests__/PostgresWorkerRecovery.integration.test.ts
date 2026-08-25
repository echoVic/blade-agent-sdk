import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ExecutionLeaseId,
  type SessionId,
  WorkerId,
} from '../../types/branded.js';
import { PostgresRuntimeStore } from '../PostgresRuntimeStore.js';
import { effectLease } from '../WorkerRuntime.js';

const connectionString = process.env.TEST_POSTGRES_URL;
const describePostgres = connectionString ? describe : describe.skip;
const schema = `blade_worker_${process.pid}_${Date.now()}`;
const tablePrefix = 'runtime';
const pool = connectionString ? new Pool({ connectionString }) : null;
const loaderUrl = pathToFileURL(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../session/events/__tests__/fixtures/sourceTypeScriptLoader.mjs',
  ),
).href;
const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/postgresEffectWorker.ts',
);

type CrashPoint =
  | 'after_claim'
  | 'after_start'
  | 'after_side_effect'
  | 'after_complete';

interface RunningChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  waitFor(marker: string): Promise<void>;
}

function startWorker(
  tenantId: string,
  effectId: string,
  workerId: string,
  crashPoint: CrashPoint,
): RunningChild {
  if (!connectionString) {
    throw new Error('TEST_POSTGRES_URL is required');
  }
  const child = spawn(process.execPath, [
    '--no-warnings',
    '--experimental-transform-types',
    '--loader',
    loaderUrl,
    workerPath,
    connectionString,
    schema,
    tablePrefix,
    tenantId,
    effectId,
    workerId,
    crashPoint,
  ]);
  let stdout = '';
  let stderr = '';
  const listeners = new Set<() => void>();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    for (const listener of listeners) {
      listener();
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal === 'SIGKILL' || code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `Worker exited unexpectedly (${String(code)}/${String(signal)}): ${stderr}`,
      ));
    });
  });
  void closed.catch(() => undefined);
  return {
    child,
    closed,
    waitFor(marker: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const expected = `checkpoint:${marker}\n`;
        const timeout = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(
            `Timed out waiting for ${expected.trim()}; stdout=${stdout}; stderr=${stderr}`,
          ));
        }, 15_000);
        const check = () => {
          if (!stdout.includes(expected)) {
            return;
          }
          clearTimeout(timeout);
          listeners.delete(check);
          resolve();
        };
        listeners.add(check);
        check();
      });
    },
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describePostgres('Postgres worker crash recovery', () => {
  let store: PostgresRuntimeStore;
  const children = new Set<RunningChild>();

  beforeAll(async () => {
    if (!pool) {
      throw new Error('TEST_POSTGRES_URL is required');
    }
    store = new PostgresRuntimeStore({ pool, schema, tablePrefix });
    await store.initialize();
    await pool.query(
      `CREATE TABLE "${schema}"."kill_effect_log" (
         effect_id TEXT NOT NULL,
         worker_id TEXT NOT NULL,
         executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
  });

  afterAll(async () => {
    for (const running of children) {
      running.child.kill('SIGKILL');
    }
    await Promise.all(Array.from(children, ({ closed }) =>
      closed.catch(() => undefined)));
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  it.each([
    ['after_claim', 1, 'completed'],
    ['after_start', 0, 'uncertain'],
    ['after_side_effect', 1, 'uncertain'],
    ['after_complete', 1, 'completed'],
  ] as const)(
    'does not duplicate an at-most-once effect when killed %s',
    async (crashPoint, expectedExecutions, expectedStatus) => {
      if (!pool) {
        throw new Error('TEST_POSTGRES_URL is required');
      }
      const suffix = `${crashPoint}-${Date.now()}`;
      const tenantId = `tenant-${suffix}`;
      const sessionId = `session-${suffix}` as SessionId;
      const effectId = `effect-${suffix}`;
      const commandId = `command-${suffix}`;
      await store.commitRuntimeTransaction({
        tenantId,
        sessionId,
        command: {
          commandId,
          fingerprint: `fingerprint-${suffix}`,
          result: {
            protocolVersion: 1,
            commandId,
            ok: true,
            data: {},
          },
        },
        effects: [{
          effectId,
          type: 'non-idempotent-test',
          payload: { crashPoint },
          idempotencyKey: `key-${suffix}`,
          executionMode: 'at_most_once',
        }],
      });

      const childWorkerId = `worker-child-${suffix}`;
      const running = startWorker(
        tenantId,
        effectId,
        childWorkerId,
        crashPoint,
      );
      children.add(running);
      await running.waitFor(crashPoint);
      const closed = running.closed;
      running.child.kill('SIGKILL');
      await closed;
      children.delete(running);

      await delay(1_200);
      await store.recoverExpiredWork();

      const recoveryWorkerId = WorkerId(`worker-recovery-${suffix}`);
      await store.registerWorker({
        workerId: recoveryWorkerId,
        capacity: 1,
        ttlMs: 5_000,
      });
      const [claim] = await store.claimEffects({
        tenantId,
        workerId: recoveryWorkerId,
        leaseId: ExecutionLeaseId(`recovery-lease-${suffix}`),
        ttlMs: 5_000,
        limit: 1,
      });
      if (crashPoint === 'after_claim') {
        expect(claim?.effectId).toBe(effectId);
        if (!claim) {
          throw new Error('Expected the unstarted effect to be reclaimed');
        }
        const lease = effectLease(claim);
        await store.startEffect(lease);
        await pool.query(
          `INSERT INTO "${schema}"."kill_effect_log" (
             effect_id, worker_id
           ) VALUES ($1, $2)`,
          [effectId, recoveryWorkerId],
        );
        await store.completeEffect(lease, { delivered: true });
      } else {
        expect(claim).toBeUndefined();
      }

      const executions = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM "${schema}"."kill_effect_log"
          WHERE effect_id = $1`,
        [effectId],
      );
      expect(executions.rows[0]?.count).toBe(expectedExecutions);
      const [effect] = await store.listEffects(tenantId, { sessionId });
      expect(effect).toMatchObject({
        effectId,
        executionMode: 'at_most_once',
        status: expectedStatus,
      });
    },
    30_000,
  );
});
