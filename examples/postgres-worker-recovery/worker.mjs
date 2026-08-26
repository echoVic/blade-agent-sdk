import {
  AgentWorker,
  ExecutionHostSessionRunner,
} from '@blade-ai/agent-sdk/server';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { DockerExecutionHost } from '@blade-ai/agent-sdk/node';
import {
  SessionId,
  WorkerId,
} from '@blade-ai/agent-sdk/core';

const [
  mode,
  connectionString,
  schema,
  tablePrefix,
  tenantId,
  rawSessionId,
  image,
  rootDirectory,
  checkpointDirectory,
] = process.argv.slice(2);

if (
  (mode !== 'park' && mode !== 'restore')
  || !connectionString
  || !schema
  || !tablePrefix
  || !tenantId
  || !rawSessionId
  || !image
  || !rootDirectory
  || !checkpointDirectory
) {
  throw new Error(
    'Usage: worker.mjs <park|restore> <postgres-url> <schema> <prefix> '
      + '<tenant> <session> <image> <root-directory> <checkpoint-directory>',
  );
}

const workerId = WorkerId(`example-${mode}`);
const sessionId = SessionId(rawSessionId);
const store = new PostgresRuntimeStore({
  connectionString,
  schema,
  tablePrefix,
});
const host = new DockerExecutionHost({
  rootDirectory,
  checkpointDirectory,
});
const executionMetrics = {};
const observedHost = {
  provision: (request) => host.provision(request),
  exec: (executionId, request) => host.exec(executionId, request),
  checkpoint: (executionId, metadata) =>
    host.checkpoint(executionId, metadata),
  async restore(request) {
    const startedAt = performance.now();
    const execution = await host.restore(request);
    executionMetrics.checkpointRestoreMs =
      Math.round((performance.now() - startedAt) * 100) / 100;
    return execution;
  },
  terminate: (executionId) => host.terminate(executionId),
};
const runner = new ExecutionHostSessionRunner({
  resolvePlan: () => ({
    provision: {
      image,
      workspace: { kind: 'empty' },
      resources: {
        cpus: 0.25,
        memoryBytes: 32 * 1024 * 1024,
        diskBytes: 8 * 1024 * 1024,
        pids: 32,
        runtimeMs: 60_000,
        maxOutputBytes: 4096,
      },
      network: { mode: 'none' },
    },
    command: mode === 'park'
      ? {
          command: '/bin/sh',
          args: ['-c', 'printf durable > /workspace/state.txt'],
        }
      : {
          command: '/bin/sh',
          args: ['-c', 'test "$(cat /workspace/state.txt)" = durable'],
        },
    checkpoint: mode === 'park' ? 'park' : 'none',
  }),
});
const worker = new AgentWorker({
  store,
  workerId,
  tenantId,
  capacity: 1,
  sessionRunner: runner,
  executionHost: observedHost,
  workerTtlMs: 1_000,
  sessionLeaseTtlMs: 1_000,
  heartbeatIntervalMs: 200,
  pollIntervalMs: 25,
  recoveryIntervalMs: 250,
});

await worker.start();

if (mode === 'park') {
  while (true) {
    const route = await store.getSessionRoute(tenantId, sessionId);
    const execution = route?.metadata.bladeExecution;
    if (
      typeof execution === 'object'
      && execution !== null
      && !Array.isArray(execution)
      && typeof execution.checkpointId === 'string'
    ) {
      process.stdout.write(JSON.stringify({
        checkpointId: execution.checkpointId,
        executionId: execution.executionId,
      }) + '\n');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await worker.wait();
} else {
  const deadline = Date.now() + 60_000;
  let state;
  while (Date.now() < deadline) {
    state = (await store.getSessionRoute(tenantId, sessionId))?.state;
    if (state === 'completed' || state === 'failed') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await worker.shutdown();
  process.stdout.write(JSON.stringify({
    snapshot: worker.getSnapshot(),
    executionMetrics,
  }) + '\n');
  await store.close();
  if (state !== 'completed') {
    throw new Error(`Restore Session ended in ${state ?? 'unknown'} state`);
  }
}
