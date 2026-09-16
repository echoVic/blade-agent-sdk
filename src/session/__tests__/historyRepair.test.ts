import { describe, expect, it, type Mocked, vi } from 'vitest';
import {
  EventSequence,
  InputId,
  MessageId,
  RequestId,
  SessionId,
  ToolUseId,
} from '../../types/identifiers.js';
import type { DurableEventReadOptions } from '../events/types.js';
import { mergeHistoryProgress } from '../historyProgress.js';
import {
  type HistoryRepairStore,
  projectDurableHistory,
  repairSessionHistory,
} from '../historyRepair.js';
import type { SessionState } from '../SessionStore.js';

const sessionId = SessionId('session-repair');
const requestId = RequestId('request-repair');

function envelope(
  sequence: number,
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
) {
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
    envelope(
      2,
      'request_accepted',
      { inputId: 'input-1', input: 'Fix the greeting', priority: 'next' },
      {
        requestId,
        commandId: 'command-accept',
      },
    ),
    envelope(3, 'request_started', {}, { requestId, commandId: 'command-start' }),
    envelope(
      4,
      'turn_started',
      { turn: 1, model: 'test-model' },
      {
        requestId,
        commandId: 'command-turn',
        turnId: 'turn-1',
      },
    ),
    envelope(
      5,
      'model_request_started',
      { streaming: false, model: 'test-model' },
      {
        requestId,
        turnId: 'turn-1',
        modelAttemptId: 'attempt-1',
        commandId: 'command-model',
      },
    ),
    envelope(
      6,
      'model_request_completed',
      {
        response: {
          content: 'Updated the greeting',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'RepoWrite',
              arguments: JSON.stringify({ file_path: 'src/greeting.sh' }),
            },
          ],
        },
      },
      {
        requestId,
        turnId: 'turn-1',
        modelAttemptId: 'attempt-1',
        commandId: 'command-model',
      },
    ),
    envelope(
      7,
      'tool_scheduled',
      {
        toolCallId: 'tool-1',
        toolName: 'RepoWrite',
        input: { file_path: 'src/greeting.sh' },
        modelInput: { file_path: 'src/greeting.sh' },
        sideEffect: 'non_idempotent',
        interruptBehavior: 'block',
      },
      {
        requestId,
        turnId: 'turn-1',
        modelAttemptId: 'attempt-1',
        toolAttemptId: 'tool-attempt-1',
        commandId: 'command-tool',
      },
    ),
    envelope(
      8,
      'tool_started',
      {
        toolCallId: 'tool-1',
        toolName: 'RepoWrite',
        input: { file_path: 'src/greeting.sh' },
        sideEffect: 'non_idempotent',
      },
      {
        requestId,
        turnId: 'turn-1',
        toolAttemptId: 'tool-attempt-1',
        commandId: 'command-tool',
      },
    ),
    envelope(
      9,
      'tool_completed',
      {
        toolCallId: 'tool-1',
        toolName: 'RepoWrite',
        result: { changed: true },
      },
      {
        requestId,
        turnId: 'turn-1',
        toolAttemptId: 'tool-attempt-1',
        commandId: 'command-tool',
      },
    ),
  ];
}

/**
 * The same journal after the request finished normally. This is the case repair
 * exists for: execution is done, so the execution projection has already dropped
 * the request and the turn, but the assistant message never reached the transcript.
 */
function journalWithCompletedRequest() {
  return [
    ...journalWithTurn(),
    envelope(
      10,
      'turn_completed',
      { turn: 1, hasToolCalls: true },
      {
        requestId,
        turnId: 'turn-1',
        commandId: 'command-done',
      },
    ),
    envelope(11, 'request_completed', {}, { requestId, commandId: 'command-done' }),
  ];
}

/**
 * Two completed turns in one request. The gap is recorded per request, so repair
 * has to rebuild both - clearing the marker after only the newest turn would
 * leave the first answer missing while reporting success.
 */
function journalWithTwoTurns() {
  return [
    envelope(1, 'session_created', { source: 'create' }, { commandId: 'command-create' }),
    envelope(
      2,
      'request_accepted',
      { inputId: 'input-1', input: 'Fix the greeting', priority: 'next' },
      {
        requestId,
        commandId: 'command-accept',
      },
    ),
    envelope(3, 'request_started', {}, { requestId, commandId: 'command-start' }),
    envelope(
      4,
      'turn_started',
      { turn: 1, model: 'test-model' },
      {
        requestId,
        commandId: 'command-turn-1',
        turnId: 'turn-1',
      },
    ),
    envelope(
      5,
      'model_request_started',
      { streaming: false, model: 'test-model' },
      {
        requestId,
        turnId: 'turn-1',
        modelAttemptId: 'attempt-1',
        commandId: 'command-model-1',
      },
    ),
    envelope(
      6,
      'model_request_completed',
      { response: { content: 'first answer' } },
      {
        requestId,
        turnId: 'turn-1',
        modelAttemptId: 'attempt-1',
        commandId: 'command-model-1',
      },
    ),
    envelope(
      7,
      'turn_completed',
      { turn: 1, hasToolCalls: false },
      {
        requestId,
        turnId: 'turn-1',
        commandId: 'command-end-1',
      },
    ),
    envelope(
      8,
      'turn_started',
      { turn: 2, model: 'test-model' },
      {
        requestId,
        commandId: 'command-turn-2',
        turnId: 'turn-2',
      },
    ),
    envelope(
      9,
      'model_request_started',
      { streaming: false, model: 'test-model' },
      {
        requestId,
        turnId: 'turn-2',
        modelAttemptId: 'attempt-2',
        commandId: 'command-model-2',
      },
    ),
    envelope(
      10,
      'model_request_completed',
      { response: { content: 'second answer' } },
      {
        requestId,
        turnId: 'turn-2',
        modelAttemptId: 'attempt-2',
        commandId: 'command-model-2',
      },
    ),
    envelope(
      11,
      'turn_completed',
      { turn: 2, hasToolCalls: false },
      {
        requestId,
        turnId: 'turn-2',
        commandId: 'command-done',
      },
    ),
    envelope(12, 'request_completed', {}, { requestId, commandId: 'command-done' }),
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

type RepairPersistenceDouble = Mocked<HistoryRepairStore>;

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
        tool_calls: [
          {
            id: ToolUseId('tool-1'),
            type: 'function',
            function: { name: 'RepoWrite', arguments: '{}' },
          },
        ],
      } as never);
      return MessageId('message-assistant');
    }),
    // A real store writes the tool message and settles the tool-call record. A
    // double that only returns an ID would let repair believe a result exists
    // when nothing was persisted.
    saveToolUse: vi.fn(
      async (_sessionId, toolName, _input, _parent, _subagent, requestedToolCallId) => {
        const messageId = MessageId('message-tool');
        state.messages.push({
          id: messageId,
          role: 'tool',
          content: '',
          tool_call_id: String(requestedToolCallId ?? 'tool-1'),
          name: toolName,
        } as never);
        return { messageId, toolCallId: requestedToolCallId ?? ToolUseId('tool-1') };
      },
    ),
    saveToolResult: vi.fn(async (_sessionId, toolCallId, toolName, output) => {
      state.toolCalls.push({
        id: toolCallId,
        name: toolName,
        input: {},
        output,
        messageId: MessageId('message-tool'),
        timestamp: 1,
        status: 'success',
      } as never);
      return MessageId('message-tool');
    }),
    clearHistoryGap: vi.fn(async () => {
      state.historyProgress = { state: 'complete', updatedAt: 3, repairedMessages: 3 };
    }),
    read: vi.fn(async (_sessionId, { after }: { after?: number } = {}) => {
      const remaining =
        after === undefined
          ? events
          : events.filter(
              (event) => Number((event as { sequence: number }).sequence) > Number(after),
            );
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

    const result = await repairSessionHistory({ persistence, sessionId });

    expect(result).toMatchObject({
      repaired: true,
      reason: 'repaired',
      userMessages: 1,
      assistantMessages: 1,
      toolMessages: 1,
      missing: [],
    });
    expect(persistence.saveAppliedInputMessage).toHaveBeenCalledWith(
      sessionId,
      InputId('input-1'),
      requestId,
      'Fix the greeting',
      null,
    );
    expect(persistence.saveMessage).toHaveBeenCalledWith(
      sessionId,
      'assistant',
      'Updated the greeting',
      expect.anything(),
      expect.anything(),
    );
    expect(persistence.saveToolResult).toHaveBeenCalledWith(
      sessionId,
      ToolUseId('tool-1'),
      'RepoWrite',
      { changed: true },
      expect.anything(),
      undefined,
    );
    expect(persistence.clearHistoryGap).toHaveBeenCalledWith(sessionId, 3, {
      coveredRequestId: requestId,
    });
    expect(state.historyProgress?.state).toBe('complete');
  });

  it('rebuilds a request that already completed normally', async () => {
    // The execution projection drops a finished request and turn, so repair has to
    // read them out of the journal's history rather than its active state.
    const state = stateWithGap();
    const persistence = createPersistence(state, journalWithCompletedRequest());

    const result = await repairSessionHistory({ persistence, sessionId });

    expect(result).toMatchObject({
      repaired: true,
      reason: 'repaired',
      userMessages: 1,
      assistantMessages: 1,
      toolMessages: 1,
      missing: [],
    });
    expect(persistence.saveMessage).toHaveBeenCalledWith(
      sessionId,
      'assistant',
      'Updated the greeting',
      expect.anything(),
      expect.anything(),
    );
  });

  it('rebuilds every turn of the request when the gap names no turn', async () => {
    const state = stateWithGap();
    const persistence = createPersistence(state, journalWithTwoTurns());

    const result = await repairSessionHistory({ persistence, sessionId });

    expect(result).toMatchObject({ repaired: true, assistantMessages: 2, missing: [] });
    expect(persistence.saveMessage).toHaveBeenCalledWith(
      sessionId,
      'assistant',
      'first answer',
      expect.anything(),
      expect.anything(),
    );
    expect(persistence.saveMessage).toHaveBeenCalledWith(
      sessionId,
      'assistant',
      'second answer',
      expect.anything(),
      expect.anything(),
    );
  });

  it('repairs the request the gap belongs to, not whichever one is active', async () => {
    const state = stateWithGap({
      historyProgress: {
        state: 'failed',
        updatedAt: 2,
        detail: 'write failed',
        requestId: RequestId('request-other'),
      },
    });
    const persistence = createPersistence(state, journalWithCompletedRequest());

    const result = await repairSessionHistory({ persistence, sessionId });

    expect(result).toMatchObject({ repaired: false, reason: 'insufficient-durable-data' });
    expect(result.missing).toContain('request:request-other');
    expect(persistence.saveMessage).not.toHaveBeenCalled();
    expect(persistence.clearHistoryGap).not.toHaveBeenCalled();
  });

  it('writes nothing on a second pass and still closes the gap', async () => {
    const state = stateWithGap();
    const persistence = createPersistence(state);
    await repairSessionHistory({ persistence, sessionId });
    persistence.saveAppliedInputMessage.mockClear();
    persistence.saveMessage.mockClear();
    persistence.saveToolResult.mockClear();
    persistence.clearHistoryGap.mockClear();

    // The transcript now holds every message the journal knows about, so a repeated
    // repair is a no-op rather than a duplicate.
    state.messages.push(
      {
        id: MessageId('user-1'),
        role: 'user',
        content: 'Fix the greeting',
        correlation: { inputId: InputId('input-1'), requestId },
      },
      {
        id: MessageId('assistant-1'),
        role: 'assistant',
        content: 'Updated the greeting',
        tool_calls: [
          {
            id: ToolUseId('tool-1'),
            type: 'function',
            function: { name: 'RepoWrite', arguments: '{}' },
          },
        ],
      },
    );
    state.toolCalls.push({
      id: ToolUseId('tool-1'),
      name: 'RepoWrite',
      input: {},
      status: 'success',
      timestamp: 1,
    });
    state.historyProgress = { state: 'failed', updatedAt: 4, detail: 'write failed' };

    const result = await repairSessionHistory({ persistence, sessionId });

    expect(result.repaired).toBe(true);
    expect(result.repairedMessages).toBe(0);
    expect(persistence.saveAppliedInputMessage).not.toHaveBeenCalled();
    expect(persistence.saveMessage).not.toHaveBeenCalled();
    expect(persistence.saveToolResult).not.toHaveBeenCalled();
    expect(persistence.clearHistoryGap).toHaveBeenCalledWith(sessionId, 0, {
      coveredRequestId: requestId,
    });
  });

  it('rebuilds a tool result whose declaration survived but whose result did not', async () => {
    // The assistant message declaring the call is present and the tool-call record
    // is still `pending`: the model asked for the call, but the result never landed.
    const state = stateWithGap({
      messages: [
        {
          id: MessageId('assistant-declared'),
          role: 'assistant',
          content: 'Updated the greeting',
          tool_calls: [
            {
              id: ToolUseId('tool-1'),
              type: 'function',
              function: { name: 'RepoWrite', arguments: '{}' },
            },
          ],
        },
      ],
      toolCalls: [
        { id: ToolUseId('tool-1'), name: 'RepoWrite', input: {}, status: 'pending', timestamp: 1 },
      ],
    } as Partial<SessionState>);
    const persistence = createPersistence(state);

    const result = await repairSessionHistory({ persistence, sessionId });

    expect(result.repaired).toBe(true);
    // A declaration is not a result: the result has to be written.
    expect(persistence.saveToolResult).toHaveBeenCalledWith(
      sessionId,
      ToolUseId('tool-1'),
      'RepoWrite',
      { changed: true },
      expect.anything(),
      undefined,
    );
  });

  it('propagates a tool result write failure without clearing the gap', async () => {
    const state = stateWithGap();
    const persistence = createPersistence(state);
    persistence.saveToolResult.mockRejectedValue(new Error('tool result write failed'));

    await expect(repairSessionHistory({ persistence, sessionId })).rejects.toThrow(
      'tool result write failed',
    );
    expect(persistence.clearHistoryGap).not.toHaveBeenCalled();
  });

  it('keeps the gap open when a write does not actually land', async () => {
    const state = stateWithGap();
    const persistence = createPersistence(state);
    // The write reports success but nothing reaches the transcript: claiming the
    // gap is closed would present a partial rebuild as a whole history.
    persistence.saveMessage.mockImplementation(async () => MessageId('message-assistant'));

    const result = await repairSessionHistory({ persistence, sessionId });

    expect(result).toMatchObject({ repaired: false, reason: 'insufficient-durable-data' });
    expect(result.missing).toContain('assistant-message');
    expect(persistence.clearHistoryGap).not.toHaveBeenCalled();
  });

  it('calls the journal read with its receiver intact', async () => {
    const state = stateWithGap();
    const events = journalWithCompletedRequest();
    // A real tenant adapter resolves its runtime through `this`, so detaching the
    // method from the object breaks it.
    class TenantAdapter implements HistoryRepairStore {
      readCalled = false;
      private readonly runtime = {
        read: async (_id: SessionId, options: DurableEventReadOptions = {}) => {
          const remaining =
            options.after === undefined
              ? events
              : events.filter(
                  (event) =>
                    Number((event as { sequence: number }).sequence) > Number(options.after),
                );
          return {
            events: remaining,
            hasMore: false,
            nextCursor: null,
            headSequence: EventSequence(events.length),
          };
        },
      };
      async loadState() {
        return state;
      }
      async saveAppliedInputMessage() {
        return MessageId('message-user');
      }
      async saveMessage() {
        return MessageId('message-assistant');
      }
      async saveToolUse() {
        return { messageId: MessageId('message-tool'), toolCallId: ToolUseId('tool-1') };
      }
      async saveToolResult() {
        return MessageId('message-tool');
      }
      async clearHistoryGap() {
        state.historyProgress = { state: 'complete', updatedAt: 3 };
      }
      read(session: SessionId, options?: DurableEventReadOptions) {
        this.readCalled = true;
        if (!this.runtime) {
          throw new TypeError("Cannot read properties of undefined (reading 'runtime')");
        }
        return this.runtime.read(session, options);
      }
    }

    const persistence = new TenantAdapter();
    const result = await repairSessionHistory({
      persistence,
      sessionId,
    });

    expect(persistence.readCalled).toBe(true);
    expect(result.reason).toBe('insufficient-durable-data');
  });

  it('leaves the gap open when the journal cannot supply the missing pieces', async () => {
    const state = stateWithGap();
    const persistence = createPersistence(state, []);

    const result = await repairSessionHistory({ persistence, sessionId });

    expect(result).toMatchObject({ repaired: false, reason: 'insufficient-durable-data' });
    expect(result.missing).toContain('active-request');
    expect(persistence.clearHistoryGap).not.toHaveBeenCalled();
    expect(state.historyProgress?.state).toBe('failed');
  });

  it('does nothing when there is no recorded gap', async () => {
    const state = stateWithGap({ historyProgress: { state: 'in_progress', updatedAt: 5 } });
    const persistence = createPersistence(state);

    const result = await repairSessionHistory({ persistence, sessionId });

    expect(result).toMatchObject({ repaired: false, reason: 'no-gap' });
    expect(persistence.read).not.toHaveBeenCalled();
  });
});

describe('projectDurableHistory', () => {
  it('keeps requests and turns the execution projection discarded', () => {
    const history = projectDurableHistory(journalWithCompletedRequest() as never);

    // The live projection is already empty: the request completed.
    expect(history.projection.activeRequest).toBeNull();
    expect(history.requests.get(requestId)?.inputId).toBe(InputId('input-1'));
    expect(history.turns.get('turn-1' as never)?.toolAttempts).toHaveLength(1);
    expect(history.lastTurnByRequest.get(requestId)).toBe('turn-1');
    expect(history.lastRequestId).toBe(requestId);
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
    expect(
      mergeHistoryProgress(gap, { state: 'complete', updatedAt: 4, repairedMessages: 2 }).state,
    ).toBe('complete');
  });

  it('never lets a later record forget the covered request', () => {
    const covered = {
      state: 'complete' as const,
      updatedAt: 1,
      coveredRequestId: RequestId('request-1'),
    };

    const writing = mergeHistoryProgress(covered, {
      state: 'in_progress',
      updatedAt: 2,
      requestId: RequestId('request-2'),
    });

    // Coverage is a statement about durable messages; a record that omits it must
    // not make the projection forget what it already holds.
    expect(writing.coveredRequestId).toBe(RequestId('request-1'));
  });

  it('does not advance the covered request past an open gap', () => {
    const gap = {
      state: 'failed' as const,
      updatedAt: 1,
      requestId: RequestId('request-2'),
      coveredRequestId: RequestId('request-1'),
    };

    const later = mergeHistoryProgress(gap, {
      state: 'complete',
      updatedAt: 2,
      requestId: RequestId('request-3'),
      coveredRequestId: RequestId('request-3'),
    });

    expect(later.state).toBe('failed');
    expect(later.coveredRequestId).toBe(RequestId('request-1'));
  });
});
