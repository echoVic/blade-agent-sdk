import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import open from 'open';
import { getSandboxExecutor, JsonlSessionRepository } from '@blade-ai/agent-sdk/advanced';
import { AgentServer, JsonlAgentServerStore } from '@blade-ai/agent-sdk/server/infra';
import {
  createDemoProviderRegistry,
  DEMO_MODEL,
  DEMO_PROVIDER_TYPE,
  NPM_CACHE_FLAG,
} from './DemoProvider.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const webRoot = root;
const projectRoot = root;
const generated = join(projectRoot, '.generated');
const startedAt = performance.now();
const SMOKE_BUDGET_MS = 2 * 60 * 1_000;
const READ_ONLY_RULES = ['Read', 'Read:*', 'Glob', 'Glob:*', 'Grep', 'Grep:*'];
// AgentServer's default basePath (never overridden below). Requests outside it
// -- the browser's automatic /favicon.ico among them -- are answered here
// instead of reaching the Agent handler, which requires auth before it can
// even report "route not found".
const AGENT_API_PREFIX = '/v1/agent/';

function parseArgs(argv) {
  const options = {
    smoke: false,
    open: true,
    port: Number(process.env.PORT || 8787),
    root: process.cwd(),
    dataDir: join(projectRoot, '.blade'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === '--smoke') options.smoke = true;
    else if (argument === '--no-open') options.open = false;
    else if (argument === '--port') options.port = Number(value());
    else if (argument === '--root') options.root = resolve(value());
    else if (argument === '--data-dir') options.dataDir = resolve(value());
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function loadEnvFile() {
  const envPath = join(projectRoot, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  return envPath;
}

async function askForApiKey() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(
      'Paste an OpenAI-compatible API key to use a real model, or press Enter to run the built-in scripted demo: ',
    );
    return answer.trim();
  } finally {
    readline.close();
  }
}

async function saveApiKey(envPath, apiKey) {
  const existing = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(envPath, `${existing}${separator}OPENAI_API_KEY=${apiKey}\n`);
}

async function resolveModel({ smoke, analysisRoot, envPath }) {
  const scripted = () => ({
    provider: { type: DEMO_PROVIDER_TYPE },
    providerRegistry: createDemoProviderRegistry({ root: analysisRoot, smoke }),
    model: DEMO_MODEL,
    label: 'built-in scripted demo (no API key)',
  });
  if (smoke) return scripted();
  let apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && process.stdin.isTTY && process.stdout.isTTY) {
    apiKey = await askForApiKey();
    if (apiKey) {
      await saveApiKey(envPath, apiKey);
      process.stdout.write(`Saved OPENAI_API_KEY to ${envPath}\n`);
    }
  }
  if (!apiKey) {
    process.stdout.write(
      'No API key configured: running the built-in scripted demo. Set OPENAI_API_KEY, and optionally OPENAI_BASE_URL and OPENAI_MODEL, to use a real model.\n',
    );
    return scripted();
  }
  const baseUrl = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  return {
    provider: baseUrl ? { type: 'openai-compatible', apiKey, baseUrl } : { type: 'openai', apiKey },
    providerRegistry: undefined,
    model,
    label: `${model} via ${baseUrl || 'OpenAI'}`,
  };
}

/** Run one command through the SDK's own sandbox wrapper; only a passing probe enables it. */
function probeSandbox(workDir) {
  const executor = getSandboxExecutor();
  const settings = { enabled: true };
  if (!executor.canUseSandbox(settings)) {
    return { enabled: false, reason: 'no supported sandbox runtime on this platform' };
  }
  try {
    const wrapped = executor.wrapCommand(
      'echo blade-sandbox-ok',
      executor.buildExecutionOptions(workDir),
      settings,
    );
    const run = spawnSync('bash', ['-c', wrapped], { encoding: 'utf8', timeout: 15_000 });
    if (run.status === 0 && run.stdout.includes('blade-sandbox-ok')) {
      return { enabled: true, reason: 'probe passed' };
    }
    const firstLine = (run.stderr || `probe exited ${run.status ?? run.signal}`).trim().split('\n')[0];
    return { enabled: false, reason: firstLine };
  } catch (error) {
    return { enabled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function systemPrompt(analysisRoot, sandbox) {
  return [
    'You are a repository analysis assistant running inside the Blade web starter.',
    `The workspace root is ${analysisRoot}. Use Glob, Grep and Read to inspect files, and Bash for read-only commands such as npm ls, npm audit and cat.`,
    `Always add ${NPM_CACHE_FLAG} to npm commands so caches stay out of the home directory.`,
    sandbox.enabled
      ? 'Shell commands run inside an OS sandbox that confines writes to the workspace.'
      : 'Shell commands are not sandboxed here; each one is shown to the user for approval before it runs.',
    'Never modify files. Report risks with evidence: file paths, versions and the exact commands you ran.',
    'When the user changes focus mid-task, acknowledge it and adjust the remaining steps.',
  ].join(' ');
}

async function createRuntime({ analysisRoot, dataDir, model, sandbox }) {
  await mkdir(join(dataDir, 'sessions'), { recursive: true });
  const store = new JsonlAgentServerStore({ directory: join(dataDir, 'server') });
  await store.initialize();
  const repository = new JsonlSessionRepository(join(dataDir, 'sessions'), 100, analysisRoot);
  await repository.initialize();
  const agent = new AgentServer({
    store,
    authenticate(request) {
      if (request.headers.get('authorization') !== 'Bearer local-demo') return null;
      return { tenantId: 'local-demo', subject: 'browser-user', scopes: ['session:admin'] };
    },
    resolveSessionOptions() {
      return {
        provider: model.provider,
        providerRegistry: model.providerRegistry,
        model: model.model,
        builtinTools: true,
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
        permissionMode: sandbox.enabled ? 'yolo' : 'default',
        permissions: { allow: sandbox.enabled ? [...READ_ONLY_RULES, 'Bash', 'Bash:*'] : READ_ONLY_RULES },
        sandbox: { enabled: sandbox.enabled },
        defaultContext: { capabilities: { filesystem: { roots: [analysisRoot], cwd: analysisRoot } } },
        sessionRepository: repository,
        sessionEventStore: repository,
        systemPrompt: systemPrompt(analysisRoot, sandbox),
        maxTurns: 24,
      };
    },
  });
  return {
    agent,
    async close() {
      await agent.close();
      await store.close();
    },
  };
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

const options = parseArgs(process.argv.slice(2));
const envPath = loadEnvFile();
let fixture;
if (options.smoke) {
  const { createSmokeFixture } = await import('./smoke.mjs');
  fixture = await createSmokeFixture();
  options.root = fixture.root;
  options.dataDir = fixture.dataDir;
  options.open = false;
}

await mkdir(generated, { recursive: true });
await build({
  entryPoints: [join(webRoot, 'client.js')],
  outfile: join(generated, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['browser'],
});

const model = await resolveModel({ smoke: options.smoke, analysisRoot: options.root, envPath });
const sandbox = probeSandbox(options.root);
const runtimeOptions = { analysisRoot: options.root, dataDir: options.dataDir, model, sandbox };
let runtime = await createRuntime(runtimeOptions);

const server = createServer(async (request, response) => {
  const connectionController = new AbortController();
  const onDisconnect = () => {
    if (!response.writableFinished) connectionController.abort(new Error('HTTP client disconnected'));
  };
  request.once('aborted', onDisconnect);
  response.once('close', onDisconnect);
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
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (!url.pathname.startsWith(AGENT_API_PREFIX)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const body = await requestBody(request);
    const upstream = await runtime.agent.handle(
      new Request(`http://127.0.0.1${request.url || '/'}`, {
        method: request.method,
        headers: request.headers,
        signal: connectionController.signal,
        ...(body ? { body } : {}),
      }),
    );
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    if (!upstream.body) {
      response.end();
      return;
    }
    // pipeline destroys the source when the browser closes the SSE connection.
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch (error) {
    if (connectionController.signal.aborted || response.destroyed) return;
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  } finally {
    request.removeListener('aborted', onDisconnect);
    response.removeListener('close', onDisconnect);
  }
});

function listen(port) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });
}

function closeServer() {
  return new Promise((resolvePromise, reject) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close((error) => (error ? reject(error) : resolvePromise()));
    server.closeAllConnections();
  });
}

let shutdownStarted = false;
async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await closeServer();
  await runtime.close();
}

for (const signalName of ['SIGINT', 'SIGTERM']) {
  process.once(signalName, () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exit(1);
      },
    );
  });
}

await listen(options.smoke ? 0 : options.port);
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Web Agent example did not expose a TCP address');
const baseUrl = `http://127.0.0.1:${address.port}`;

if (options.smoke) {
  const { runSmoke } = await import('./smoke.mjs');
  try {
    const summary = await runSmoke({
      baseUrl,
      startedAt,
      budgetMs: SMOKE_BUDGET_MS,
      restart: async () => {
        await runtime.close();
        runtime = await createRuntime(runtimeOptions);
      },
    });
    process.stdout.write(`${JSON.stringify({ ...summary, sandbox }, null, 2)}\n`);
  } finally {
    await shutdown();
    await fixture?.cleanup();
  }
} else {
  process.stdout.write(
    [
      `Blade web starter: ${baseUrl}`,
      `  workspace : ${options.root}`,
      `  data      : ${options.dataDir}`,
      `  model     : ${model.label}`,
      `  sandbox   : ${sandbox.enabled ? 'on' : `off (${sandbox.reason}); Bash asks for approval`}`,
      '',
    ].join('\n'),
  );
  if (options.open && process.stdout.isTTY) {
    await open(baseUrl).catch(() => undefined);
  }
}
