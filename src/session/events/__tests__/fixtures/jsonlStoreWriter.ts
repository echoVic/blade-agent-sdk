import { once } from 'node:events';
import { writeSync } from 'node:fs';
import { EventId, SessionId } from '../../../../types/branded.js';
import { JsonlDurableEventStore } from '../../JsonlDurableEventStore.js';
import { DurableEventType } from '../../types.js';

const [storageRoot, rawSessionId, writerId, rawHoldMs = '0', rawLockTimeoutMs = '10000'] =
  process.argv.slice(2);
const holdMs = Number(rawHoldMs);
const lockTimeoutMs = Number(rawLockTimeoutMs);

if (
  !storageRoot ||
  !rawSessionId ||
  !writerId ||
  !Number.isSafeInteger(holdMs) ||
  holdMs < 0 ||
  !Number.isSafeInteger(lockTimeoutMs) ||
  lockTimeoutMs < 0
) {
  process.stderr.write(
    'Usage: jsonlStoreWriter.ts <storage-root> <session-id> <writer-id> [hold-ms] [lock-timeout-ms]\n',
  );
  process.exit(2);
}

const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function errorField(error: unknown, field: string): unknown {
  return typeof error === 'object' && error !== null && field in error
    ? error[field as keyof typeof error]
    : undefined;
}

async function main(): Promise<void> {
  const sessionId = SessionId(rawSessionId);
  const store = new JsonlDurableEventStore(storageRoot, {
    eventIdFactory: () => {
      if (holdMs > 0) {
        writeSync(process.stdout.fd, 'locked\n');
        Atomics.wait(lockWaitArray, 0, 0, holdMs);
      }
      return EventId(`event-${writerId}`);
    },
    lockTimeoutMs,
  });
  const startSignal = once(process.stdin, 'data');
  writeSync(process.stdout.fd, 'ready\n');
  await startSignal;
  process.stdin.destroy();

  try {
    const result = await store.append(
      sessionId,
      [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
      ],
      { expectedLastSequence: null },
    );
    writeSync(
      process.stdout.fd,
      `${JSON.stringify({
        status: 'fulfilled',
        lastSequence: result.lastSequence,
      })}\n`,
    );
  } catch (error) {
    writeSync(
      process.stdout.fd,
      `${JSON.stringify({
        status: 'rejected',
        code: errorField(error, 'code'),
        expectedSequence: errorField(error, 'expectedSequence'),
        actualSequence: errorField(error, 'actualSequence'),
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
