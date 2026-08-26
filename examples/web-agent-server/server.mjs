import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { AgentClient } from '@blade-ai/agent-sdk/browser';
import {
  AgentServer,
  ProviderRegistry,
} from '@blade-ai/agent-sdk/server';

const apiKey = process.env.OPENAI_API_KEY;
const smoke = process.argv.includes('--smoke');
const startedAt = performance.now();
const FIRST_RESULT_BUDGET_MS = 2 * 60 * 1_000;
const demoProvider = new ProviderRegistry([{
  type: 'golden-path-demo',
  create(config) {
    return {
      async chat() {
        return { content: 'Golden Path is ready.' };
      },
      async sideQuery() {
        return { content: 'Golden Path is ready.' };
      },
      async *streamChat(messages) {
        const last = messages.at(-1);
        const input = typeof last?.content === 'string'
          ? last.content
          : 'your request';
        yield { content: `AgentServer received: ${input}` };
        yield {
          finishReason: 'stop',
          usage: {
            promptTokens: 1,
            completionTokens: 4,
            totalTokens: 5,
          },
        };
      },
      getConfig() {
        return config;
      },
      updateConfig() {},
    };
  },
}]);

const root = dirname(fileURLToPath(import.meta.url));
const webRoot = root;
const generated = join(root, '.generated');
await mkdir(generated, { recursive: true });
await build({
  entryPoints: [join(webRoot, 'client.js')],
  outfile: join(generated, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['browser'],
});

const agent = new AgentServer({
  authenticate(request) {
    if (request.headers.get('authorization') !== 'Bearer local-demo') {
      return null;
    }
    return {
      tenantId: 'local-demo',
      subject: 'browser-user',
      scopes: ['session:admin'],
    };
  },
  resolveSessionOptions() {
    return {
      provider: apiKey
        ? { type: 'openai', apiKey }
        : { type: 'golden-path-demo' },
      providerRegistry: apiKey ? undefined : demoProvider,
      model: apiKey ? process.env.OPENAI_MODEL || 'gpt-5-mini' : 'demo',
      allowedTools: [],
    };
  },
});

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/') {
      const html = await readFile(join(webRoot, 'index.html'));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/client.js') {
      const client = await readFile(join(generated, 'client.js'));
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(client);
      return;
    }
    const body = await requestBody(request);
    const upstream = await agent.handle(
      new Request(`http://127.0.0.1${request.url || '/'}`, {
        method: request.method,
        headers: request.headers,
        ...(body ? { body } : {}),
      }),
    );
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    if (!upstream.body) {
      response.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(response);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
  }
});

function listen(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer() {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
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
      name: 'blade-web-starter-smoke',
      version: '1.0.0',
    },
    headers: {
      authorization: 'Bearer local-demo',
    },
  });
  const session = await client.createSession({ source: 'web-starter-smoke' });
  const eventController = new AbortController();
  const deadline = setTimeout(
    () => eventController.abort(new Error('Two-minute Web first-result budget exceeded')),
    Math.max(1, FIRST_RESULT_BUDGET_MS - (performance.now() - startedAt)),
  );
  let resolveResult;
  let rejectResult;
  let resultSettled = false;
  const resultReceived = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void resultReceived.catch(() => undefined);
  const events = (async () => {
    let output = '';
    try {
      for await (const event of session.events({ signal: eventController.signal })) {
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
    const input = 'minimal web starter smoke';
    await session.send(input);
    const completed = await resultReceived;
    const expected = `AgentServer received: ${input}`;
    if (completed.output !== expected || completed.result.subtype !== 'success') {
      throw new Error(`Unexpected Web starter result: ${JSON.stringify(completed)}`);
    }
    const firstResultMs = Math.round((performance.now() - startedAt) * 100) / 100;
    if (firstResultMs > FIRST_RESULT_BUDGET_MS) {
      throw new Error(`Web first result exceeded ${FIRST_RESULT_BUDGET_MS}ms`);
    }
    await session.close();
    await events;
    return {
      firstResultMs,
      output: completed.output,
    };
  } finally {
    clearTimeout(deadline);
    eventController.abort();
    await events.catch(() => undefined);
  }
}

let shutdownStarted = false;
async function shutdown() {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  await closeServer();
  await agent.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exit(1);
      },
    );
  });
}

const requestedPort = smoke ? 0 : Number(process.env.PORT || 8787);
await listen(requestedPort);
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Web Agent example did not expose a TCP address');
}
const baseUrl = `http://127.0.0.1:${address.port}`;

if (smoke) {
  try {
    process.stdout.write(`${JSON.stringify(await runSmoke(baseUrl), null, 2)}\n`);
  } finally {
    await shutdown();
  }
} else {
  process.stdout.write(`Web Agent example: ${baseUrl}\n`);
}
