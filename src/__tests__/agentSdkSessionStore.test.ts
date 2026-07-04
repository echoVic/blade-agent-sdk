import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentStore } from '../context/storage/PersistentStore.js';
import { SessionId } from '../types/branded.js';
import {
  JsonlSessionStore,
  NoopSessionStore,
} from '../../packages/agent-sdk/src/session/store.js';

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-sdk-session-store-test-'));
}

function expectDefined<T>(value: T | null | undefined): asserts value is T {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
}

describe('agent-sdk package-local session store', () => {
  it('reconstructs unified JSONL session state without root session store imports', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const sessionId = SessionId('agent-sdk-session-store');
    const userMessageId = await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const assistantMessageId = await persistentStore.saveMessage(
      sessionId,
      'assistant',
      '',
      userMessageId,
      {
        reasoningContent: 'Need a tool.',
        toolCalls: [
          {
            id: 'call-search',
            type: 'function',
            function: {
              name: 'Search',
              arguments: '{"query":"needle"}',
            },
          },
        ],
      },
    );
    await persistentStore.saveToolResult(
      sessionId,
      'call-search',
      'Search',
      { result: 'found' },
      'call-search',
    );
    await persistentStore.saveCompaction(
      sessionId,
      'Compacted summary',
      { trigger: 'manual', preTokens: 10 },
      assistantMessageId,
    );

    const state = await sessionStore.loadState(sessionId);
    const forked = await sessionStore.forkState(sessionId, { messageId: assistantMessageId });

    expectDefined(state);
    expect(state.messages).toHaveLength(4);
    expect(state.messages[0]).toMatchObject({
      id: userMessageId,
      role: 'user',
      content: 'hello',
    });
    expect(state.messages[1]).toMatchObject({
      id: assistantMessageId,
      role: 'assistant',
      reasoningContent: 'Need a tool.',
      tool_calls: [
        {
          id: 'call-search',
          function: {
            name: 'Search',
            arguments: '{"query":"needle"}',
          },
        },
      ],
    });
    expect(state.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-search',
      name: 'Search',
      content: '{"result":"found"}',
    });
    expect(state.summary).toBe('Compacted summary');
    expect(state.toolCalls).toMatchObject([
      {
        id: 'call-search',
        name: 'Search',
        status: 'success',
        output: { result: 'found' },
      },
    ]);

    expectDefined(forked);
    expect(forked.messageIds).toEqual([userMessageId, assistantMessageId]);
    expect(forked.summary).toBeUndefined();
  });

  it('keeps empty session persistence as an explicit noop implementation', async () => {
    const store = new NoopSessionStore();

    await expect(store.loadState('missing')).resolves.toBeNull();
    await expect(store.loadMessages('missing')).resolves.toEqual([]);
    await expect(store.forkState('missing')).resolves.toBeNull();
    await expect(store.listSessions()).resolves.toEqual([]);
    await expect(store.getSessionSummary('missing')).resolves.toBeNull();
  });
});
