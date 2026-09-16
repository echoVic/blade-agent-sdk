import type { ModelAttemptId, ToolUseId } from '../../types/identifiers.js';
import type { JsonValue } from '../../types/json.js';
import { canonicalJson } from './canonicalJson.js';
import {
  DurableEventProjectionError,
  invalid,
  requireModel,
  requireRunningRequest,
  requireTurn,
} from './DurableReducerContext.js';
import type {
  DurableSessionState,
  MutableModelAttemptProjection,
  MutableTurnProjection,
} from './DurableSessionState.js';
import { type DurableEventEnvelope, DurableEventType } from './types.js';

function assertModelToolInput(
  event: DurableEventEnvelope,
  toolCallId: ToolUseId,
  argumentsText: string,
  modelInput: JsonValue | undefined,
): void {
  if (modelInput === undefined) {
    invalid(event, `Tool call ${toolCallId} has no original model input`);
  }
  let declaredInput: JsonValue;
  try {
    declaredInput = JSON.parse(argumentsText) as JsonValue;
  } catch (cause) {
    throw new DurableEventProjectionError(
      `Tool call ${toolCallId} has invalid model arguments`,
      event,
      { cause },
    );
  }
  if (canonicalJson(declaredInput) !== canonicalJson(modelInput)) {
    invalid(event, `Tool call ${toolCallId} input does not match the model response`);
  }
}

export function assertToolMatchesModel(
  event: DurableEventEnvelope,
  turn: MutableTurnProjection,
  toolCallId: ToolUseId,
  toolName: string,
  modelAttemptId: ModelAttemptId | undefined,
  modelInput: JsonValue | undefined,
): void {
  if (!modelAttemptId) {
    invalid(event, `Tool call ${toolCallId} has no model attempt identity`);
  }
  const attempt = turn.modelAttempts.find(
    (candidate) => candidate.modelAttemptId === modelAttemptId,
  );
  if (!attempt || turn.modelAttempts.at(-1)?.modelAttemptId !== modelAttemptId) {
    invalid(event, `Tool call ${toolCallId} does not belong to the current model attempt`);
  }
  if (attempt.status === 'started') {
    if (modelInput === undefined) {
      invalid(event, `Tool call ${toolCallId} has no original model input`);
    }
    return;
  }
  if (attempt.status !== 'completed') {
    invalid(
      event,
      `Tool call ${toolCallId} follows model attempt ${attempt.modelAttemptId} with status ${attempt.status}`,
    );
  }
  const declared = attempt.response?.toolCalls?.find((toolCall) => toolCall.id === toolCallId);
  if (!declared || declared.name !== toolName) {
    invalid(
      event,
      `Tool call ${toolCallId}/${toolName} was not declared by model attempt ${attempt.modelAttemptId}`,
    );
  }
  assertModelToolInput(event, toolCallId, declared.arguments, modelInput);
}

function assertResponseMatchesScheduledTools(
  event: DurableEventEnvelope<typeof DurableEventType.MODEL_REQUEST_COMPLETED>,
  turn: MutableTurnProjection,
): void {
  const toolCalls = event.data.response.toolCalls ?? [];
  if (new Set(toolCalls.map((tool) => tool.id)).size !== toolCalls.length) {
    invalid(event, 'Model response reused tool call ID');
  }
  for (const tool of turn.toolAttempts.filter(
    (candidate) => candidate.modelAttemptId === event.modelAttemptId,
  )) {
    const declared = toolCalls.find((toolCall) => toolCall.id === tool.toolCallId);
    if (!declared || declared.name !== tool.toolName) {
      invalid(
        event,
        `Model response does not declare durable tool call ${tool.toolCallId}/${tool.toolName}`,
      );
    }
    assertModelToolInput(event, tool.toolCallId, declared.arguments, tool.modelInput);
  }
}

export function reduceModelEvent(state: DurableSessionState, event: DurableEventEnvelope): void {
  switch (event.type) {
    case DurableEventType.MODEL_REQUEST_STARTED: {
      const request = requireRunningRequest(state, event);
      const turn = requireTurn(state, event);
      if (turn.activeModelAttempt) {
        invalid(event, `Model attempt ${turn.activeModelAttempt.modelAttemptId} is still active`);
      }
      const previous = turn.modelAttempts.at(-1);
      if (previous && previous.status !== 'failed') {
        invalid(event, `Model attempt ${previous.modelAttemptId} ended as ${previous.status}`);
      }
      if (previous && turn.toolAttempts.length > 0) {
        invalid(event, `Model attempt ${previous.modelAttemptId} dispatched tools before failing`);
      }
      if (state.seenModelAttemptIds.has(event.modelAttemptId)) {
        invalid(event, `Model attempt ID ${event.modelAttemptId} was already used`);
      }
      const attempt: MutableModelAttemptProjection = {
        modelAttemptId: event.modelAttemptId,
        model: event.data.model,
        ...(event.data.modelIdentity ? { modelIdentity: { ...event.data.modelIdentity } } : {}),
        streaming: event.data.streaming,
        status: 'started',
      };
      state.seenModelAttemptIds.add(event.modelAttemptId);
      turn.modelAttempts.push(attempt);
      turn.activeModelAttempt = attempt;
      request.lastBoundaryEventId = event.eventId;
      return;
    }

    case DurableEventType.MODEL_REQUEST_COMPLETED: {
      const request = requireRunningRequest(state, event);
      const turn = requireTurn(state, event);
      const attempt = requireModel(state, event);
      assertResponseMatchesScheduledTools(event, turn);
      attempt.status = 'completed';
      attempt.response = event.data.response;
      turn.activeModelAttempt = null;
      request.lastBoundaryEventId = event.eventId;
      return;
    }

    case DurableEventType.MODEL_REQUEST_FAILED:
    case DurableEventType.MODEL_REQUEST_ABORTED: {
      const request = requireRunningRequest(state, event);
      const turn = requireTurn(state, event);
      const attempt = requireModel(state, event);
      if (event.type === DurableEventType.MODEL_REQUEST_FAILED) {
        attempt.status = 'failed';
        attempt.error = event.data.error;
      } else {
        attempt.status = 'aborted';
        attempt.abortReason = event.data.reason;
      }
      turn.activeModelAttempt = null;
      request.lastBoundaryEventId = event.eventId;
      return;
    }
  }
}
