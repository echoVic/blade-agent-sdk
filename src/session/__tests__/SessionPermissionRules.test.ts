import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelMessage } from '../../model/message.js';
import type { ModelResponse, ModelService } from '../../model/service.js';
import { createSession } from '../../node/index.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';

function readOnceService(config: ModelServiceConfig, filePath: string): ModelService {
  const next = (messages: readonly ModelMessage[]): ModelResponse =>
    messages.some((message) => message.role === 'tool')
      ? { content: 'done' }
      : {
          content: '',
          toolCalls: [
            {
              id: 'call-read',
              type: 'function',
              function: { name: 'Read', arguments: JSON.stringify({ file_path: filePath }) },
            },
          ],
        };
  return {
    async chat(messages) {
      return next(messages);
    },
    async sideQuery() {
      return { content: '' };
    },
    async *streamChat(messages) {
      const response = next(messages);
      yield response;
      yield { finishReason: response.toolCalls ? 'tool_calls' : 'stop' };
    },
    getConfig() {
      return config;
    },
    updateConfig() {},
  };
}

async function runReadTurn(permissions?: { allow: string[] }) {
  const directory = await mkdtemp(join(tmpdir(), 'session-permission-rules-'));
  const filePath = join(directory, 'notes.txt');
  await writeFile(filePath, 'hello from the rules test\n');
  const confirmations: string[] = [];
  const session = await createSession({
    provider: { type: 'read-once' },
    providerRegistry: new ProviderRegistry([
      { type: 'read-once', create: (config) => readOnceService({ ...config }, filePath) },
    ]),
    model: 'read-once',
    allowedTools: ['Read'],
    defaultContext: { capabilities: { filesystem: { roots: [directory], cwd: directory } } },
    ...(permissions ? { permissions } : {}),
    confirmationHandler: {
      async requestConfirmation(details) {
        confirmations.push(details.toolName ?? 'unknown');
        return { approved: true, scope: 'once' };
      },
    },
    maxTurns: 4,
  });
  const toolResults: string[] = [];
  await session.send('read the notes');
  for await (const event of session.stream()) {
    if (event.type === 'tool_result') toolResults.push(event.isError ? 'error' : 'ok');
    if (event.type === 'result' || event.type === 'error') break;
  }
  await session.close();
  return { confirmations, toolResults };
}

describe('SessionOptions.permissions', () => {
  it('lets matching allow rules skip the confirmation prompt', async () => {
    const { confirmations, toolResults } = await runReadTurn({ allow: ['Read', 'Read:*'] });
    expect(toolResults).toEqual(['ok']);
    expect(confirmations).toEqual([]);
  });

  it('keeps asking when no rule matches', async () => {
    const { confirmations, toolResults } = await runReadTurn();
    expect(toolResults).toEqual(['ok']);
    expect(confirmations).toEqual(['Read']);
  });
});
