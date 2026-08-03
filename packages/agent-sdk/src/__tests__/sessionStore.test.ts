import { mkdtempSync } from 'node:fs';
import { SessionId } from '../local/branded.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JsonlSessionStore,
  NoopSessionStore,
} from '../session/store.js';

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-sdk-session-store-test-'));
}

function expectDefined<T>(value: T | null | undefined): asserts value is T {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
}

async function writeSessionEvents(
  workspaceRoot: string,
  sessionId: string,
  events: Record<string, unknown>[],
): Promise<void> {
  const sessionsRoot = join(workspaceRoot, 'sessions');
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(
    join(sessionsRoot, `${sessionId}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf-8',
  );
}

describe('agent-sdk package-local session store', () => {
  it('reconstructs unified JSONL session state without root session store imports', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const sessionStore = new JsonlSessionStore(workspaceRoot);
    const sessionId = SessionId('agent-sdk-session-store');
    const userMessageId = 'message-user';
    const assistantMessageId = 'message-assistant';
    const toolResultMessageId = 'message-tool-result';
    const summaryMessageId = 'message-summary';
    const now = '2026-01-01T00:00:00.000Z';

    await writeSessionEvents(workspaceRoot, sessionId, [
      {
        type: 'session_created',
        timestamp: now,
        data: {
          sessionId,
          rootId: sessionId,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        type: 'message_created',
        timestamp: now,
        data: {
          messageId: userMessageId,
          role: 'user',
          createdAt: now,
        },
      },
      {
        type: 'part_created',
        timestamp: now,
        data: {
          partId: 'part-user-text',
          messageId: userMessageId,
          partType: 'text',
          payload: { text: 'hello' },
          createdAt: now,
        },
      },
      {
        type: 'message_created',
        timestamp: now,
        data: {
          messageId: assistantMessageId,
          role: 'assistant',
          parentMessageId: userMessageId,
          createdAt: now,
        },
      },
      {
        type: 'part_created',
        timestamp: now,
        data: {
          partId: 'part-reasoning',
          messageId: assistantMessageId,
          partType: 'reasoning',
          payload: { text: 'Need a tool.' },
          createdAt: now,
        },
      },
      {
        type: 'part_created',
        timestamp: now,
        data: {
          partId: 'call-search',
          messageId: assistantMessageId,
          partType: 'tool_call',
          payload: {
            toolCallId: 'call-search',
            toolName: 'Search',
            input: { query: 'needle' },
          },
          createdAt: now,
        },
      },
      {
        type: 'message_created',
        timestamp: now,
        data: {
          messageId: toolResultMessageId,
          role: 'tool',
          parentMessageId: assistantMessageId,
          createdAt: now,
        },
      },
      {
        type: 'part_created',
        timestamp: now,
        data: {
          partId: 'call-search',
          messageId: toolResultMessageId,
          partType: 'tool_result',
          payload: {
            toolCallId: 'call-search',
            toolName: 'Search',
            output: { result: 'found' },
          },
          createdAt: now,
        },
      },
      {
        type: 'message_created',
        timestamp: now,
        data: {
          messageId: summaryMessageId,
          role: 'system',
          parentMessageId: assistantMessageId,
          createdAt: now,
        },
      },
      {
        type: 'part_created',
        timestamp: now,
        data: {
          partId: 'part-summary',
          messageId: summaryMessageId,
          partType: 'summary',
          payload: {
            text: 'Compacted summary',
            metadata: { trigger: 'manual', preTokens: 10, _systemSource: 'compaction_summary' },
          },
          createdAt: now,
        },
      },
    ]);

    const state = await sessionStore.loadState(sessionId);
    const forked = await sessionStore.forkState(sessionId, { messageId: assistantMessageId });
    await sessionStore.writeForkState(SessionId('forked-session'), forked);
    const forkedState = await sessionStore.loadState(SessionId('forked-session'));

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

    expectDefined(forkedState);
    expect(forkedState.sessionId).toBe('forked-session');
    expect(forkedState.messageIds).toEqual([userMessageId, assistantMessageId]);
    expect(forkedState.messages).toEqual(forked.messages);
    expect(forkedState.sessionInfo).toMatchObject({
      sessionId: SessionId('forked-session'),
      parentId: sessionId,
    });
  });

  it('keeps empty session persistence as an explicit noop implementation', async () => {
    const store = new NoopSessionStore();

    await expect(store.loadState(SessionId('missing'))).resolves.toBeNull();
    await expect(store.loadMessages(SessionId('missing'))).resolves.toEqual([]);
    await expect(store.forkState(SessionId('missing'))).resolves.toBeNull();
    await expect(store.writeForkState(SessionId('forked'), null)).resolves.toBeNull();
    await expect(store.listSessions()).resolves.toEqual([]);
    await expect(store.getSessionSummary(SessionId('missing'))).resolves.toBeNull();
  });

  it('returns generated message ids when writing fork snapshots with anonymous messages', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const written = await sessionStore.writeForkState(SessionId('anonymous-fork'), {
      sessionId: SessionId('parent-session'),
      messages: [{ role: 'user', content: 'hello without an id' }],
      messageIds: [],
      lastActivity: Date.now(),
    });
    const reloaded = await sessionStore.loadState(SessionId('anonymous-fork'));

    expectDefined(written);
    expectDefined(reloaded);
    expect(written.messageIds).toEqual(reloaded.messageIds);
    expect(written.messages).toEqual(reloaded.messages);
    expect(written.messageIds).toHaveLength(1);
  });
});
