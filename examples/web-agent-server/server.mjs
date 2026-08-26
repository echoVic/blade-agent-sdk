import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  AgentServer,
  ProviderRegistry,
} from '@blade-ai/agent-sdk/server';

const apiKey = process.env.OPENAI_API_KEY;
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
const generated = join(root, '.generated');
await mkdir(generated, { recursive: true });
await build({
  entryPoints: [join(root, 'client.js')],
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
      const html = await readFile(join(root, 'index.html'));
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

const port = Number(process.env.PORT || 8787);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Web Agent example: http://127.0.0.1:${port}\n`);
});

async function shutdown() {
  server.close();
  await agent.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
