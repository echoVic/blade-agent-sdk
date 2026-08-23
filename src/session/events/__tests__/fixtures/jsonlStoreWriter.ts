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
  process.stdout.write('ready\n');
  await once(process.stdin, 'data');

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
    process.stdout.write(
      `${JSON.stringify({
        status: 'fulfilled',
        lastSequence: result.lastSequence,
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        status: 'rejected',
        code: errorField(error, 'code'),
        expectedSequence: errorField(error, 'expectedSequence'),
        actualSequence: errorField(error, 'actualSequence'),
      })}\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
