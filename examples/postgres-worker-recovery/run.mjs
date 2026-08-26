import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { SessionId } from '@blade-ai/agent-sdk/core';

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const composeFile = join(root, 'compose.yaml');
const composeProject = `blade-worker-example-${process.pid}`;
const schema = `blade_worker_example_${process.pid}`;
const tablePrefix = 'runtime';
const tenantId = 'golden-path';
const sessionId = SessionId(`recovery-${Date.now()}`);
const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'blade-worker-golden-path-'),
);
const checkpointDirectory = join(temporaryRoot, 'checkpoints');
let pool;
let abandonedExecutionId;
const runningChildren = new Set();

async function dockerCompose(...args) {
  return execFileAsync('docker', [
    'compose',
    '--project-name',
    composeProject,
    '--file',
    composeFile,
    ...args,
  ]);
}

async function waitForJsonLine(child) {
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('{'));
    if (line) {
      return JSON.parse(line);
    }
    if (child.exitCode !== null) {
      throw new Error(`Worker exited with ${child.exitCode}: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for worker output: ${stderr}`);
}

function startWorker(mode, connectionString, image) {
  const child = spawn(process.execPath, [
    join(root, 'worker.mjs'),
    mode,
    connectionString,
    schema,
    tablePrefix,
    tenantId,
    sessionId,
    image,
    join(temporaryRoot, mode),
    checkpointDirectory,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runningChildren.add(child);
  child.once('close', () => runningChildren.delete(child));
  return child;
}

try {
  await dockerCompose('up', '--detach', '--wait');
  const { stdout: portOutput } = await dockerCompose('port', 'postgres', '5432');
  const port = portOutput.trim().split(':').at(-1);
  if (!port) {
    throw new Error(`Could not resolve PostgreSQL port from "${portOutput.trim()}"`);
  }
  const connectionString =
    `postgresql://postgres:postgres@127.0.0.1:${port}/blade_agent_example`;
  await execFileAsync('docker', ['pull', 'alpine:3.22']);
  const { stdout: imageOutput } = await execFileAsync(
    'docker',
    ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', 'alpine:3.22'],
  );
  const image = imageOutput.trim();

  pool = new Pool({ connectionString });
  const store = new PostgresRuntimeStore({
    pool,
    schema,
    tablePrefix,
  });
  await store.initialize();
  await store.enqueueSession(tenantId, sessionId);

  const first = startWorker('park', connectionString, image);
  const checkpoint = await waitForJsonLine(first);
  abandonedExecutionId = checkpoint.executionId;
  const closed = once(first, 'close');
  first.kill('SIGKILL');
  await closed;

  const crashedRoute = await store.getSessionRoute(tenantId, sessionId);
  if (!crashedRoute?.leaseExpiresAt) {
    throw new Error('Crashed Session did not retain a lease expiry');
  }
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, Date.parse(crashedRoute.leaseExpiresAt) - Date.now()) + 100,
    ));
  const recoveryStartedAt = performance.now();
  await store.recoverExpiredWork();

  const second = startWorker('restore', connectionString, image);
  const snapshot = await waitForJsonLine(second);
  const [exitCode] = await once(second, 'close');
  if (exitCode !== 0) {
    throw new Error(`Recovery worker exited with ${String(exitCode)}`);
  }
  const recoveryDurationMs = performance.now() - recoveryStartedAt;
  const route = await store.getSessionRoute(tenantId, sessionId);
  process.stdout.write(JSON.stringify({
    sessionId,
    checkpointId: checkpoint.checkpointId,
    finalState: route?.state,
    attempts: route?.attempt,
    fencingToken: route?.fencingToken,
    recoveryDurationMs: Math.round(recoveryDurationMs * 100) / 100,
    workerMetrics: snapshot.metrics,
  }, null, 2) + '\n');
} finally {
  const closingChildren = [...runningChildren].map(async (child) => {
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  });
  await Promise.allSettled(closingChildren);
  if (abandonedExecutionId) {
    await execFileAsync(
      'docker',
      [
        'rm',
        '--force',
        '--volumes',
        `blade-execution-${abandonedExecutionId}`,
      ],
    ).catch(() => undefined);
  }
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
  await dockerCompose('down', '--volumes', '--remove-orphans')
    .catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}
