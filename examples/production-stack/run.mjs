import { execFile, fork } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  AgentRuntimeOperations,
  AgentServer,
} from '@blade-ai/agent-sdk/server';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { RepositoryState } from './RepositoryState.mjs';
import { reconcilePendingWork } from './RepositoryReconcile.mjs';
import { runProductionSmoke } from './smoke.mjs';
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
const temporaryRoot = await mkdtemp(join(tmpdir(), 'blade-production-stack-'));
const generated = join(temporaryRoot, 'web');
let store;
let worker;
let workerConfig;
let repositoryState;
const ownedContainers = new Set();
let agent;
let operations;
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

async function startWorker() {
  const child = fork(join(root, 'worker.mjs'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.pipe(process.stderr);
  child.stderr.pipe(process.stderr);
  const proxy = { child, snapshot: null, health: { live: false, ready: false, status: 'not_ready' },
    getSnapshot() { return this.snapshot; }, getHealth() { return this.health; } };
  worker = proxy;
  let started = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker startup timed out')), 30_000);
    child.once('error', reject);
    child.on('message', (message) => {
      if (message.snapshot) proxy.snapshot = message.snapshot;
      if (message.health) proxy.health = message.health;
      if (message.type === 'ready') { started = true; clearTimeout(timer); resolve(); }
      if (message.type === 'error') process.stderr.write(`Worker: ${message.message}\n`);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      proxy.health = { ...proxy.health, live: false, ready: false, status: 'not_ready', workerStatus: 'stopped' };
      reject(new Error(`Worker exited during startup: ${code ?? signal}`));
      if (started && !child.expectedExit && !cleanupStarted) {
        process.stderr.write('Worker stopped unexpectedly; starting a successor.\n');
        void startWorker().catch((error) => process.stderr.write(`Worker restart failed: ${error.message}\n`));
      }
    });
  });
  child.send({ type: 'start', config: { ...workerConfig, workerId: `production-worker-${child.pid}` } });
  await ready;
}

async function stopWorker(signal = 'SIGTERM') {
  const child = worker?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.expectedExit = true;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill(signal);
  const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { await exited; } finally { clearTimeout(force); }
}

async function restartWorker(checkpoint) {
  await stopWorker('SIGKILL');
  if (checkpoint.executionId) {
    const name = `blade-execution-${checkpoint.executionId}`;
    await execFileAsync('docker', ['rm', '-f', '-v', name]);
    ownedContainers.delete(name);
  }
  await startWorker();
}

/**
 * The launcher may reach the database while the Compose service is still starting
 * up. "the database system is starting up" is transient, so retry with backoff
 * instead of failing the run; every other error is a real failure.
 */
async function initializeWithRetry(target, { attempts = 30, delayMs = 500 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await target.initialize();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/starting up|the database system is starting up|cannot connect|ECONNREFUSED/i.test(message)) {
        throw error;
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * Wait for the injected crash boundary by reading the durable session route.
 *
 * The runner commits the checkpoint and marks `crashCheckpointCommitted` in the
 * route metadata before it parks, so the fault boundary is observable in the
 * store. A successor process, or any other operator, reads the same state — no
 * in-process cache or IPC channel is required.
 */
async function waitForCrashBoundary(sessionId, signal) {
  await waitUntil(async () => {
    signal.throwIfAborted();
    const route = await store.getSessionRoute(tenantId, sessionId);
    return route.metadata?.bladeRepository?.crashCheckpointCommitted === true;
  }, 120_000);
  const { metadata } = await store.getSessionRoute(tenantId, sessionId);
  const repository = metadata.bladeRepository;
  if (repository?.executionId) {
    ownedContainers.add(`blade-execution-${repository.executionId}`);
  }
  return repository;
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
  await stopWorker().catch(() => undefined);
  for (const name of ownedContainers) {
    await execFileAsync('docker', ['rm', '-f', '-v', name]).catch(() => undefined);
  }
  await repositoryState?.close().catch(() => undefined);
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
  composeStarted = true;
  await dockerCompose('up', '--detach', '--wait');
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
  await initializeWithRetry(store);

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
  repositoryState = new RepositoryState({ connectionString, schema });
  await initializeWithRetry(repositoryState);
  const executor = new QueuedSessionExecutor(store, publish, { state: repositoryState, smoke });
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
  // Each session gets a git-worktree of this disposable fixture; the SDK checkout is untouched.
  const repositoryPath = join(temporaryRoot, 'repository');
  await cp(join(root, 'fixture'), repositoryPath, { recursive: true });
  await execFileAsync('git', ['init', '--quiet', repositoryPath]);
  await execFileAsync('git', ['-C', repositoryPath, 'add', '.']);
  await execFileAsync('git', ['-C', repositoryPath, '-c', 'user.name=Blade Example',
    '-c', 'user.email=example@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '-m', 'Repository task fixture']);
  const { stdout: revisionOutput } = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD']);
  workerConfig = { connectionString, schema, tablePrefix, tenantId, image,
    rootDirectory: join(temporaryRoot, 'executions'), checkpointDirectory: join(temporaryRoot, 'checkpoints'),
    repositoryPath, revision: revisionOutput.trim(), smoke };
  // AgentWorker + DockerExecutionHost run in a separate process for real crash recovery.
  await startWorker();
  // Two windows leave durable work with a settled route, so no lease scan finds
  // them: an accepted submission that was never enqueued, and a terminal result
  // that was never published. Both are reconciled before the server accepts input.
  const reconciled = await reconcilePendingWork({
    store, state: repositoryState, tenantId, publish,
    report: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
  });
  if (reconciled.enqueuedSubmissions || reconciled.republishedOutcomes || reconciled.alreadyPublished) {
    process.stdout.write(`Reconciled on startup: ${JSON.stringify(reconciled)}\n`);
  }
  operations = new AgentRuntimeOperations({
    store,
    workers: () => [worker],
    authorize(request) {
      if (request.headers.get('authorization') !== 'Bearer local-demo') {
        return null;
      }
      return {
        tenantId,
        subject: 'local-operator',
      };
    },
  });

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
      const upstreamRequest = new Request(
        `http://127.0.0.1${request.url || '/'}`,
        {
          method: request.method,
          headers: request.headers,
          signal: requestController.signal,
          ...(body ? { body } : {}),
        },
      );
      const upstream = url.pathname.startsWith('/v1/runtime/')
        ? await operations.handle(upstreamRequest)
        : await agent.handle(upstreamRequest);
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
    const result = await runProductionSmoke({ baseUrl, store, state: repositoryState, tenantId,
      launchedAt, waitForCrashBoundary, restartWorker, getWorker: () => worker.getSnapshot() });
    process.stdout.write(`${JSON.stringify({
      baseUrl,
      ...result,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`Production repository Agent: ${baseUrl}\n`);
    await new Promise(() => undefined);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
