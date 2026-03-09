import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import { JsonlSessionStore } from '../SessionStore.js';

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'session-store-test-'));
}

describe('JsonlSessionStore', () => {
  it('should reconstruct full session state from JSONL events', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const sessionId = 'session-1';
    const userMessageId = await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const toolCallId = await persistentStore.saveToolUse(
      sessionId,
      'Task',
      {
        subagent_session_id: 'child-1',
        subagent_type: 'research',
        description: 'Inspect repository',
      },
    );
    await persistentStore.saveToolResult(
      sessionId,
      toolCallId,
      'Task',
      { status: 'done' },
      toolCallId,
      undefined,
      undefined,
      {
        subagentSessionId: 'child-1',
        subagentType: 'research',
        subagentStatus: 'completed',
        subagentSummary: 'Finished inspection',
      },
    );
    const summaryMessageId = await persistentStore.saveCompaction(
      sessionId,
      'Compacted summary',
      { trigger: 'auto', preTokens: 100, postTokens: 40 },
      toolCallId,
    );

    const state = await sessionStore.loadState(sessionId);

    expect(state).not.toBeNull();
    expect(state!.messages).toHaveLength(4);
    expect(state!.messages[0]?.id).toBe(userMessageId);
    expect(state!.messages[0]?.role).toBe('user');
    expect(state!.messages[1]?.role).toBe('assistant');
    expect(state!.messages[1]?.tool_calls?.[0]?.id).toBe(toolCallId);
    expect(state!.messages[2]?.role).toBe('tool');
    expect(state!.messages[2]?.tool_call_id).toBe(toolCallId);
    expect(state!.messages[3]?.role).toBe('system');
    expect(state!.messages[3]?.id).toBe(summaryMessageId);
    expect(state!.messages[3]?.content).toBe('Compacted summary');
    expect(state!.summary).toBe('Compacted summary');
    expect(state!.toolCalls).toHaveLength(1);
    expect(state!.toolCalls[0]?.status).toBe('success');
    expect(state!.subagentRefs).toHaveLength(2);
    expect(state!.subagentRefs[1]?.status).toBe('completed');
  });

  it('should fork state by linear message boundary', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const sessionId = 'session-2';
    const userMessageId = await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const assistantMessageId = await persistentStore.saveMessage(
      sessionId,
      'assistant',
      'world',
      userMessageId,
    );
    await persistentStore.saveCompaction(
      sessionId,
      'Compacted summary',
      { trigger: 'manual', preTokens: 50 },
      assistantMessageId,
    );

    const snapshot = await sessionStore.forkState(sessionId, { messageId: assistantMessageId });

    expect(snapshot).not.toBeNull();
    expect(snapshot!.messageIds).toEqual([userMessageId, assistantMessageId]);
    expect(snapshot!.messages).toHaveLength(2);
    expect(snapshot!.summary).toBeUndefined();
  });

  it('should provide session summaries from the unified store', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    await persistentStore.saveMessage('session-a', 'user', 'alpha');
    await persistentStore.saveCompaction(
      'session-a',
      'Searchable summary',
      { trigger: 'auto', preTokens: 10 },
    );
    await persistentStore.saveMessage('session-b', 'user', 'beta');

    const sessionIds = await sessionStore.listSessions();
    const summary = await sessionStore.getSessionSummary('session-a');

    expect(sessionIds).toEqual(['session-a', 'session-b']);
    expect(summary).not.toBeNull();
    expect(summary!.messageCount).toBe(1);
    expect(summary!.summaryText).toBe('Searchable summary');
  });
});
