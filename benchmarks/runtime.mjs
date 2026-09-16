import { platform, release } from 'node:os';
import { Pool } from 'pg';
import {
  AgentWorker,
} from '@blade-ai/agent-sdk/server/infra';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import {
  AGENT_PROTOCOL_VERSION,
  EventSequence,
  ExecutionLeaseId,
  SessionId,
  WorkerId,
} from '@blade-ai/agent-sdk';

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) {
  throw new Error('Set TEST_POSTGRES_URL to a disposable PostgreSQL database');
}

const sessionCount = Number(process.env.BENCHMARK_SESSIONS || 100);
const eventCount = Number(process.env.BENCHMARK_EVENTS || 1_000);
for (const [name, value] of [
  ['BENCHMARK_SESSIONS', sessionCount],
  ['BENCHMARK_EVENTS', eventCount],
]) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

const suffix = `${process.pid}_${Date.now()}`;
const schema = `blade_benchmark_${suffix}`;
const tenantId = `benchmark-${suffix}`;
const pool = new Pool({ connectionString });
const store = new PostgresRuntimeStore({
  pool,
  schema,
  tablePrefix: 'runtime',
  maxAgentEventsPerSession: Math.max(10_000, eventCount),
});

async function waitUntil(predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Benchmark condition did not settle within ${timeoutMs}ms`);
}

try {
  const initializationStartedAt = performance.now();
  await store.initialize();
  const storeInitializationMs = performance.now() - initializationStartedAt;

  const sessionIds = Array.from(
    { length: sessionCount },
    (_, index) => SessionId(`throughput-${suffix}-${index}`),
  );
  await Promise.all(
    sessionIds.map((sessionId) =>
      store.enqueueSession(tenantId, sessionId)),
  );

  const worker = new AgentWorker({
    store,
    workerId: WorkerId(`benchmark-worker-${suffix}`),
    tenantId,
    capacity: 8,
    sessionRunner: {
      async run(context) {
        await context.transition('running');
        return { status: 'completed' };
      },
    },
    workerTtlMs: 10_000,
    sessionLeaseTtlMs: 10_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 1,
    recoveryIntervalMs: 1_000,
  });
  const throughputStartedAt = performance.now();
  await worker.start();
  await waitUntil(
    () => worker.getSnapshot().metrics.sessionsCompleted === sessionCount,
  );
  const throughputDurationMs = performance.now() - throughputStartedAt;
  await worker.shutdown();

  const eventSessionId = SessionId(`events-${suffix}`);
  for (let index = 0; index < eventCount; index += 1) {
    await store.appendEvent(tenantId, eventSessionId, {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: eventSessionId,
      occurredAt: new Date().toISOString(),
      type: 'session.closed',
      data: { index },
    });
  }
  let after = 0;
  let eventsRead = 0;
  let contiguous = true;
  while (eventsRead < eventCount) {
    const page = await store.readEvents(tenantId, eventSessionId, {
      after,
      limit: 100,
    });
    for (const event of page.events) {
      const expected = eventsRead + 1;
      contiguous &&= event.sequence === expected;
      eventsRead += 1;
      after = event.sequence;
    }
    if (!page.hasMore) {
      break;
    }
  }

  const deadWorkerId = WorkerId(`dead-${suffix}`);
  const recoveryWorkerId = WorkerId(`recovery-${suffix}`);
  const recoverySessionId = SessionId(`recovery-${suffix}`);
  await store.registerWorker({
    workerId: deadWorkerId,
    capacity: 1,
    ttlMs: 200,
  });
  await store.enqueueSession(tenantId, recoverySessionId);
  const deadClaim = await store.claimSession({
    tenantId,
    ownerId: deadWorkerId,
    leaseId: ExecutionLeaseId(`dead-lease-${suffix}`),
    ttlMs: 200,
  });
  if (!deadClaim) {
    throw new Error('Benchmark failed to create an expiring Session claim');
  }
  await store.transitionSession(
    tenantId,
    deadClaim.lease,
    { expectedState: 'provisioning', state: 'running' },
  );
  await waitUntil(async () => {
    const result = await pool.query(
      'SELECT NOW() >= $1::timestamptz AS expired',
      [deadClaim.lease.expiresAt],
    );
    return result.rows[0]?.expired === true;
  });
  const recoveryStartedAt = performance.now();
  await store.recoverExpiredWork();
  await store.registerWorker({
    workerId: recoveryWorkerId,
    capacity: 1,
    ttlMs: 10_000,
  });
  const recovered = await store.claimSession({
    tenantId,
    ownerId: recoveryWorkerId,
    leaseId: ExecutionLeaseId(`recovery-lease-${suffix}`),
    ttlMs: 10_000,
  });
  const recoveryDurationMs = performance.now() - recoveryStartedAt;
  if (!recovered) {
    throw new Error('Benchmark recovery worker did not claim the Session');
  }
  await store.transitionSession(
    tenantId,
    recovered.lease,
    { expectedState: 'provisioning', state: 'failed' },
  );

  const workerMetrics = worker.getSnapshot().metrics;
  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${platform()} ${release()}`,
      postgres: (
        await pool.query('SHOW server_version')
      ).rows[0]?.server_version,
    },
    sampleSize: {
      sessions: sessionCount,
      events: eventCount,
    },
    metrics: {
      storeInitializationMs:
        Math.round(storeInitializationMs * 100) / 100,
      firstClaimLatencyMs: workerMetrics.firstClaimLatencyMs,
      sessionThroughputPerSecond:
        Math.round(
          (sessionCount / (throughputDurationMs / 1_000)) * 100,
        ) / 100,
      sessionCompletionDurationMs:
        Math.round(throughputDurationMs * 100) / 100,
      recoveryDurationMs:
        Math.round(recoveryDurationMs * 100) / 100,
      eventLossRate: contiguous
        ? (eventCount - eventsRead) / eventCount
        : 1,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    .catch(() => undefined);
  await pool.end();
}
