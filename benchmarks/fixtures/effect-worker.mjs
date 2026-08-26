import { writeSync } from 'node:fs';
import { Pool } from 'pg';
import {
  ExecutionLeaseId,
  WorkerId,
} from '@blade-ai/agent-sdk/core';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { effectLease } from '@blade-ai/agent-sdk/server';

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
  || ![
    'after_claim',
    'after_start',
    'after_side_effect',
    'after_complete',
  ].includes(crashPoint)
  || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)
) {
  throw new Error(
    'Usage: effect-worker.mjs <url> <schema> <prefix> '
      + '<tenant> <effect> <worker> <crash-point>',
  );
}

async function pause(checkpoint) {
  writeSync(process.stdout.fd, `checkpoint:${checkpoint}\n`);
  await new Promise(() => {
    setInterval(() => undefined, 60_000);
  });
  throw new Error('Fault-injection worker resumed unexpectedly');
}

const workerId = WorkerId(rawWorkerId);
const pool = new Pool({ connectionString });
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
    `INSERT INTO "${schema}"."fault_effect_log" (
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
