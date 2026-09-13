import { describe, expect, it, vi } from 'vitest';
import {
  InputId,
  MessageId,
  RequestId,
  SessionId,
  ToolUseId,
} from '../../types/identifiers.js';
import { mergeHistoryProgress } from '../historyProgress.js';
import { repairSessionHistory } from '../historyRepair.js';
import type { SessionState } from '../SessionStore.js';

const sessionId = SessionId('session-repair');
const requestId = RequestId('request-repair');

function envelope(sequence: number, type: string, data: unknown, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    eventId: `event-${sequence}`,
    sequence,
    sessionId,
    recordedAt: '2023-11-14T22:13:20.000Z',
    occurredAt: '2023-11-14T22:13:20.000Z',
    type,
    data,
    ...extra,
  } as never;
}

/** A journal whose last turn completed one tool call and produced an answer. */
function journalWithTurn() {
  return [
    envelope(1, 'session_created', { source: 'create' }, { commandId: 'command-create' }),
    envelope(2, 'request_accepted', { inputId: 'input-1', input: 'Fix the greeting', priority: 'next' }, {
      requestId, commandId: 'command-accept',
    }),
    envelope(3, 'request_started', {}, { requestId, commandId: 'command-start' }),
    envelope(4, 'turn_started', { turn: 1, model: 'test-model' }, {
      requestId, commandId: 'command-turn', turnId: 'turn-1',
    }),
    envelope(5, 'model_request_started', { streaming: false, model: 'test-model' }, {
      requestId, turnId: 'turn-1', modelAttemptId: 'attempt-1', commandId: 'command-model',
    }),
    envelope(6, 'model_request_completed', {
      response: {
        content: 'Updated the greeting',
        toolCalls: [{
          id: 'tool-1',
          name: 'RepoWrite',
          arguments: JSON.stringify({ file_path: 'src/greeting.sh' }),
        }],
      },
    }, {
      requestId, turnId: 'turn-1', modelAttemptId: 'attempt-1', commandId: 'command-model',
    }),
    envelope(7, 'tool_scheduled', {
      toolCallId: 'tool-1', toolName: 'RepoWrite', input: { file_path: 'src/greeting.sh' },
      modelInput: { file_path: 'src/greeting.sh' },
      sideEffect: 'non_idempotent',
      interruptBehavior: 'block',
    }, {
      requestId, turnId: 'turn-1', modelAttemptId: 'attempt-1',
      toolAttemptId: 'tool-attempt-1', commandId: 'command-tool',
    }),
    envelope(8, 'tool_started', {
      toolCallId: 'tool-1', toolName: 'RepoWrite',
      input: { file_path: 'src/greeting.sh' }, sideEffect: 'non_idempotent',
    }, {
      requestId, turnId: 'turn-1', toolAttemptId: 'tool-attempt-1', commandId: 'command-tool',
    }),
    envelope(9, 'tool_completed', {
      toolCallId: 'tool-1', toolName: 'RepoWrite', result: { changed: true },
    }, {
      requestId, turnId: 'turn-1', toolAttemptId: 'tool-attempt-1', commandId: 'command-tool',
    }),
  ];
}

function stateWithGap(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId,
    messages: [],
    messageIds: [],
    lastActivity: 1,
    createdAt: 1,
    sessionInfo: {},
    timeline: [],
    summaryMessageIds: [],
    toolCalls: [],
    subagentRefs: [],
    pendingInputs: [],
    historyProgress: { state: 'failed', updatedAt: 2, detail: 'write failed' },
    ...overrides,
  } as SessionState;
}

interface RepairPersistenceDouble {
  loadState: ReturnType<typeof vi.fn>;
  saveAppliedInputMessage: ReturnType<typeof vi.fn>;
  saveMessage: ReturnType<typeof vi.fn>;
  saveToolUse: ReturnType<typeof vi.fn>;
  saveToolResult: ReturnType<typeof vi.fn>;
  clearHistoryGap: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
}

function createPersistence(
  state: SessionState,
  events = journalWithTurn(),
): RepairPersistenceDouble {
  return {
    loadState: vi.fn(async () => state),
    saveAppliedInputMessage: vi.fn(async (_sessionId, inputId) => {
      state.messages.push({
        id: MessageId('message-user'),
        role: 'user',
        content: 'Fix the greeting',
        correlation: { inputId, requestId },
      } as never);
      return MessageId('message-user');
    }),
    saveMessage: vi.fn(async (_sessionId, role, content) => {
      state.messages.push({
        id: MessageId('message-assistant'),
        role,
        content,
        tool_calls: [{ id: ToolUseId('tool-1'), type: 'function', function: { name: 'RepoWrite', arguments: '{}' } }],
      } as never);
      return MessageId('message-assistant');
    }),
    saveToolUse: vi.fn(async () => ({ messageId: MessageId('message-tool'), toolCallId: ToolUseId('tool-1') })),
    saveToolResult: vi.fn(async () => MessageId('message-tool')),
    clearHistoryGap: vi.fn(async () => {
      state.historyProgress = { state: 'complete', updatedAt: 3, repairedMessages: 3 };
    }),
    read: vi.fn(async (_sessionId, { after }: { after?: number } = {}) => {
      const remaining = after === undefined
        ? events
        : events.filter((event) => Number((event as { sequence: number }).sequence) > Number(after));
      return {
        events: remaining,
        hasMore: false,
        nextCursor: (remaining.at(-1) as { sequence?: number } | undefined)?.sequence ?? null,
      };
    }),
  } as unknown as RepairPersistenceDouble;
}

describe('repairSessionHistory', () => {
  it('rebuilds the user, assistant and tool messages the transcript lost', async () => {
    const state = stateWithGap();
    const persistence = createPersistence(state);

    const result = await repairSessionHistory({ persistence: persistence as never, sessionId });

    expect(result).toMatchObject({
      repaired: true,
      reason: 'repaired',
      userMessages: 1,
      assistantMessages: 1,
      toolMessages: 1,
      missing: [],
    });
    expect(persistence.saveAppliedInputMessage).toHaveBeenCalledWith(
      sessionId, InputId('input-1'), requestId, 'Fix the greeting', null,
    );
    expect(persistence.saveMessage).toHaveBeenCalledWith(
      sessionId, 'assistant', 'Updated the greeting', expect.anything(), expect.anything(),
    );
    expect(persistence.saveToolResult).toHaveBeenCalledWith(
      sessionId, ToolUseId('tool-1'), 'RepoWrite', { changed: true }, expect.anything(), undefined,
    );
    expect(persistence.clearHistoryGap).toHaveBeenCalledWith(sessionId, 3);
    expect(state.historyProgress?.state).toBe('complete');
  });

  it('writes nothing on a second pass and still closes the gap', async () => {
    const state = stateWithGap();
    const persistence = createPersistence(state);
    await repairSessionHistory({ persistence: persistence as never, sessionId });
    persistence.saveAppliedInputMessage.mockClear();
    persistence.saveMessage.mockClear();
    persistence.saveToolResult.mockClear();
    persistence.clearHistoryGap.mockClear();

    // The transcript now holds every message the journal knows about, so a repeated
    // repair is a no-op rather than a duplicate.
    state.messages.push(
      { id: MessageId('user-1'), role: 'user', content: 'Fix the greeting', correlation: { inputId: InputId('input-1'), requestId } },
      { id: MessageId('assistant-1'), role: 'assistant', content: 'Updated the greeting',
        tool_calls: [{ id: ToolUseId('tool-1'), type: 'function', function: { name: 'RepoWrite', arguments: '{}' } }] },
    );
    state.toolCalls.push({ id: ToolUseId('tool-1'), name: 'RepoWrite', input: {}, status: 'success', timestamp: 1 });
    state.historyProgress = { state: 'failed', updatedAt: 4, detail: 'write failed' };

    const result = await repairSessionHistory({ persistence: persistence as never, sessionId });

    expect(result.repaired).toBe(true);
    expect(result.repairedMessages).toBe(0);
    expect(persistence.saveAppliedInputMessage).not.toHaveBeenCalled();
    expect(persistence.saveMessage).not.toHaveBeenCalled();
    expect(persistence.saveToolResult).not.toHaveBeenCalled();
    expect(persistence.clearHistoryGap).toHaveBeenCalledWith(sessionId, 0);
  });

  it('leaves the gap open when the journal cannot supply the missing pieces', async () => {
    const state = stateWithGap();
    const persistence = createPersistence(state, []);

    const result = await repairSessionHistory({ persistence: persistence as never, sessionId });

    expect(result).toMatchObject({ repaired: false, reason: 'insufficient-durable-data' });
    expect(result.missing).toContain('active-request');
    expect(persistence.clearHistoryGap).not.toHaveBeenCalled();
    expect(state.historyProgress?.state).toBe('failed');
  });

  it('does nothing when there is no recorded gap', async () => {
    const state = stateWithGap({ historyProgress: { state: 'in_progress', updatedAt: 5 } });
    const persistence = createPersistence(state);

    const result = await repairSessionHistory({ persistence: persistence as never, sessionId });

    expect(result).toMatchObject({ repaired: false, reason: 'no-gap' });
    expect(persistence.read).not.toHaveBeenCalled();
  });
});

describe('history progress transitions', () => {
  it('never lets a later successful write clear an open gap', () => {
    const gap = { state: 'failed' as const, updatedAt: 1, detail: 'write failed' };

    // The next request succeeds and records ordinary progress.
    const merged = mergeHistoryProgress(gap, { state: 'in_progress', updatedAt: 2 });
    expect(merged.state).toBe('failed');

    const completed = mergeHistoryProgress(merged, { state: 'complete', updatedAt: 3 });
    expect(completed.state).toBe('failed');

    // Repair is the only writer that closes it.
    expect(mergeHistoryProgress(gap, { state: 'complete', updatedAt: 4, repairedMessages: 2 }).state)
      .toBe('complete');
  });
});
