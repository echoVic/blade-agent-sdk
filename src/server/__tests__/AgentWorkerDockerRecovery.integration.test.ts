import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { DockerExecutionHost } from '../../execution/DockerExecutionHost.js';
import { SessionId, WorkerId } from '../../types/identifiers.js';
import { AgentWorker } from '../AgentWorker.js';
import { ExecutionHostSessionRunner } from '../ExecutionHostSessionRunner.js';
import { PostgresRuntimeStore } from '../PostgresRuntimeStore.js';

const execFileAsync = promisify(execFile);
const connectionString = process.env.TEST_POSTGRES_URL;
const image = process.env.TEST_DOCKER_IMAGE;
const describeRuntime = connectionString && image ? describe : describe.skip;
const schema = `blade_agent_worker_${process.pid}_${Date.now()}`;
const tablePrefix = 'runtime';
const pool = connectionString ? new Pool({ connectionString }) : null;
const loaderUrl = pathToFileURL(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../session/events/__tests__/fixtures/sourceTypeScriptLoader.mjs',
  ),
).href;
const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/postgresDockerAgentWorker.ts',
);

interface ChildCheckpoint {
  readonly checkpointId: string;
  readonly executionId: string;
}

async function waitForCheckpoint(
  child: ReturnType<typeof import('node:child_process').spawn>,
): Promise<ChildCheckpoint> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const match = /checkpoint:([^:\n]+):([^\n]+)\n/.exec(stdout);
    if (match?.[1] && match[2]) {
      return {
        checkpointId: match[1],
        executionId: match[2],
      };
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Worker exited before checkpoint (${String(child.exitCode)}): ${stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for worker checkpoint: ${stderr}`);
}

async function waitForRouteState(
  store: PostgresRuntimeStore,
  tenantId: string,
  sessionId: SessionId,
  state: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await store.getSessionRoute(tenantId, sessionId))?.state === state) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Session ${sessionId} to enter ${state}`);
}

describeRuntime('AgentWorker PostgreSQL and Docker recovery', () => {
  let store: PostgresRuntimeStore;
  let rootDirectory: string;
  let checkpointDirectory: string;
  const abandonedContainers = new Set<string>();

  beforeAll(async () => {
    if (!pool) {
      throw new Error('TEST_POSTGRES_URL is required');
    }
    rootDirectory = await mkdtemp(join(tmpdir(), 'blade-agent-worker-'));
    checkpointDirectory = join(rootDirectory, 'checkpoints');
    store = new PostgresRuntimeStore({ pool, schema, tablePrefix });
    await store.initialize();
  });

  afterAll(async () => {
    for (const executionId of abandonedContainers) {
      await execFileAsync(
        'docker',
        ['rm', '--force', '--volumes', `blade-execution-${executionId}`],
      ).catch(() => undefined);
    }
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    if (rootDirectory) {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it('restores a checkpoint on a second worker after the first worker is killed', async () => {
    if (!connectionString || !image) {
      throw new Error('TEST_POSTGRES_URL and TEST_DOCKER_IMAGE are required');
    }
    const tenantId = `tenant-${Date.now()}`;
    const sessionId = SessionId(`session-${Date.now()}`);
    await store.enqueueSession(tenantId, sessionId);

    const firstRoot = join(rootDirectory, 'worker-a');
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [
      '--no-warnings',
      '--experimental-transform-types',
      '--loader',
      loaderUrl,
      workerPath,
      connectionString,
      schema,
      tablePrefix,
      'worker-a',
      image,
      firstRoot,
      checkpointDirectory,
    ]);
    const checkpoint = await waitForCheckpoint(child);
    abandonedContainers.add(checkpoint.executionId);

    const childClosed = once(child, 'close');
    child.kill('SIGKILL');
    await childClosed;

    const crashedRoute = await store.getSessionRoute(tenantId, sessionId);
    if (!crashedRoute?.leaseExpiresAt) {
      throw new Error('Crashed Session did not retain a lease expiry');
    }
    const leaseExpiresAt = crashedRoute.leaseExpiresAt;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Date.parse(leaseExpiresAt) - Date.now()) + 100,
      ));
    await store.recoverExpiredWork();
    await expect(store.getSessionRoute(tenantId, sessionId)).resolves.toMatchObject({
      state: 'suspended',
      attempt: 1,
      metadata: {
        bladeExecution: {
          checkpointId: checkpoint.checkpointId,
        },
      },
    });

    const secondHost = new DockerExecutionHost({
      rootDirectory: join(rootDirectory, 'worker-b'),
      checkpointDirectory,
    });
    const secondRunner = new ExecutionHostSessionRunner({
      resolvePlan: () => ({
        provision: {
          image,
          workspace: { kind: 'empty' },
          resources: {
            cpus: 0.25,
            memoryBytes: 32 * 1024 * 1024,
            diskBytes: 8 * 1024 * 1024,
            pids: 32,
            runtimeMs: 30_000,
            maxOutputBytes: 1024,
          },
          network: { mode: 'none' },
        },
        command: {
          command: '/bin/sh',
          args: ['-c', 'test "$(cat /workspace/recovery.txt)" = recovered'],
        },
      }),
    });
    const secondWorker = new AgentWorker({
      store,
      workerId: WorkerId('worker-b'),
      capacity: 1,
      sessionRunner: secondRunner,
      executionHost: secondHost,
      workerTtlMs: 5_000,
      sessionLeaseTtlMs: 5_000,
      heartbeatIntervalMs: 500,
      pollIntervalMs: 25,
      recoveryIntervalMs: 250,
    });
    await secondWorker.start();
    try {
      await waitForRouteState(store, tenantId, sessionId, 'completed');
    } finally {
      await secondWorker.shutdown();
    }

    const completed = await store.getSessionRoute(tenantId, sessionId);
    expect(completed).toMatchObject({
      state: 'completed',
      attempt: 2,
      fencingToken: 2,
      metadata: {
        bladeExecution: {
          checkpointId: checkpoint.checkpointId,
          lastExitCode: 0,
        },
      },
    });
  }, 60_000);
});
