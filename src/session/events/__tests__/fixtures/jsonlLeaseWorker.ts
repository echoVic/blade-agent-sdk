import { once } from 'node:events';
import { writeSync } from 'node:fs';
import { ExecutionLeaseId, SessionId, WorkerId } from '../../../../types/branded.js';
import { JsonlDurableEventStore } from '../../JsonlDurableEventStore.js';

const [storageRoot, rawSessionId, workerId, leaseId, rawTtlMs = '30000'] = process.argv.slice(2);
const ttlMs = Number(rawTtlMs);

if (
  !storageRoot ||
  !rawSessionId ||
  !workerId ||
  !leaseId ||
  !Number.isSafeInteger(ttlMs) ||
  ttlMs <= 0
) {
  process.stderr.write(
    'Usage: jsonlLeaseWorker.ts <storage-root> <session-id> <worker-id> <lease-id> [ttl-ms]\n',
  );
  process.exit(2);
}

function errorField(error: unknown, field: string): unknown {
  return typeof error === 'object' && error !== null && field in error
    ? error[field as keyof typeof error]
    : undefined;
}

async function main(): Promise<void> {
  const store = new JsonlDurableEventStore(storageRoot);
  const startSignal = once(process.stdin, 'data');
  writeSync(process.stdout.fd, 'ready\n');
  await startSignal;
  process.stdin.destroy();

  try {
    const lease = await store.acquireExecutionLease(SessionId(rawSessionId), {
      ownerId: WorkerId(workerId),
      leaseId: ExecutionLeaseId(leaseId),
      ttlMs,
    });
    writeSync(
      process.stdout.fd,
      `${JSON.stringify({
        status: 'fulfilled',
        workerId: lease.ownerId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      })}\n`,
    );
  } catch (error) {
    writeSync(
      process.stdout.fd,
      `${JSON.stringify({
        status: 'rejected',
        code: errorField(error, 'code'),
      })}\n`,
    );
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    writeSync(process.stderr.fd, `${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
