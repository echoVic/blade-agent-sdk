'use strict';

const { appendFile, mkdir } = require('node:fs/promises');
const { dirname } = require('node:path');
const lockfile = require('proper-lockfile');

const filePath = process.argv[2];
const holdMs = Number(process.argv[3]);
const encodedBatch = process.argv[4];

if (!filePath || !Number.isFinite(holdMs) || holdMs < 0) {
  process.stderr.write('Usage: holdFileLock.cjs <file-path> <hold-ms>\n');
  process.exit(2);
}

async function main() {
  await mkdir(dirname(filePath), { recursive: true });
  const release = await lockfile.lock(filePath, {
    realpath: false,
    stale: 5_000,
    update: 1_000,
  });
  if (encodedBatch) {
    const batch = Buffer.from(encodedBatch, 'base64url').toString('utf8');
    await appendFile(filePath, `${batch}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write('locked\n');
  setTimeout(() => {
    release()
      .then(() => {
        process.stdout.write('released\n', () => process.exit(0));
      })
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exit(1);
      });
  }, holdMs);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
