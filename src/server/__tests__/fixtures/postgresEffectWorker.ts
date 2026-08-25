import { once } from 'node:events';
import { writeSync } from 'node:fs';
import { Pool } from 'pg';
import {
  ExecutionLeaseId,
  WorkerId,
} from '../../../types/branded.js';
import { PostgresRuntimeStore } from '../../PostgresRuntimeStore.js';
import { effectLease } from '../../WorkerRuntime.js';

const [
  connectionString,
  schema,
  tablePrefix,
  tenantId,
  effectId,
  rawWorkerId,
  crashPoint,
] = process.argv.slice(2);

if (
  !connectionString
  || !schema
  || !tablePrefix
  || !tenantId
  || !effectId
  || !rawWorkerId
  || !crashPoint
  || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)
) {
  process.stderr.write(
    'Usage: postgresEffectWorker.ts <url> <schema> <prefix> '
      + '<tenant> <effect> <worker> <checkpoint>\n',
  );
  process.exit(2);
}

async function pause(checkpoint: string): Promise<never> {
  writeSync(process.stdout.fd, `checkpoint:${checkpoint}\n`);
  process.stdin.resume();
  await once(process.stdin, 'data');
  throw new Error('Kill-injection worker resumed unexpectedly');
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString });
  const workerId = WorkerId(rawWorkerId);
  const store = new PostgresRuntimeStore({
    pool,
    schema,
    tablePrefix,
  });
  try {
    await store.initialize();
    await store.registerWorker({
      workerId,
      capacity: 1,
      ttlMs: 1_000,
    });
    const [claim] = await store.claimEffects({
      tenantId,
      workerId,
      leaseId: ExecutionLeaseId(`effect-lease-${rawWorkerId}`),
      ttlMs: 1_000,
      limit: 1,
    });
    if (!claim || claim.effectId !== effectId) {
      throw new Error(`Effect ${effectId} was not claimed`);
    }
    if (crashPoint === 'after_claim') {
      await pause(crashPoint);
    }

    const lease = effectLease(claim);
    await store.startEffect(lease);
    if (crashPoint === 'after_start') {
      await pause(crashPoint);
    }

    await pool.query(
      `INSERT INTO "${schema}"."kill_effect_log" (
         effect_id, worker_id
       ) VALUES ($1, $2)`,
      [effectId, workerId],
    );
    if (crashPoint === 'after_side_effect') {
      await pause(crashPoint);
    }

    await store.completeEffect(lease, { delivered: true });
    await pause('after_complete');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  writeSync(
    process.stderr.fd,
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
