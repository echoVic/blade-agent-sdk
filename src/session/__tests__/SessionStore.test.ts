import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertDefined } from '../../__tests__/helpers/assertDefined.js';
import { JSONLStore } from '../../context/storage/JSONLStore.js';
import { NoopPersistentStore, PersistentStore } from '../../context/storage/PersistentStore.js';
import { getSessionFilePathFromStorageRoot } from '../../context/storage/pathUtils.js';
import type { SessionEvent } from '../../context/types.js';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import {
  InputId,
  MessageId,
  RequestId,
  SessionId,
} from '../../types/branded.js';
import { JsonlSessionStore } from '../SessionStore.js';

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'session-store-test-'));
}

function sessionEvent<T extends SessionEvent['type']>(
  sessionId: SessionId,
  timestamp: string,
  id: string,
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
): Extract<SessionEvent, { type: T }> {
  return { id, sessionId, timestamp, type, version: '1.1.2', data } as Extract<
    SessionEvent,
    { type: T }
  >;
}

describe('JsonlSessionStore', () => {
  it('keeps persisted message IDs distinct from provider tool-call IDs', async () => {
    const store = new NoopPersistentStore();
    const toolUse = await store.saveToolUse(
      SessionId('session-noop'),
      'Search',
      { query: 'needle' },
      null,
      undefined,
      'call-noop',
    );
    const toolResultMessageId = await store.saveToolResult(
      SessionId('session-noop'),
      toolUse.toolCallId,
      'Search',
      'result',
      toolUse.messageId,
    );

    expect(toolUse.toolCallId).toBe('call-noop');
    expect(toolUse.messageId).not.toBe(toolUse.toolCallId);
    expect(toolResultMessageId).not.toBe(toolUse.toolCallId);
  });

  it('should reconstruct full session state from JSONL events', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const sessionId = SessionId('session-1');
    const userMessageId = await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const toolUse = await persistentStore.saveToolUse(
      sessionId,
      'Task',
      {
        subagent_session_id: 'child-1',
        subagent_type: 'research',
        description: 'Inspect repository',
      },
    );
    const toolResultMessageId = await persistentStore.saveToolResult(
      sessionId,
      toolUse.toolCallId,
      'Task',
      { status: 'done' },
      toolUse.messageId,
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
      toolResultMessageId,
    );

    const state = await sessionStore.loadState(sessionId);

    expect(state).not.toBeNull();
    assertDefined(state);
    expect(state.messages).toHaveLength(4);
    expect(state.messages[0]?.id).toBe(userMessageId);
    expect(state.messages[0]?.role).toBe('user');
    expect(state.messages[1]?.role).toBe('assistant');
    expect(state.messages[1]?.tool_calls?.[0]?.id).toBe(toolUse.toolCallId);
    expect(state.messages[2]?.role).toBe('tool');
    expect(state.messages[2]?.tool_call_id).toBe(toolUse.toolCallId);
    expect(state.messages[3]?.role).toBe('system');
    expect(state.messages[3]?.id).toBe(summaryMessageId);
    expect(state.messages[3]?.content).toBe('Compacted summary');
    expect(state.summary).toBe('Compacted summary');
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]?.status).toBe('success');
    expect(state.subagentRefs).toHaveLength(2);
    expect(state.subagentRefs[1]?.status).toBe('completed');
  });

  it('should preserve sequential tool results with distinct message IDs', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);

    const sessionId = SessionId('session-sequential-tools');
    const userMessageId = await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const firstToolUse = await persistentStore.saveToolUse(
      sessionId,
      'Search',
      { query: 'first' },
      userMessageId,
      undefined,
      'call-first',
    );
    const firstResultId = await persistentStore.saveToolResult(
      sessionId,
      firstToolUse.toolCallId,
      'Search',
      'first result',
      firstToolUse.messageId,
    );
    const secondToolUse = await persistentStore.saveToolUse(
      sessionId,
      'Search',
      { query: 'second' },
      firstResultId,
      undefined,
      'call-second',
    );
    await persistentStore.saveToolResult(
      sessionId,
      secondToolUse.toolCallId,
      'Search',
      'second result',
      secondToolUse.messageId,
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
    expect(state.messages[1]?.tool_calls?.[0]?.id).toBe('call-first');
    expect(state.messages[2]?.tool_call_id).toBe('call-first');
    expect(state.messages[3]?.tool_calls?.[0]?.id).toBe('call-second');
    expect(state.messages[4]?.tool_call_id).toBe('call-second');
    expect(new Set(state.messageIds).size).toBe(state.messageIds.length);
    expect(state.timeline[1]?.parentMessageId).toBe(userMessageId);
    expect(state.timeline[2]?.parentMessageId).toBe(firstToolUse.messageId);
    expect(state.timeline[3]?.parentMessageId).toBe(firstResultId);
    expect(state.timeline[4]?.parentMessageId).toBe(secondToolUse.messageId);
  });

  it('reconstructs only unresolved durable session inputs', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);
    const sessionId = SessionId('session-pending-inputs');
    const firstInputId = InputId('input-first');
    const secondInputId = InputId('input-second');
    const cancelledInputId = InputId('input-cancelled');

    await persistentStore.saveInputEnqueued(sessionId, {
      inputId: firstInputId,
      content: 'first',
      priority: 'next',
      targetRequestId: RequestId('request-old'),
      acceptedAt: 1,
    });
    await persistentStore.saveInputEnqueued(sessionId, {
      inputId: secondInputId,
      content: [
        {
          type: 'text',
          text: 'second',
        },
      ],
      priority: 'later',
      acceptedAt: 2,
    });
    await persistentStore.saveAppliedInputMessage(
      sessionId,
      firstInputId,
      RequestId('request-old'),
      'first',
    );
    await persistentStore.saveInputEnqueued(sessionId, {
      inputId: cancelledInputId,
      content: 'cancelled',
      priority: 'later',
      acceptedAt: 3,
    });
    await persistentStore.saveInputCancelled(
      sessionId,
      cancelledInputId,
      'cancelled_by_user',
    );

    const state = await sessionStore.loadState(sessionId);

    assertDefined(state);
    expect(state.pendingInputs).toEqual([
      {
        inputId: secondInputId,
        content: [
          {
            type: 'text',
            text: 'second',
          },
        ],
        priority: 'later',
        acceptedAt: 2,
      },
    ]);
    expect(state.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'first',
        metadata: expect.objectContaining({
          inputId: firstInputId,
          requestId: 'request-old',
        }),
      }),
    ]);
  });

  it('should repair legacy message ID collisions and duplicate tool calls', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const sessionId = SessionId('session-legacy-tool-collision');
    const now = new Date().toISOString();
    const entries = [
      sessionEvent(sessionId, now, 'session', 'session_created', {
        sessionId,
        rootId: sessionId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      }),
      sessionEvent(sessionId, now, 'user', 'message_created', {
        messageId: MessageId('user-1'),
        role: 'user',
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'user-text', 'part_created', {
        partId: 'user-text',
        messageId: MessageId('user-1'),
        partType: 'text',
        payload: { text: 'hello' },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'first-call', 'part_created', {
        partId: 'call-first',
        messageId: MessageId('user-1'),
        partType: 'tool_call',
        payload: { toolCallId: 'call-first', toolName: 'Search', input: { query: 'first' } },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'first-result', 'part_created', {
        partId: 'call-first',
        messageId: MessageId('call-first'),
        partType: 'tool_result',
        payload: { toolCallId: 'call-first', toolName: 'Search', output: 'first result' },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'second-call', 'part_created', {
        partId: 'call-second',
        messageId: MessageId('call-first'),
        partType: 'tool_call',
        payload: { toolCallId: 'call-second', toolName: 'Search', input: { query: 'second' } },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'assistant', 'message_created', {
        messageId: MessageId('assistant-1'),
        role: 'assistant',
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'duplicate-first-call', 'part_created', {
        partId: 'call-first',
        messageId: MessageId('assistant-1'),
        partType: 'tool_call',
        payload: { toolCallId: 'call-first', toolName: 'Search', input: { query: 'first' } },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'duplicate-second-call', 'part_created', {
        partId: 'call-second',
        messageId: MessageId('assistant-1'),
        partType: 'tool_call',
        payload: { toolCallId: 'call-second', toolName: 'Search', input: { query: 'second' } },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'second-result', 'part_created', {
        partId: 'call-second',
        messageId: MessageId('call-second'),
        partType: 'tool_result',
        payload: { toolCallId: 'call-second', toolName: 'Search', output: 'second result' },
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
    expect(state.messages[0]?.content).toBe('hello');
    expect(state.messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.id))
      .toEqual(['call-first', 'call-second']);
    expect(state.messages.filter((message) => message.role === 'tool').map(
      (message) => message.tool_call_id,
    )).toEqual(['call-first', 'call-second']);
  });

  it('should preserve repeated provider tool-call IDs across legacy turns', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const sessionId = SessionId('session-repeated-tool-call-id');
    const now = new Date().toISOString();
    const entries = [
      sessionEvent(sessionId, now, 'session', 'session_created', {
        sessionId,
        rootId: sessionId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      }),
      sessionEvent(sessionId, now, 'user', 'message_created', {
        messageId: MessageId('user-1'),
        role: 'user',
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'first-call', 'part_created', {
        partId: 'call-repeated',
        messageId: MessageId('user-1'),
        partType: 'tool_call',
        payload: { toolCallId: 'call-repeated', toolName: 'Search', input: { query: 'first' } },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'first-result', 'part_created', {
        partId: 'call-repeated',
        messageId: MessageId('call-repeated'),
        partType: 'tool_result',
        payload: { toolCallId: 'call-repeated', toolName: 'Search', output: 'first result' },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'second-assistant', 'message_created', {
        messageId: MessageId('assistant-2'),
        role: 'assistant',
        parentMessageId: 'call-repeated',
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'second-call', 'part_created', {
        partId: 'call-repeated',
        messageId: MessageId('assistant-2'),
        partType: 'tool_call',
        payload: { toolCallId: 'call-repeated', toolName: 'Search', input: { query: 'second' } },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'second-result', 'part_created', {
        partId: 'call-repeated',
        messageId: MessageId('call-repeated'),
        partType: 'tool_result',
        payload: { toolCallId: 'call-repeated', toolName: 'Search', output: 'second result' },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'second-result-update', 'part_updated', {
        partId: 'call-repeated',
        messageId: MessageId('call-repeated'),
        partType: 'tool_result',
        payload: { toolCallId: 'call-repeated', toolName: 'Search', output: 'second result updated' },
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
    expect(state.messages.filter((message) => message.tool_calls?.[0]?.id === 'call-repeated'))
      .toHaveLength(2);
    expect(state.messages.filter((message) => message.tool_call_id === 'call-repeated'))
      .toHaveLength(2);
    expect(state.toolCalls.map((toolCall) => toolCall.output)).toEqual([
      'first result',
      'second result updated',
    ]);
  });

  it('rejects a transcript containing events for another Session', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const expectedSessionId = SessionId('expected-session');
    const actualSessionId = SessionId('other-session');
    const now = new Date().toISOString();
    await new JSONLStore(
      getSessionFilePathFromStorageRoot(workspaceRoot, expectedSessionId),
    ).append(
      sessionEvent(actualSessionId, now, 'foreign-session', 'session_created', {
        sessionId: actualSessionId,
        rootId: actualSessionId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      }),
    );

    await expect(
      new JsonlSessionStore(workspaceRoot).loadState(expectedSessionId),
    ).rejects.toMatchObject({
      code: 'SESSION_JSONL_CORRUPT_LOG',
      message: expect.stringContaining(`expected ${expectedSessionId}`),
    });
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
        modelIdentity: {
          provider: 'custom-provider',
          api: 'custom-wire-api',
          model: 'custom-model',
        },
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
      assistantMessageId,
    );

    const state = await sessionStore.loadState(sessionId);

    expect(state).not.toBeNull();
    assertDefined(state);
    expect(state.messages).toHaveLength(3);
    expect(state.messages[1]).toMatchObject({
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      modelIdentity: {
        provider: 'custom-provider',
        api: 'custom-wire-api',
        model: 'custom-model',
      },
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
