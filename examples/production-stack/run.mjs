import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { AgentClient } from '@blade-ai/agent-sdk/browser';
import { WorkerId } from '@blade-ai/agent-sdk/core';
import {
  AgentServer,
  AgentWorker,
} from '@blade-ai/agent-sdk/server';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { DockerExecutionHost } from '@blade-ai/agent-sdk/node';
import { DockerPromptRunner } from './DockerPromptRunner.mjs';
import { QueuedSessionExecutor } from './QueuedSessionExecutor.mjs';

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const webRoot = join(root, '../web-agent-server');
const composeFile = join(root, 'compose.yaml');
const composeProject = `blade-production-stack-${process.pid}`;
const schema = `blade_production_stack_${process.pid}`;
const tablePrefix = 'runtime';
const tenantId = 'production-demo';
const smoke = process.argv.includes('--smoke');
const launchedAt = performance.now();
const FIRST_RESULT_BUDGET_MS = 5 * 60 * 1_000;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'blade-production-stack-'));
const generated = join(temporaryRoot, 'web');
let store;
let worker;
let agent;
let httpServer;
let composeStarted = false;
let cleanupStarted = false;

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

async function resolveImage() {
  if (process.env.TEST_DOCKER_IMAGE) {
    return process.env.TEST_DOCKER_IMAGE;
  }
  await execFileAsync('docker', ['pull', 'alpine:3.22']);
  const { stdout } = await execFileAsync(
    'docker',
    ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', 'alpine:3.22'],
  );
  return stdout.trim();
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function waitUntil(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Production stack did not settle within ${timeoutMs}ms`);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeAllConnections();
  });
}

async function runSmoke(baseUrl) {
  const client = new AgentClient({
    baseUrl: `${baseUrl}/v1/agent`,
    client: {
      name: 'blade-production-stack-smoke',
      version: '1.0.0',
    },
    headers: {
      authorization: 'Bearer local-demo',
    },
  });
  const session = await client.createSession({
    source: 'production-stack-smoke',
  });
  const eventController = new AbortController();
  const deadline = setTimeout(
    () => eventController.abort(new Error('Five-minute first-result budget exceeded')),
    Math.max(1, FIRST_RESULT_BUDGET_MS - (performance.now() - launchedAt)),
  );
  let resolveResult;
  let rejectResult;
  let resultSettled = false;
  const resultReceived = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const events = (async () => {
    let output = '';
    try {
      for await (const event of session.events({
        signal: eventController.signal,
      })) {
        if (event.type === 'session.stream' && event.data.type === 'content') {
          output += event.data.delta;
        }
        if (event.type === 'session.stream' && event.data.type === 'result') {
          resultSettled = true;
          resolveResult({
            output,
            result: event.data,
          });
        }
        if (event.type === 'session.closed') {
          if (!resultSettled) {
            rejectResult(new Error('Session closed before producing a result'));
          }
          return;
        }
      }
      throw new Error('Session event stream ended before session.closed');
    } catch (error) {
      if (!resultSettled) {
        rejectResult(error);
      }
      throw error;
    }
  })();
  try {
    await session.send('single-command production path');
    const completed = await resultReceived;
    const firstResultMs = Math.round((performance.now() - launchedAt) * 100) / 100;
    const expected = 'Docker worker received: single-command production path';
    if (
      completed.output !== expected
      || completed.result.subtype !== 'success'
    ) {
      throw new Error(`Unexpected production stack result: ${JSON.stringify(completed)}`);
    }
    if (firstResultMs > FIRST_RESULT_BUDGET_MS) {
      throw new Error(`First result exceeded ${FIRST_RESULT_BUDGET_MS}ms`);
    }
    await waitUntil(
      async () =>
        (await store.getSessionRoute(tenantId, session.sessionId))?.state === 'idle',
    );
    await session.close();
    await events;
    return {
      sessionId: session.sessionId,
      firstResultMs,
      output: completed.output,
      worker: worker.getSnapshot(),
    };
  } finally {
    clearTimeout(deadline);
    eventController.abort();
    await events.catch(() => undefined);
  }
}

async function cleanup() {
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;
  if (httpServer?.listening) {
    await closeServer(httpServer).catch(() => undefined);
  }
  await agent?.close().catch(() => undefined);
  await worker?.shutdown().catch(() => undefined);
  await store?.close().catch(() => undefined);
  if (composeStarted) {
    await dockerCompose('down', '--volumes', '--remove-orphans')
      .catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(
          `${error instanceof Error ? error.stack : String(error)}\n`,
        );
        process.exit(1);
      },
    );
  });
}

try {
  await dockerCompose('up', '--detach', '--wait');
  composeStarted = true;
  const { stdout: portOutput } = await dockerCompose('port', 'postgres', '5432');
  const databasePort = portOutput.trim().split(':').at(-1);
  if (!databasePort) {
    throw new Error(`Could not resolve PostgreSQL port from "${portOutput.trim()}"`);
  }
  const connectionString =
    `postgresql://postgres:postgres@127.0.0.1:${databasePort}/blade_agent_stack`;
  const image = await resolveImage();

  store = new PostgresRuntimeStore({
    connectionString,
    schema,
    tablePrefix,
  });
  await store.initialize();

  const publish = (
    eventTenantId,
    sessionId,
    type,
    data,
    requestId,
  ) =>
    store.appendEvent(eventTenantId, sessionId, {
      protocolVersion: 1,
      sessionId,
      ...(requestId ? { requestId } : {}),
      occurredAt: new Date().toISOString(),
      type,
      data,
    });
  const executor = new QueuedSessionExecutor(store, publish);
  agent = new AgentServer({
    runtimeStore: store,
    sessionExecutor: executor,
    authenticate(request) {
      if (request.headers.get('authorization') !== 'Bearer local-demo') {
        return null;
      }
      return {
        tenantId,
        subject: 'browser-user',
        scopes: ['session:admin'],
      };
    },
  });
  const host = new DockerExecutionHost({
    rootDirectory: join(temporaryRoot, 'executions'),
    checkpointDirectory: join(temporaryRoot, 'checkpoints'),
  });
  worker = new AgentWorker({
    store,
    workerId: WorkerId(`production-worker-${process.pid}`),
    tenantId,
    capacity: 2,
    executionHost: host,
    sessionRunner: new DockerPromptRunner({ image, publish }),
    workerTtlMs: 5_000,
    sessionLeaseTtlMs: 5_000,
    heartbeatIntervalMs: 500,
    pollIntervalMs: 25,
    recoveryIntervalMs: 250,
  });
  await worker.start();

  await build({
    entryPoints: [join(webRoot, 'client.js')],
    outfile: join(generated, 'client.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['browser'],
  });
  httpServer = createServer(async (request, response) => {
    const requestController = new AbortController();
    const abortUpstream = () => {
      requestController.abort(new Error('Client disconnected'));
    };
    request.once('aborted', abortUpstream);
    response.once('close', abortUpstream);
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(await readFile(join(webRoot, 'index.html')));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/client.js') {
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(await readFile(join(generated, 'client.js')));
        return;
      }
      const body = await requestBody(request);
      const upstream = await agent.handle(
        new Request(`http://127.0.0.1${request.url || '/'}`, {
          method: request.method,
          headers: request.headers,
          signal: requestController.signal,
          ...(body ? { body } : {}),
        }),
      );
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (!upstream.body) {
        response.end();
        return;
      }
      const bodyStream = Readable.fromWeb(upstream.body);
      response.once('close', () => bodyStream.destroy());
      bodyStream.on('error', (error) => {
        requestController.abort(error);
        if (!response.destroyed) {
          response.destroy(error);
        }
      });
      bodyStream.pipe(response);
    } catch (error) {
      if (response.destroyed) {
        return;
      }
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });
  await listen(httpServer, smoke ? 0 : Number(process.env.PORT || 8787));
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine production stack HTTP address');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  if (smoke) {
    const result = await runSmoke(baseUrl);
    process.stdout.write(`${JSON.stringify({
      baseUrl,
      ...result,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`Production Agent stack: ${baseUrl}\n`);
    await new Promise(() => undefined);
  }
} finally {
  await cleanup();
}
