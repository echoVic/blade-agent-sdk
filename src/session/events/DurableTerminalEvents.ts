import type {
  EventId,
  InputId,
  ModelAttemptId,
  RequestId,
  ToolAttemptId,
  ToolUseId,
  TurnId,
} from '../../types/identifiers.js';
import type { JsonValue } from '../../types/json.js';
import type { DurableCommandEventDraft } from './DurableSessionJournal.js';
import {
  type DurableEventError,
  DurableEventType,
  type DurableModelRequestAbortReason,
  type DurableModelResponse,
  type DurableRequestInterruptReason,
  type DurableTokenUsage,
  type DurableToolCancelReason,
  type DurableToolOutcomeUnknownReason,
} from './types.js';

export type RequestTerminalOutcome =
  | { status: 'completed'; output?: JsonValue; usage?: DurableTokenUsage }
  | { status: 'failed'; error: DurableEventError }
  | { status: 'interrupted'; reason: DurableRequestInterruptReason; byInputId?: InputId };

export function requestTerminalEvent(
  requestId: RequestId,
  causationEventId: EventId,
  outcome: RequestTerminalOutcome,
): DurableCommandEventDraft {
  if (outcome.status === 'completed') {
    return {
      type: DurableEventType.REQUEST_COMPLETED,
      requestId,
      causationEventId,
      data: {
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
      },
    };
  }
  if (outcome.status === 'failed') {
    return {
      type: DurableEventType.REQUEST_FAILED,
      requestId,
      causationEventId,
      data: { error: outcome.error },
    };
  }
  return {
    type: DurableEventType.REQUEST_INTERRUPTED,
    requestId,
    causationEventId,
    data: {
      reason: outcome.reason,
      ...(outcome.byInputId ? { byInputId: outcome.byInputId } : {}),
    },
  };
}

export type ModelTerminalOutcome =
  | { status: 'completed'; response: DurableModelResponse }
  | { status: 'failed'; error: DurableEventError }
  | { status: 'aborted'; reason: DurableModelRequestAbortReason };

export function modelTerminalEvent(
  scope: {
    requestId: RequestId;
    turnId: TurnId;
    modelAttemptId: ModelAttemptId;
  },
  outcome: ModelTerminalOutcome,
): DurableCommandEventDraft {
  if (outcome.status === 'completed') {
    return {
      type: DurableEventType.MODEL_REQUEST_COMPLETED,
      ...scope,
      data: { response: outcome.response },
    };
  }
  if (outcome.status === 'failed') {
    return {
      type: DurableEventType.MODEL_REQUEST_FAILED,
      ...scope,
      data: { error: outcome.error },
    };
  }
  return {
    type: DurableEventType.MODEL_REQUEST_ABORTED,
    ...scope,
    data: { reason: outcome.reason },
  };
}

export type ToolTerminalOutcome =
  | { status: 'completed'; result: JsonValue }
  | { status: 'failed'; error: DurableEventError }
  | { status: 'cancelled'; reason: DurableToolCancelReason }
  | { status: 'outcome_unknown'; reason: DurableToolOutcomeUnknownReason };

export function toolTerminalEvent(
  scope: {
    requestId: RequestId;
    turnId: TurnId;
    toolAttemptId: ToolAttemptId;
    toolCallId: ToolUseId;
    toolName: string;
  },
  outcome: ToolTerminalOutcome,
): DurableCommandEventDraft {
  const { toolCallId, toolName, ...correlation } = scope;
  const identity = { toolCallId, toolName };
  if (outcome.status === 'completed') {
    return {
      type: DurableEventType.TOOL_COMPLETED,
      ...correlation,
      data: { ...identity, result: outcome.result },
    };
  }
  if (outcome.status === 'failed') {
    return {
      type: DurableEventType.TOOL_FAILED,
      ...correlation,
      data: { ...identity, error: outcome.error },
    };
  }
  if (outcome.status === 'cancelled') {
    return {
      type: DurableEventType.TOOL_CANCELLED,
      ...correlation,
      data: { ...identity, reason: outcome.reason },
    };
  }
  return {
    type: DurableEventType.TOOL_OUTCOME_UNKNOWN,
    ...correlation,
    data: { ...identity, reason: outcome.reason },
  };
}
