import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../../services/ChatServiceInterface.js';

let turnCounter = 0;

const createAgent = vi.fn(async () => ({
  async *streamChat(message: string, context: { messages: Message[] }) {
    turnCounter += 1;
    const turnId = turnCounter;

    context.messages.push({
      id: `user-${turnId}`,
      role: 'user',
      content: message,
    });
    context.messages.push({
      id: `assistant-${turnId}`,
      role: 'assistant',
      content: `reply:${message}`,
    });

    yield { type: 'turn_start', turn: turnId, maxTurns: 10 };
    yield { type: 'content', content: `reply:${message}` };

    return {
      success: true,
      finalMessage: `reply:${message}`,
      metadata: {
        turnsCount: turnId,
        toolCallsCount: 0,
        duration: 0,
      },
    };
  },
  async setModel() {},
}));

vi.mock('../../agent/Agent.js', () => ({
  Agent: {
    create: createAgent,
  },
}));

const { createSession } = await import('../Session.js');

describe('Session in-memory mode', () => {
  it('keeps multi-turn history in memory and supports fork truncation by messageId', async () => {
    turnCounter = 0;
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

    expect(session.messages.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ]);

    const forked = await session.fork({ messageId: 'assistant-1' });

    expect(forked.messages.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);

    forked.close();
    session.close();
  });
});
