import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { AgentClient } from '@blade-ai/agent-sdk/browser';
import {
  AgentServer,
  ProviderRegistry,
} from '@blade-ai/agent-sdk/server';

const smoke = process.argv.includes('--smoke');
const apiKey = smoke ? undefined : process.env.OPENAI_API_KEY;
const startedAt = performance.now();
const FIRST_RESULT_BUDGET_MS = 2 * 60 * 1_000;
const demoProvider = new ProviderRegistry([{
  type: 'golden-path-demo',
  create(config) {
    return {
      async chat(_messages, _tools, signal) {
        signal?.throwIfAborted();
        return { content: 'Golden Path is ready.' };
      },
      async sideQuery(_messages, signal) {
        signal?.throwIfAborted();
        return { content: 'Golden Path is ready.' };
      },
      async *streamChat(messages, _tools, signal) {
        const last = messages.at(-1);
        const input = typeof last?.content === 'string'
          ? last.content
          : 'your request';
        const output = `AgentServer received: ${input}`;
        // Keep the demo visibly streaming so disconnects and cancellation can be tried locally.
        for (let offset = 0; offset < output.length; offset += 8) {
          await delay(smoke ? 20 : 120, undefined, { signal });
          signal?.throwIfAborted();
          yield { content: output.slice(offset, offset + 8) };
        }
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
  const connectionController = new AbortController();
  const onDisconnect = () => {
    if (!response.writableFinished) {
      connectionController.abort(new Error('HTTP client disconnected'));
    }
  };
  request.once('aborted', onDisconnect);
  response.once('close', onDisconnect);
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
    if (connectionController.signal.aborted || response.destroyed) {
      return;
    }
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    request.removeListener('aborted', onDisconnect);
    response.removeListener('close', onDisconnect);
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
  const createClient = () => new AgentClient({
    baseUrl: `${baseUrl}/v1/agent`,
    client: {
      name: 'blade-web-starter-smoke',
      version: '1.0.0',
    },
    headers: {
      authorization: 'Bearer local-demo',
    },
  });
  const eventController = new AbortController();
  const { signal } = eventController;
  const deadline = setTimeout(
    () => eventController.abort(new Error('Two-minute Web smoke budget exceeded')),
    Math.max(1, FIRST_RESULT_BUDGET_MS - (performance.now() - startedAt)),
  );
  let session;
  let cursor = null;
  const requestIds = new Set();

  const send = async (input) => {
    const submission = await session.send(input, { signal });
    if (submission.status !== 'started' || !submission.requestId
      || requestIds.has(submission.requestId)) {
      throw new Error(`Unexpected Web submission: ${JSON.stringify(submission)}`);
    }
    requestIds.add(submission.requestId);
    return submission.requestId;
  };

  const collect = async (
    requestId,
    { output = '', disconnect = false, allowOtherRequests = false } = {},
  ) => {
    for await (const event of session.events({ after: cursor, signal })) {
      if (cursor && event.sequence <= cursor.sequence) {
        throw new Error('Web event replay duplicated an already consumed event');
      }
      cursor = {
        protocolVersion: event.protocolVersion,
        sessionId: event.sessionId,
        sequence: event.sequence,
        eventId: event.eventId,
      };
      if (event.type === 'session.closed') {
        throw new Error('Session closed before producing a result');
      }
      if (event.type !== 'session.stream') {
        continue;
      }
      if (event.requestId !== requestId) {
        if (allowOtherRequests) {
          continue;
        }
        throw new Error(`Received events for another request: ${event.requestId}`);
      }
      if (event.data.type === 'error') {
        throw new Error(event.data.message);
      }
      if (event.data.type === 'content') {
        output += event.data.delta;
        if (disconnect) {
          return { output };
        }
      }
      if (event.data.type === 'result') {
        return { output, result: event.data };
      }
    }
    signal.throwIfAborted();
    throw new Error('Session event stream ended before producing a result');
  };

  const assertResult = (completed, input) => {
    const expected = `AgentServer received: ${input}`;
    if (completed.output !== expected || completed.result?.subtype !== 'success'
      || completed.result.content !== expected) {
      throw new Error(`Unexpected Web starter result: ${JSON.stringify(completed)}`);
    }
  };

  try {
    session = await createClient().createSession({ source: 'web-starter-smoke' }, { signal });
    const firstInput = 'minimal web starter smoke';
    const first = await collect(await send(firstInput));
    assertResult(first, firstInput);
    const firstResultMs = Math.round((performance.now() - startedAt) * 100) / 100;
    if (firstResultMs > FIRST_RESULT_BUDGET_MS) {
      throw new Error(`Web first result exceeded ${FIRST_RESULT_BUDGET_MS}ms`);
    }

    const secondInput = 'second turn after reconnect';
    const secondRequestId = await send(secondInput);
    const partial = await collect(secondRequestId, { disconnect: true });
    // A new client mirrors a page refresh. Resume keeps the request alive; the
    // saved cursor resumes its output without replaying the first turn or prefix.
    session = await createClient().resumeSession(session.sessionId, { signal });
    const second = await collect(secondRequestId, { output: partial.output });
    assertResult(second, secondInput);
    const restored = await session.read({ signal });
    const history = restored.messages
      ?.filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role, content: message.content }));
    const expectedHistory = [
      { role: 'user', content: firstInput },
      { role: 'assistant', content: first.output },
      { role: 'user', content: secondInput },
      { role: 'assistant', content: second.output },
    ];
    if (JSON.stringify(history) !== JSON.stringify(expectedHistory)) {
      throw new Error(`Web session history was not restored: ${JSON.stringify(history)}`);
    }

    const cancelledRequestId = await send('cancel this request before its complete response');
    await collect(cancelledRequestId, { disconnect: true });
    // Cancellation is acknowledged by abort(); it need not emit a result event.
    await session.abort({ signal });
    const afterCancelInput = 'a new turn after cancellation';
    const afterCancel = await collect(await send(afterCancelInput), { allowOtherRequests: true });
    assertResult(afterCancel, afterCancelInput);
    await session.close({ signal });
    session = undefined;
    return {
      firstResultMs,
      output: first.output,
      secondOutput: second.output,
      resumedMessages: history.length,
      reconnected: true,
      cancelled: true,
      afterCancelOutput: afterCancel.output,
    };
  } finally {
    clearTimeout(deadline);
    eventController.abort();
    await session?.close({ signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
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
