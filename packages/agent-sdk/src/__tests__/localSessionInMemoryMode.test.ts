import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRequest, ModelResponse } from '@blade-ai/ai';

const kernelModelGenerate = vi.fn(async (request: ModelRequest): Promise<ModelResponse> => {
  const lastUserMessage = request.messages.findLast((message) => message.role === 'user');
  const content = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
  return {
    content: `reply:${content}`,
    finishReason: 'stop',
  };
});

const createAgent = vi.fn(async () => ({
  async *streamChat() {},
  async setModel() {},
}));

vi.mock('../session/agent.js', () => ({
  Agent: {
    create: createAgent,
  },
}));

vi.mock('@blade-ai/ai/providers/vercel', () => ({
  createVercelModelPort: vi.fn(() => ({
    generate: kernelModelGenerate,
    stream: async function* () {},
  })),
}));

const { createSession } = await import('../session/internal.js');

describe('Session in-memory mode', () => {
  it('keeps multi-turn history in memory and supports fork truncation by messageId', async () => {
    kernelModelGenerate.mockClear();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'session-memory-mode-'));

    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath: workspaceRoot,
      persistSession: false,
      defaultContext: {
        capabilities: {
          filesystem: {
            roots: [workspaceRoot],
            cwd: workspaceRoot,
          },
        },
      },
    });

    await session.send('first');
    for await (const _event of session.stream()) {
      // Drain stream.
    }

    await session.send('second');
    for await (const _event of session.stream()) {
      // Drain stream.
    }

    expect(session.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply:first' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply:second' },
    ]);

    const firstAssistantId = session.messages[1]?.id;
    expect(firstAssistantId).toBeDefined();

    const forked = await session.fork({ messageId: firstAssistantId });

    expect(forked.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply:first' },
    ]);

    await forked.close();
    await session.close();
  });
});
