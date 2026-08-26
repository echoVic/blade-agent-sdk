import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createSession,
  ProviderRegistry,
} from '@blade-ai/agent-sdk/node';

const apiKey = process.env.OPENAI_API_KEY;
const smoke = process.argv.includes('--smoke');
const useDemoProvider = smoke || process.env.BLADE_DEMO_MODE === 'mock';
if (!apiKey && !useDemoProvider) {
  throw new Error(
    'Set OPENAI_API_KEY, or set BLADE_DEMO_MODE=mock for an offline smoke test',
  );
}

const demoProvider = new ProviderRegistry([{
  type: 'golden-path-demo',
  create(config) {
    return {
      async chat() {
        return { content: 'Local Agent is ready.' };
      },
      async sideQuery() {
        return { content: 'Local Agent is ready.' };
      },
      async *streamChat(messages) {
        const last = messages.at(-1);
        const input = typeof last?.content === 'string'
          ? last.content
          : 'your request';
        yield { content: `Local Agent received: ${input}` };
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

const promptArguments = process.argv.slice(2).filter((argument) => argument !== '--smoke');
const prompt =
  (promptArguments[0] === '--' ? promptArguments.slice(1) : promptArguments)
    .join(' ')
    .trim()
  || (smoke
    ? 'minimal local starter smoke'
    : 'Inspect this repository and summarize its public API.');
const persistSession = true;
const storagePath = persistSession
  ? resolve('.data/local-cli-agent')
  : undefined;
if (storagePath) {
  await mkdir(storagePath, { recursive: true });
}

const session = await createSession({
  provider: useDemoProvider
    ? { type: 'golden-path-demo' }
    : { type: 'openai', apiKey },
  providerRegistry: useDemoProvider ? demoProvider : undefined,
  model: useDemoProvider ? 'demo' : process.env.OPENAI_MODEL || 'gpt-5-mini',
  ...(storagePath ? { storagePath } : {}),
  defaultContext: {
    capabilities: {
      filesystem: {
        cwd: process.cwd(),
        roots: [process.cwd()],
      },
    },
  },
});

const abortController = new AbortController();
process.once('SIGINT', () => abortController.abort());

try {
  await session.send(prompt, { signal: abortController.signal });
  for await (const event of session.stream()) {
    if (event.type === 'content') {
      process.stdout.write(event.delta);
    } else if (event.type === 'tool_use') {
      process.stderr.write(`\n[tool] ${event.name}\n`);
    } else if (event.type === 'error') {
      process.stderr.write(`\n[error] ${event.message}\n`);
    }
  }
  process.stdout.write('\n');
} finally {
  await session.close();
}
