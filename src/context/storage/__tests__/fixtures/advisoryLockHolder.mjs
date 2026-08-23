import { writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tryLock, unlock } from 'fs-native-extensions';

const [lockPath, rawHoldMs = '1000'] = process.argv.slice(2);
const holdMs = Number(rawHoldMs);

if (!lockPath || !Number.isSafeInteger(holdMs) || holdMs < 0) {
  process.stderr.write('Usage: advisoryLockHolder.mjs <lock-path> [hold-ms]\n');
  process.exit(2);
}

const waitArray = new Int32Array(new SharedArrayBuffer(4));
const lockFile = await open(lockPath, 'a+', 0o600);
if (!tryLock(lockFile.fd)) {
  await lockFile.close();
  process.stderr.write(`Failed to acquire ${lockPath}\n`);
  process.exit(1);
}

writeSync(process.stdout.fd, 'locked\n');
Atomics.wait(waitArray, 0, 0, holdMs);
unlock(lockFile.fd);
await lockFile.close();
