import { AgentWorker } from '@blade-ai/agent-sdk/server';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { WorkerId } from '@blade-ai/agent-sdk/core';
import { DockerExecutionHost } from '@blade-ai/agent-sdk/node';
import { RepositorySessionRunner } from './RepositorySessionRunner.mjs';
import { RepositoryState } from './RepositoryState.mjs';

let worker;
let store;
let state;
let stopping;
let configured = false;
let snapshotTimer;
const send = (message) => { if (process.connected) process.send(message); };

async function shutdown() {
  if (stopping) return stopping;
  stopping = (async () => {
    clearInterval(snapshotTimer);
    await worker?.shutdown();
    await state?.close();
    await store?.close();
    process.exitCode = 0;
    if (process.connected) process.disconnect();
  })();
  return stopping;
}

async function start(config) {
  if (configured) return;
  configured = true;
  const { connectionString, schema, tablePrefix = 'runtime', tenantId = 'production-demo' } = config;
  store = new PostgresRuntimeStore({ connectionString, schema, tablePrefix });
  state = new RepositoryState({ connectionString, schema });
  await store.initialize();
  await state.initialize();
  const host = new DockerExecutionHost({
    rootDirectory: config.rootDirectory,
    checkpointDirectory: config.checkpointDirectory,
  });
  const publish = async (eventTenantId, sessionId, type, data, requestId) => {
    await store.appendEvent(eventTenantId, sessionId, {
      protocolVersion: 1, sessionId, requestId,
      occurredAt: new Date().toISOString(), type,
      data: JSON.parse(JSON.stringify(data)),
    });
  };
  worker = new AgentWorker({
    store, workerId: WorkerId(config.workerId), tenantId, capacity: 1,
    executionHost: host,
    sessionRunner: new RepositorySessionRunner({
      state, smoke: config.smoke,
      repositoryConfig: config.repositoryConfig ?? {
        image: config.image, repositoryPath: config.repositoryPath, revision: config.revision,
      },
      publish,
    }),
    workerTtlMs: config.smoke ? 3_000 : 30_000,
    sessionLeaseTtlMs: config.smoke ? 3_000 : 30_000,
    heartbeatIntervalMs: config.smoke ? 500 : 5_000,
    pollIntervalMs: 50, recoveryIntervalMs: 250,
    onError: (error) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
  });
  await worker.start();
  snapshotTimer = setInterval(() => send({ type: 'snapshot', snapshot: worker.getSnapshot(), health: worker.getHealth() }), 500);
  send({ type: 'ready', snapshot: worker.getSnapshot(), health: worker.getHealth() });
}

process.on('message', (message) => {
  const action = message?.type === 'shutdown' ? shutdown()
    : message?.type === 'start' ? start(message.config)
      : message?.connectionString ? start(message) : Promise.resolve();
  void action.catch(async (error) => {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    await shutdown().catch(() => undefined);
    process.exitCode = 1;
  });
});
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('disconnect', () => { void shutdown(); });
