import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSONLStore } from '../../context/storage/JSONLStore.js';
import { getSessionFilePathFromStorageRoot } from '../../context/storage/pathUtils.js';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import type { SessionEvent } from '../../context/types.js';
import { JsonlSessionStore } from '../SessionStore.js';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import { assertDefined } from '../../__tests__/helpers/assertDefined.js';
import { SessionId } from '../../types/branded.js';

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'session-store-test-'));
}

describe('JsonlSessionStore', () => {
  it('should reconstruct full session state from JSONL events', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const sessionId = SessionId('session-1');
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
    assertDefined(state);
    expect(state.messages).toHaveLength(4);
    expect(state.messages[0]?.id).toBe(userMessageId);
    expect(state.messages[0]?.role).toBe('user');
    expect(state.messages[1]?.role).toBe('assistant');
    expect(state.messages[1]?.tool_calls?.[0]?.id).toBe(toolCallId);
    expect(state.messages[2]?.role).toBe('tool');
    expect(state.messages[2]?.tool_call_id).toBe(toolCallId);
    expect(state.messages[3]?.role).toBe('system');
    expect(state.messages[3]?.id).toBe(summaryMessageId);
    expect(state.messages[3]?.content).toBe('Compacted summary');
    expect(state.summary).toBe('Compacted summary');
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]?.status).toBe('success');
    expect(state.subagentRefs).toHaveLength(2);
    expect(state.subagentRefs[1]?.status).toBe('completed');
  });

  it('should preserve sequential tool results across resume', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const sessionId = SessionId('session-sequential-tools');
    const userMessageId = await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const firstToolCallId = 'call-first';
    const firstAssistantId = await persistentStore.saveToolUse(
      sessionId,
      'Search',
      { query: 'first' },
      userMessageId,
      undefined,
      firstToolCallId,
    );
    const firstResultId = await persistentStore.saveToolResult(
      sessionId,
      firstToolCallId,
      'Search',
      'first result',
      firstAssistantId,
    );
    const secondToolCallId = 'call-second';
    const secondAssistantId = await persistentStore.saveToolUse(
      sessionId,
      'Search',
      { query: 'second' },
      firstResultId,
      undefined,
      secondToolCallId,
    );
    await persistentStore.saveToolResult(
      sessionId,
      secondToolCallId,
      'Search',
      'second result',
      secondAssistantId,
    );

    const state = await sessionStore.loadState(sessionId);

    assertDefined(state);
    expect(state.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
    expect(state.messages[1]?.tool_calls?.[0]?.id).toBe(firstToolCallId);
    expect(state.messages[2]?.tool_call_id).toBe(firstToolCallId);
    expect(state.messages[3]?.tool_calls?.[0]?.id).toBe(secondToolCallId);
    expect(state.messages[4]?.tool_call_id).toBe(secondToolCallId);
    expect(new Set(state.messageIds).size).toBe(state.messageIds.length);
    expect(state.timeline[1]?.parentMessageId).toBe(userMessageId);
    expect(state.timeline[2]?.parentMessageId).toBe(firstAssistantId);
    expect(state.timeline[3]?.parentMessageId).toBe(firstResultId);
    expect(state.timeline[4]?.parentMessageId).toBe(secondAssistantId);
  });

  it('should repair legacy message ID collisions and duplicate tool calls', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const sessionId = SessionId('session-legacy-tool-collision');
    const now = new Date().toISOString();
    const event = (id: string, type: string, data: object): SessionEvent => ({
      id,
      sessionId,
      timestamp: now,
      type,
      version: '1.1.1',
      data,
    }) as SessionEvent;
    const entries = [
      event('session', 'session_created', {
        sessionId,
        rootId: sessionId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      }),
      event('user', 'message_created', { messageId: 'user-1', role: 'user', createdAt: now }),
      event('user-text', 'part_created', {
        partId: 'user-text', messageId: 'user-1', partType: 'text',
        payload: { text: 'hello' }, createdAt: now,
      }),
      event('first-call', 'part_created', {
        partId: 'call-first', messageId: 'user-1', partType: 'tool_call',
        payload: { toolCallId: 'call-first', toolName: 'Search', input: { query: 'first' } },
        createdAt: now,
      }),
      event('first-result', 'part_created', {
        partId: 'call-first', messageId: 'call-first', partType: 'tool_result',
        payload: { toolCallId: 'call-first', toolName: 'Search', output: 'first result', error: null },
        createdAt: now,
      }),
      event('second-call', 'part_created', {
        partId: 'call-second', messageId: 'call-first', partType: 'tool_call',
        payload: { toolCallId: 'call-second', toolName: 'Search', input: { query: 'second' } },
        createdAt: now,
      }),
      event('assistant', 'message_created', {
        messageId: 'assistant-1', role: 'assistant', createdAt: now,
      }),
      event('duplicate-first-call', 'part_created', {
        partId: 'call-first', messageId: 'assistant-1', partType: 'tool_call',
        payload: { toolCallId: 'call-first', toolName: 'Search', input: { query: 'first' } },
        createdAt: now,
      }),
      event('duplicate-second-call', 'part_created', {
        partId: 'call-second', messageId: 'assistant-1', partType: 'tool_call',
        payload: { toolCallId: 'call-second', toolName: 'Search', input: { query: 'second' } },
        createdAt: now,
      }),
      event('second-result', 'part_created', {
        partId: 'call-second', messageId: 'call-second', partType: 'tool_result',
        payload: { toolCallId: 'call-second', toolName: 'Search', output: 'second result', error: null },
        createdAt: now,
      }),
    ];
    await new JSONLStore(getSessionFilePathFromStorageRoot(workspaceRoot, sessionId))
      .appendBatch(entries);

    const state = await new JsonlSessionStore(workspaceRoot).loadState(sessionId);

    assertDefined(state);
    expect(state.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
    const projectedCalls = state.messages.flatMap((message) => message.tool_calls ?? []);
    expect(projectedCalls.map((call) => call.id)).toEqual(['call-first', 'call-second']);
    expect(state.messages.find((message) => message.tool_call_id === 'call-first')?.content)
      .toBe('first result');
    expect(state.messages.find((message) => message.tool_call_id === 'call-second')?.content)
      .toBe('second result');
  });

  it('should preserve assistant reasoning content with tool calls for resume', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const sessionId = SessionId('session-reasoning-tool-call');
    const userMessageId = await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const assistantMessageId = await persistentStore.saveMessage(
      sessionId,
      'assistant',
      '',
      userMessageId,
      {
        reasoningContent: 'Need to inspect first.',
        toolCalls: [
          {
            id: 'call-search',
            type: 'function',
            function: {
              name: 'Search',
              arguments: '{"q":"needle"}',
            },
          },
        ],
      },
    );
    await persistentStore.saveToolResult(
      sessionId,
      'call-search',
      'Search',
      'result',
      'call-search',
    );

    const state = await sessionStore.loadState(sessionId);

    expect(state).not.toBeNull();
    assertDefined(state);
    expect(state.messages).toHaveLength(3);
    expect(state.messages[1]).toMatchObject({
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      reasoningContent: 'Need to inspect first.',
      tool_calls: [
        {
          id: 'call-search',
          function: {
            name: 'Search',
            arguments: '{"q":"needle"}',
          },
        },
      ],
    });
    expect(state.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-search',
    });
  });

  it('should fork state by linear message boundary', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const sessionId = SessionId('session-2');
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
    assertDefined(snapshot);
    expect(snapshot.messageIds).toEqual([userMessageId, assistantMessageId]);
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.summary).toBeUndefined();
  });

  it('should provide session summaries from the unified store', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    await persistentStore.saveMessage(SessionId('session-a'), 'user', 'alpha');
    await persistentStore.saveCompaction(
      SessionId('session-a'),
      'Searchable summary',
      { trigger: 'auto', preTokens: 10 },
    );
    await persistentStore.saveMessage(SessionId('session-b'), 'user', 'beta');

    const sessionIds = await sessionStore.listSessions();
    const summary = await sessionStore.getSessionSummary(SessionId('session-a'));

    expect(sessionIds).toEqual(['session-a', 'session-b']);
    expect(summary).not.toBeNull();
    assertDefined(summary);
    expect(summary.messageCount).toBe(1);
    expect(summary.summaryText).toBe('Searchable summary');
  });

  it('should reconstruct multimodal user messages preserving image parts', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const sessionId = SessionId('session-multimodal');
    const content: ContentPart[] = [
      { type: 'text', text: 'describe this image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ];

    await persistentStore.saveMessage(sessionId, 'user', content);

    const state = await sessionStore.loadState(sessionId);

    expect(state).not.toBeNull();
    assertDefined(state);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe('user');
    expect(state.messages[0]?.content).toEqual(content);
  });
});
