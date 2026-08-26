import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {
  AGENT_PROTOCOL_VERSION,
  CommandId,
  ExecutionLeaseId,
  SessionId,
  WorkerId,
} from '@blade-ai/agent-sdk/core';
import { effectLease } from '@blade-ai/agent-sdk/server';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) {
  throw new Error('Set TEST_POSTGRES_URL to a disposable PostgreSQL database');
}

const root = dirname(fileURLToPath(import.meta.url));
const workerPath = join(root, 'fixtures/effect-worker.mjs');
const suffix = `${process.pid}_${Date.now()}`;
const schema = `blade_fault_benchmark_${suffix}`;
const tablePrefix = 'runtime';
const pool = new Pool({ connectionString });
const store = new PostgresRuntimeStore({
  pool,
  schema,
  tablePrefix,
});
const activeChildren = new Set();
const crashPoints = [
  {
    name: 'after_claim',
    expectedExecutions: 1,
    expectedStatus: 'completed',
  },
  {
    name: 'after_start',
    expectedExecutions: 0,
    expectedStatus: 'uncertain',
  },
  {
    name: 'after_side_effect',
    expectedExecutions: 1,
    expectedStatus: 'uncertain',
  },
  {
    name: 'after_complete',
    expectedExecutions: 1,
    expectedStatus: 'completed',
  },
];

function startWorker(tenantId, effectId, workerId, crashPoint) {
  const child = spawn(process.execPath, [
    workerPath,
    connectionString,
    schema,
    tablePrefix,
    tenantId,
    effectId,
    workerId,
    crashPoint,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const running = { child, closed: undefined };
  activeChildren.add(running);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      activeChildren.delete(running);
      if (signal === 'SIGKILL' || code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Fault worker exited unexpectedly (${String(code)}/${String(signal)}): ${stderr}`,
        ),
      );
    });
  });
  running.closed = closed;
  void closed.catch(() => undefined);
  return {
    child,
    closed,
    async waitForCheckpoint() {
      const deadline = Date.now() + 15_000;
      const expected = `checkpoint:${crashPoint}\n`;
      while (Date.now() < deadline) {
        if (stdout.includes(expected)) {
          return;
        }
        if (child.exitCode !== null) {
          throw new Error(
            `Fault worker exited before ${crashPoint}: ${stderr}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `Timed out waiting for ${crashPoint}; stdout=${stdout}; stderr=${stderr}`,
      );
    },
  };
}

async function waitForDatabaseTime(timestamp, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      'SELECT NOW() >= $1::timestamptz AS expired',
      [timestamp],
    );
    if (result.rows[0]?.expired === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Database clock did not reach ${timestamp}`);
}

async function runCrashPoint(config, index) {
  const tenantId = `fault-${config.name}-${suffix}`;
  const sessionId = SessionId(`session-${config.name}-${suffix}`);
  const effectId = `effect-${config.name}-${suffix}`;
  const commandId = CommandId(`command-${config.name}-${suffix}`);
  const childWorkerId = WorkerId(`worker-child-${config.name}-${suffix}`);
  await store.commitRuntimeTransaction({
    tenantId,
    sessionId,
    command: {
      commandId,
      fingerprint: `fingerprint-${commandId}`,
      result: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId,
        ok: true,
        data: {},
      },
    },
    effects: [{
      effectId,
      type: 'benchmark.non-idempotent',
      payload: { crashPoint: config.name },
      idempotencyKey: `key-${effectId}`,
      executionMode: 'at_most_once',
    }],
  });

  const running = startWorker(
    tenantId,
    effectId,
    childWorkerId,
    config.name,
  );
  await running.waitForCheckpoint();
  const failureInjectedAt = performance.now();
  running.child.kill('SIGKILL');
  await running.closed;

  const worker = await store.getWorker(childWorkerId);
  if (!worker) {
    throw new Error(`Worker ${childWorkerId} disappeared before recovery`);
  }
  await waitForDatabaseTime(worker.leaseExpiresAt);
  const scanStartedAt = performance.now();
  const recovery = await store.recoverExpiredWork();
  const scanCompletedAt = performance.now();

  const recoveryWorkerId = WorkerId(`worker-recovery-${index}-${suffix}`);
  await store.registerWorker({
    workerId: recoveryWorkerId,
    capacity: 1,
    ttlMs: 5_000,
  });
  const [claim] = await store.claimEffects({
    tenantId,
    workerId: recoveryWorkerId,
    leaseId: ExecutionLeaseId(`recovery-lease-${index}-${suffix}`),
    ttlMs: 5_000,
    limit: 1,
  });
  if (config.name === 'after_claim') {
    if (!claim || claim.effectId !== effectId) {
      throw new Error(`Effect ${effectId} was not reclaimed`);
    }
    const lease = effectLease(claim);
    await store.startEffect(lease);
    await pool.query(
      `INSERT INTO "${schema}"."fault_effect_log" (
         effect_id, worker_id
       ) VALUES ($1, $2)`,
      [effectId, recoveryWorkerId],
    );
    await store.completeEffect(lease, { delivered: true });
  } else if (claim) {
    throw new Error(`Effect ${effectId} was unexpectedly reclaimable`);
  }

  const recoveredAt = performance.now();
  const executionsResult = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM "${schema}"."fault_effect_log"
      WHERE effect_id = $1`,
    [effectId],
  );
  const executions = executionsResult.rows[0]?.count ?? 0;
  const [effect] = await store.listEffects(tenantId, { sessionId });
  const status = effect?.status;
  const duplicateExecutions = Math.max(
    0,
    executions - config.expectedExecutions,
  );
  const passed =
    executions === config.expectedExecutions
    && status === config.expectedStatus;

  return {
    crashPoint: config.name,
    expectedExecutions: config.expectedExecutions,
    executions,
    duplicateExecutions,
    expectedStatus: config.expectedStatus,
    status,
    passed,
    metrics: {
      failureDetectionMs:
        Math.round((scanCompletedAt - failureInjectedAt) * 100) / 100,
      recoveryScanMs:
        Math.round((scanCompletedAt - scanStartedAt) * 100) / 100,
      recoveryRtoMs:
        Math.round((recoveredAt - failureInjectedAt) * 100) / 100,
    },
    recovery,
  };
}

try {
  await store.initialize();
  await pool.query(
    `CREATE TABLE "${schema}"."fault_effect_log" (
       effect_id TEXT NOT NULL,
       worker_id TEXT NOT NULL,
       executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );

  const matrix = [];
  for (const [index, crashPoint] of crashPoints.entries()) {
    matrix.push(await runCrashPoint(crashPoint, index));
  }
  const totalExpectedExecutions = matrix.reduce(
    (total, result) => total + result.expectedExecutions,
    0,
  );
  const totalDuplicateExecutions = matrix.reduce(
    (total, result) => total + result.duplicateExecutions,
    0,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    sampleSize: {
      crashPoints: matrix.length,
      expectedExecutions: totalExpectedExecutions,
    },
    metrics: {
      passRate:
        matrix.filter((result) => result.passed).length / matrix.length,
      duplicateRate:
        totalExpectedExecutions === 0
          ? 0
          : totalDuplicateExecutions / totalExpectedExecutions,
      maximumRecoveryRtoMs: Math.max(
        ...matrix.map((result) => result.metrics.recoveryRtoMs),
      ),
    },
    matrix,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await Promise.allSettled(
    [...activeChildren].map(async ({ child, closed }) => {
      child.kill('SIGKILL');
      await closed;
    }),
  );
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    .catch(() => undefined);
  await pool.end();
}
