import type { JsonValue } from '../types/json.js';
import type { InputId, MessageId, SessionId, ToolUseId } from '../types/identifiers.js';
import { projectDurableSession } from './events/DurableSessionProjector.js';
import type { DurableEventEnvelope } from './events/types.js';
import { hasHistoryGap } from './historyProgress.js';
import type { SessionEventStore, SessionRepository } from './SessionRepository.js';

/** How much of the durable journal one repair pass replays. */
const REPAIR_PAGE_SIZE = 500;
const REPAIR_PAGE_LIMIT = 200;

export type HistoryRepairReason =
  | 'repaired'
  | 'no-gap'
  | 'no-journal'
  | 'insufficient-durable-data';

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

export interface HistoryRepairOptions {
  /** The tenant-scoped persistence port: transcript writes plus durable reads. */
  readonly persistence: SessionRepository & Partial<SessionEventStore> & {
    readonly read?: (sessionId: SessionId, options?: { after?: number; limit?: number }) =>
      Promise<{ events: readonly DurableEventEnvelope[]; hasMore: boolean; nextCursor?: number | null }>;
  };
  readonly sessionId: SessionId;
  readonly signal?: AbortSignal;
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
 * A gap is closed only when every piece the journal knows about is present; when the
 * journal itself was trimmed, the gap stays open and `insufficient-durable-data` is
 * reported, because a partial rebuild must not be presented as a whole history.
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
  if (!hasHistoryGap(state?.historyProgress)) {
    return { ...empty, reason: 'no-gap', missing: [] };
  }
  if (typeof persistence.read !== 'function') {
    return { ...empty, reason: 'no-journal', missing: ['durable-journal'] };
  }

  const events = await readJournal(persistence, sessionId, signal);
  const projection = projectDurableSession(events);
  const request = projection.activeRequest;
  if (!request) {
    return { ...empty, reason: 'insufficient-durable-data', missing: ['active-request'] };
  }

  const missing: string[] = [];
  let repairedMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;
  const lastMessageId = state?.messages.at(-1)?.id;
  let parentMessageId: MessageId | null = lastMessageId
    ? (String(lastMessageId) as MessageId)
    : null;

  const hasUserMessage = (inputId: InputId): boolean =>
    (state?.messages ?? []).some((message) => message.correlation?.inputId === inputId);
  if (!hasUserMessage(request.inputId) && typeof request.input === 'string') {
    if (typeof persistence.saveAppliedInputMessage !== 'function') {
      missing.push(`user:${request.inputId}`);
    } else {
      const written = await persistence.saveAppliedInputMessage(
        sessionId,
        request.inputId,
        request.requestId,
        request.input,
        parentMessageId,
      );
      parentMessageId = written;
      repairedMessages += 1;
      userMessages += 1;
    }
  }

  const turn = request.activeTurn;
  if (!turn) {
    // Without a turn the journal holds no assistant or tool output to rebuild. The
    // input is still repaired, but the gap cannot be closed.
    missing.push('active-turn');
  } else {
    const toolCallIds = new Set<string>();
    for (const attempt of turn.toolAttempts) {
      toolCallIds.add(String(attempt.toolCallId));
    }
    const hasToolMessage = (toolCallId: ToolUseId): boolean =>
      (state?.toolCalls ?? []).some(
        (call) => call.id === toolCallId && call.status !== 'pending',
      ) ||
      (state?.messages ?? []).some((message) =>
        message.tool_calls?.some((call) => call.id === toolCallId) === true,
      );

    if (
      typeof persistence.saveToolUse === 'function' &&
      typeof persistence.saveToolResult === 'function'
    ) {
      for (const attempt of turn.toolAttempts) {
        if (attempt.status !== 'completed' && attempt.status !== 'failed') {
          continue;
        }
        if (hasToolMessage(attempt.toolCallId)) {
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
        repairedMessages += 1;
        toolMessages += 1;
      }
    } else {
      missing.push('tool-messages');
    }

    const assistant = turn.modelAttempts.find(
      (attempt) => attempt.status === 'completed' && attempt.response !== undefined,
    );
    if (!assistant?.response) {
      missing.push('assistant-message');
    } else {
      const hasAssistantMessage =
        toolCallIds.size > 0
          ? (state?.messages ?? []).some((message) =>
              message.tool_calls?.some((call) => toolCallIds.has(String(call.id))) === true,
            )
          : (state?.messages ?? []).some(
              (message) => message.role === 'assistant' && message.content === assistant.response?.content,
            );
      if (!hasAssistantMessage) {
        if (typeof persistence.saveMessage !== 'function') {
          missing.push('assistant-message');
        } else {
          await persistence.saveMessage(
            sessionId,
            'assistant',
            assistant.response.content,
            parentMessageId,
            {
              reasoningContent: assistant.response.reasoningContent,
              toolCalls: assistant.response.toolCalls?.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            },
          );
          repairedMessages += 1;
          assistantMessages += 1;
        }
      }
    }
  }

  if (missing.length > 0) {
    return {
      repaired: false,
      reason: 'insufficient-durable-data',
      repairedMessages,
      userMessages,
      assistantMessages,
      toolMessages,
      missing,
    };
  }

  await persistence.clearHistoryGap?.(sessionId, repairedMessages);
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

async function readJournal(
  persistence: HistoryRepairOptions['persistence'],
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<readonly DurableEventEnvelope[]> {
  const read = persistence.read;
  if (!read) {
    return [];
  }
  const events: DurableEventEnvelope[] = [];
  let after: number | undefined;
  for (let page = 0; page < REPAIR_PAGE_LIMIT; page += 1) {
    signal?.throwIfAborted();
    const result = await read(sessionId, {
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
