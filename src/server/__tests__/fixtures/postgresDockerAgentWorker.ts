import { writeSync } from 'node:fs';
import { DockerExecutionHost } from '../../../execution/DockerExecutionHost.js';
import { WorkerId } from '../../../types/identifiers.js';
import { AgentWorker } from '../../AgentWorker.js';
import { ExecutionHostSessionRunner } from '../../ExecutionHostSessionRunner.js';
import { PostgresRuntimeStore } from '../../PostgresRuntimeStore.js';

const [
  connectionString,
  schema,
  tablePrefix,
  rawWorkerId,
  image,
  rootDirectory,
  checkpointDirectory,
] = process.argv.slice(2);

if (
  !connectionString
  || !schema
  || !tablePrefix
  || !rawWorkerId
  || !image
  || !rootDirectory
  || !checkpointDirectory
  || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)
) {
  process.stderr.write(
    'Usage: postgresDockerAgentWorker.ts <url> <schema> <prefix> '
      + '<worker> <image> <root-directory> <checkpoint-directory>\n',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const store = new PostgresRuntimeStore({
    connectionString,
    schema,
    tablePrefix,
  });
  const host = new DockerExecutionHost({
    rootDirectory,
    checkpointDirectory,
  });
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
          maxOutputBytes: 1024,
        },
        network: { mode: 'none' },
      },
      command: {
        command: '/bin/sh',
        args: ['-c', 'printf recovered > /workspace/recovery.txt'],
      },
      checkpoint: 'park',
      checkpointMetadata: { sourceWorker: rawWorkerId },
    }),
  });
  const worker = new AgentWorker({
    store,
    workerId: WorkerId(rawWorkerId),
    capacity: 1,
    sessionRunner: runner,
    executionHost: host,
    workerTtlMs: 5_000,
    sessionLeaseTtlMs: 5_000,
    heartbeatIntervalMs: 500,
    pollIntervalMs: 25,
    recoveryIntervalMs: 250,
  });
  await worker.start();
  while (true) {
    const routes = await store.listWorkerSessions(WorkerId(rawWorkerId));
    const metadata = routes[0]?.metadata.bladeExecution;
    if (
      typeof metadata === 'object'
      && metadata !== null
      && !Array.isArray(metadata)
      && typeof metadata.checkpointId === 'string'
    ) {
      writeSync(
        process.stdout.fd,
        `checkpoint:${metadata.checkpointId}:${String(metadata.executionId ?? '')}\n`,
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await worker.wait();
}

main().catch((error) => {
  writeSync(
    process.stderr.fd,
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
