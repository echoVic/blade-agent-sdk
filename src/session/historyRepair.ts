import type { ConversationMessage } from '../model/conversation.js';
import type {
  EventSequence,
  InputId,
  MessageId,
  RequestId,
  SessionId,
  ToolUseId,
  TurnId,
} from '../types/identifiers.js';
import type { JsonValue } from '../types/json.js';
import type { DurableEventStore } from './events/DurableEventStore.js';
import {
  type DurableRequestProjection,
  type DurableSessionProjection,
  DurableSessionProjector,
  type DurableTurnProjection,
} from './events/DurableSessionProjector.js';
import { type DurableEventEnvelope, DurableEventType } from './events/types.js';
import { hasHistoryGap, type SessionHistoryProgress } from './historyProgress.js';
import type { SessionEventStore, SessionRepository } from './SessionRepository.js';
import type { SessionToolCallState } from './SessionStore.js';

/** How much of the durable journal one repair pass replays. */
const REPAIR_PAGE_SIZE = 500;
const REPAIR_PAGE_LIMIT = 200;

/** Events that drop the state a repair needs, so it is captured before them. */
const REQUEST_TERMINAL_TYPES: readonly string[] = [
  DurableEventType.REQUEST_COMPLETED,
  DurableEventType.REQUEST_FAILED,
  DurableEventType.REQUEST_INTERRUPTED,
];
const TURN_TERMINAL_TYPES: readonly string[] = [
  DurableEventType.TURN_COMPLETED,
  DurableEventType.TURN_ABORTED,
];
const TERMINAL_TYPES = new Set<string>([...REQUEST_TERMINAL_TYPES, ...TURN_TERMINAL_TYPES]);

export type HistoryRepairReason = 'repaired' | 'no-gap' | 'insufficient-durable-data';

export interface HistoryRepairResult {
  readonly repaired: boolean;
  readonly reason: HistoryRepairReason;
  readonly repairedMessages: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolMessages: number;
  /** Pieces the journal could not supply, so the gap stays open. */
  readonly missing: readonly string[];
}

export type HistoryRepairStore = Pick<SessionRepository, 'loadState'> &
  Pick<
    SessionEventStore,
    'saveAppliedInputMessage' | 'saveMessage' | 'saveToolResult' | 'saveToolUse'
  > &
  Required<Pick<SessionEventStore, 'clearHistoryGap'>> &
  Pick<DurableEventStore, 'read'>;

export interface HistoryRepairOptions {
  /** Complete tenant-scoped repair port: transcript writes plus durable reads. */
  readonly persistence: HistoryRepairStore;
  readonly sessionId: SessionId;
  readonly signal?: AbortSignal;
}

/**
 * The durable journal as a *history*, not as an execution state.
 *
 * `DurableSessionProjector` keeps only what is still active: a completed turn and a
 * completed request are dropped the moment they end, which is exactly what execution
 * recovery needs and exactly what repair cannot use - the case repair exists for is
 * "execution finished, the assistant message did not". This projection therefore
 * retains the last known state of every Request and Turn, captured immediately before
 * the event that would discard it.
 */
export interface DurableHistoryProjection {
  /** The live execution projection, for callers that also need active state. */
  readonly projection: DurableSessionProjection;
  readonly requests: ReadonlyMap<RequestId, DurableRequestProjection>;
  readonly turns: ReadonlyMap<TurnId, DurableTurnProjection>;
  /** Every turn each request reached, in order. */
  readonly turnsByRequest: ReadonlyMap<RequestId, readonly TurnId[]>;
  /** The newest turn each request reached. */
  readonly lastTurnByRequest: ReadonlyMap<RequestId, TurnId>;
  readonly lastRequestId: RequestId | null;
}

export function projectDurableHistory(
  events: readonly DurableEventEnvelope[],
): DurableHistoryProjection {
  const projector = new DurableSessionProjector();
  const requests = new Map<RequestId, DurableRequestProjection>();
  const turns = new Map<TurnId, DurableTurnProjection>();
  const turnsByRequest = new Map<RequestId, TurnId[]>();
  const lastTurnByRequest = new Map<RequestId, TurnId>();
  let lastRequestId: RequestId | null = null;

  const capture = (snapshot: DurableSessionProjection): void => {
    const request = snapshot.activeRequest;
    if (!request) {
      return;
    }
    requests.set(request.requestId, request);
    lastRequestId = request.requestId;
    const turn = request.activeTurn;
    if (turn) {
      turns.set(turn.turnId, turn);
      lastTurnByRequest.set(request.requestId, turn.turnId);
      const seen = turnsByRequest.get(request.requestId);
      if (!seen) {
        turnsByRequest.set(request.requestId, [turn.turnId]);
      } else if (!seen.includes(turn.turnId)) {
        seen.push(turn.turnId);
      }
    }
  };

  for (const event of events) {
    if (TERMINAL_TYPES.has(event.type)) {
      capture(projector.snapshot());
    }
    projector.apply([event]);
  }
  capture(projector.snapshot());

  return {
    projection: projector.snapshot(),
    requests,
    turns,
    turnsByRequest,
    lastTurnByRequest,
    lastRequestId,
  };
}

/**
 * Rebuild transcript messages the projection lost, from the durable journal.
 *
 * The journal is the authority for *what happened*; the transcript is the authority
 * for how it is rendered. Repair therefore only writes data - it never re-runs a
 * model call or a tool - and matches each write to a stable identity so a repeated
 * pass changes nothing:
 *
 * - a request's accepted input becomes the user message (`inputId`),
 * - a completed tool attempt becomes its result (`toolCallId`),
 * - a completed model attempt becomes the assistant message of that turn (matched
 *   through the tool calls it requested).
 *
 * The scope is the Request and Turn the *gap* belongs to, read from the gap record
 * itself. Reusing the live execution projection would miss the most important case -
 * a request that finished normally while its assistant message was lost - because
 * that projection has already discarded the finished request.
 *
 * A gap is closed only when every piece the journal knows about is present *after*
 * the writes, verified against a fresh read of the transcript. When the journal
 * itself was trimmed, or a write did not land, the gap stays open and
 * `insufficient-durable-data` is reported, because a partial rebuild must not be
 * presented as a whole history.
 */
export async function repairSessionHistory(
  options: HistoryRepairOptions,
): Promise<HistoryRepairResult> {
  const { persistence, sessionId, signal } = options;
  const empty = {
    repaired: false,
    repairedMessages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolMessages: 0,
  } as const;

  const state = await persistence.loadState(sessionId);
  const progress = state?.historyProgress;
  if (!hasHistoryGap(progress)) {
    return { ...empty, reason: 'no-gap', missing: [] };
  }
  const events = await readJournal(persistence, sessionId, signal);
  const history = projectDurableHistory(events);
  const scope = resolveRepairScope(history, progress);
  if (!scope.request) {
    return { ...empty, reason: 'insufficient-durable-data', missing: scope.missing };
  }
  const request = scope.request;
  const turns = scope.turns;

  const missing = new Set<string>();
  let repairedMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;
  let parentMessageId: MessageId | null = state?.messages.at(-1)?.id
    ? (String(state.messages.at(-1)?.id) as MessageId)
    : null;

  const transcript = {
    messages: [...(state?.messages ?? [])] as ConversationMessage[],
    toolCalls: [...(state?.toolCalls ?? [])] as SessionToolCallState[],
  };

  if (!hasUserMessage(transcript.messages, request.inputId) && typeof request.input === 'string') {
    const written = await persistence.saveAppliedInputMessage(
      sessionId,
      request.inputId,
      request.requestId,
      request.input,
      parentMessageId,
    );
    parentMessageId = written;
    transcript.messages.push({
      id: written,
      role: 'user',
      content: request.input,
      correlation: { inputId: request.inputId, requestId: request.requestId },
    });
    repairedMessages += 1;
    userMessages += 1;
  }

  if (turns.length === 0) {
    // Without a turn the journal holds no assistant or tool output to rebuild. The
    // input is still repaired, but the gap cannot be closed.
    missing.add('turn');
  }

  for (const turn of turns) {
    const toolCallIds = new Set<string>();
    for (const attempt of turn.toolAttempts) {
      toolCallIds.add(String(attempt.toolCallId));
    }

    for (const attempt of turn.toolAttempts) {
      if (attempt.status !== 'completed' && attempt.status !== 'failed') {
        continue;
      }
      // A tool *declaration* in an assistant message only proves the model asked
      // for the call; it says nothing about whether the result was persisted.
      if (hasToolResult(transcript, attempt.toolCallId)) {
        continue;
      }
      const { messageId } = await persistence.saveToolUse(
        sessionId,
        attempt.toolName,
        attempt.input as JsonValue,
        parentMessageId,
        undefined,
        attempt.toolCallId,
      );
      await persistence.saveToolResult(
        sessionId,
        attempt.toolCallId,
        attempt.toolName,
        (attempt.result ?? null) as JsonValue,
        messageId,
        attempt.error?.message,
      );
      parentMessageId = messageId;
      transcript.toolCalls.push({
        id: attempt.toolCallId,
        name: attempt.toolName,
        input: attempt.input as JsonValue,
        output: (attempt.result ?? null) as JsonValue,
        messageId,
        timestamp: Date.now(),
        status: attempt.status === 'failed' ? 'error' : 'success',
        ...(attempt.error?.message ? { error: attempt.error.message } : {}),
      });
      transcript.messages.push({
        id: messageId,
        role: 'tool',
        content: '',
        tool_call_id: String(attempt.toolCallId),
        name: attempt.toolName,
      });
      repairedMessages += 1;
      toolMessages += 1;
    }

    const response = turn.modelAttempts.find(
      (attempt) => attempt.status === 'completed' && attempt.response !== undefined,
    )?.response;
    const requiresAssistant =
      !isBlankContent(response?.content) ||
      Boolean(response?.reasoningContent) ||
      (response?.toolCalls?.length ?? 0) > 0 ||
      toolCallIds.size > 0;
    if (!response) {
      // The journal never saw a completed model attempt, so there is nothing to
      // rebuild even though the transcript is missing content.
      missing.add('assistant-message');
    } else if (
      requiresAssistant &&
      !hasAssistantMessage(transcript.messages, toolCallIds, response.content)
    ) {
      await persistence.saveMessage(sessionId, 'assistant', response.content, parentMessageId, {
        reasoningContent: response.reasoningContent,
        toolCalls: response.toolCalls?.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      transcript.messages.push({
        role: 'assistant',
        content: response.content,
        ...(response.toolCalls
          ? {
              tool_calls: response.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });
      repairedMessages += 1;
      assistantMessages += 1;
    }
  }

  // Never trust the writes: re-read the transcript and confirm every piece the
  // journal knows about is really there before telling anyone the gap is closed.
  const verified = await persistence.loadState(sessionId);
  if (verified) {
    const messages = verified.messages as ConversationMessage[];
    const toolCalls = verified.toolCalls as SessionToolCallState[];
    const stillMissing = new Set(missing);
    if (!hasUserMessage(messages, request.inputId) && typeof request.input === 'string') {
      stillMissing.add(`user:${String(request.inputId)}`);
    }
    for (const turn of turns) {
      for (const attempt of turn.toolAttempts) {
        if (attempt.status !== 'completed' && attempt.status !== 'failed') {
          continue;
        }
        if (!hasToolResult({ messages, toolCalls }, attempt.toolCallId)) {
          stillMissing.add(`tool:${String(attempt.toolCallId)}`);
        }
      }
      const response = turn.modelAttempts.find(
        (attempt) => attempt.status === 'completed' && attempt.response !== undefined,
      )?.response;
      const declared = new Set(turn.toolAttempts.map((attempt) => String(attempt.toolCallId)));
      if (response && (declared.size > 0 || !isBlankContent(response.content))) {
        if (!hasAssistantMessage(messages, declared, response.content)) {
          stillMissing.add('assistant-message');
        }
      }
    }
    if (stillMissing.size > 0) {
      return {
        repaired: false,
        reason: 'insufficient-durable-data',
        repairedMessages,
        userMessages,
        assistantMessages,
        toolMessages,
        missing: [...stillMissing],
      };
    }
  }

  if (missing.size > 0) {
    return {
      repaired: false,
      reason: 'insufficient-durable-data',
      repairedMessages,
      userMessages,
      assistantMessages,
      toolMessages,
      missing: [...missing],
    };
  }

  await persistence.clearHistoryGap(sessionId, repairedMessages, {
    coveredRequestId: request.requestId,
  });
  return {
    repaired: true,
    reason: 'repaired',
    repairedMessages,
    userMessages,
    assistantMessages,
    toolMessages,
    missing: [],
  };
}

/**
 * The Request and Turn the recorded gap belongs to.
 *
 * When the gap carries a Request, that Request - and only that one - is repaired:
 * fixing whatever happens to be active would be silent data corruption.
 */
function resolveRepairScope(
  history: DurableHistoryProjection,
  progress: SessionHistoryProgress | undefined,
): {
  request?: DurableRequestProjection;
  turns: readonly DurableTurnProjection[];
  missing: string[];
} {
  const gapRequestId = progress?.requestId;
  if (gapRequestId) {
    const request = history.requests.get(gapRequestId);
    if (!request) {
      return { missing: [`request:${String(gapRequestId)}`], turns: [] };
    }
    return { request, turns: resolveTurns(history, request, progress), missing: [] };
  }
  const lastRequestId = history.lastRequestId;
  const request = lastRequestId ? history.requests.get(lastRequestId) : undefined;
  if (!request) {
    return { missing: ['active-request'], turns: [] };
  }
  return { request, turns: resolveTurns(history, request, progress), missing: [] };
}

/**
 * The turns of one request the repair has to rebuild.
 *
 * A turn is only named when the gap record carries one. Otherwise every turn the
 * request reached is rebuilt: the gap is recorded per request, so repairing only
 * the newest turn could clear the marker while an earlier turn's assistant message
 * is still missing.
 */
function resolveTurns(
  history: DurableHistoryProjection,
  request: DurableRequestProjection,
  progress: SessionHistoryProgress | undefined,
): readonly DurableTurnProjection[] {
  const named = progress?.turnId ? history.turns.get(progress.turnId) : undefined;
  if (named) {
    return [named];
  }
  const turnIds = history.turnsByRequest.get(request.requestId) ?? [];
  const turns = turnIds.flatMap((turnId) => history.turns.get(turnId) ?? []);
  return turns.length > 0 ? turns : request.activeTurn ? [request.activeTurn] : [];
}

function hasUserMessage(messages: readonly ConversationMessage[], inputId: InputId): boolean {
  return messages.some((message) => message.correlation?.inputId === inputId);
}

/**
 * Whether the *result* of a tool call reached the transcript.
 *
 * A tool call declaration in an assistant message only proves the model asked for
 * the call; the result is a separate write that can fail on its own.
 */
function hasToolResult(
  transcript: {
    messages: readonly ConversationMessage[];
    toolCalls: readonly SessionToolCallState[];
  },
  toolCallId: ToolUseId,
): boolean {
  return (
    transcript.toolCalls.some((call) => call.id === toolCallId && call.status !== 'pending') ||
    transcript.messages.some(
      (message) => message.role === 'tool' && message.tool_call_id === String(toolCallId),
    )
  );
}

function hasAssistantMessage(
  messages: readonly ConversationMessage[],
  toolCallIds: ReadonlySet<string>,
  content: string | undefined,
): boolean {
  if (toolCallIds.size > 0) {
    return messages.some(
      (message) => message.tool_calls?.some((call) => toolCallIds.has(String(call.id))) === true,
    );
  }
  return messages.some((message) => message.role === 'assistant' && message.content === content);
}

function isBlankContent(content: string | unknown[] | undefined): boolean {
  if (content === undefined) {
    return true;
  }
  return typeof content === 'string' ? content.trim() === '' : content.length === 0;
}

async function readJournal(
  persistence: HistoryRepairOptions['persistence'],
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<readonly DurableEventEnvelope[]> {
  const events: DurableEventEnvelope[] = [];
  let after: EventSequence | undefined;
  for (let page = 0; page < REPAIR_PAGE_LIMIT; page += 1) {
    signal?.throwIfAborted();
    const result = await persistence.read(sessionId, {
      ...(after === undefined ? {} : { after }),
      limit: REPAIR_PAGE_SIZE,
    });
    events.push(...result.events);
    const next = result.nextCursor;
    if (!result.hasMore || next === null || next === undefined) {
      return events;
    }
    after = next;
  }
  return events;
}
