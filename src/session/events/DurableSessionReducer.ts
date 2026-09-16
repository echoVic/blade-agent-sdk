import { reduceModelEvent } from './DurableModelReducer.js';
import { DurableEventProjectionError, invalid } from './DurableReducerContext.js';
import { reduceRequestEvent } from './DurableRequestReducer.js';
import type { DurableSessionState } from './DurableSessionState.js';
import { hasCrossedNonIdempotentBoundary, reduceToolEvent } from './DurableToolReducer.js';
import { type DurableEventEnvelope, DurableEventType } from './types.js';

export { DurableEventProjectionError, hasCrossedNonIdempotentBoundary };

export function assertNewEventBoundary(
  state: DurableSessionState,
  event: DurableEventEnvelope,
): void {
  if (event.type === DurableEventType.INPUT_APPLIED && state.activeRequest?.activeTurn) {
    invalid(event, 'A new input application requires a completed or aborted Turn');
  }
  if (
    event.type !== DurableEventType.REQUEST_COMPLETED &&
    event.type !== DurableEventType.REQUEST_FAILED &&
    event.type !== DurableEventType.REQUEST_INTERRUPTED
  ) {
    return;
  }
  const request = state.activeRequest;
  if (
    !request ||
    request.requestId !== event.requestId ||
    event.causationEventId === request.lastBoundaryEventId
  ) {
    return;
  }
  const terminal = state.lastTurnTerminal;
  const atomicTurnTermination =
    event.causationEventId === undefined &&
    terminal?.requestId === event.requestId &&
    terminal.commandId !== undefined &&
    terminal.commandId === event.commandId &&
    Number(terminal.sequence) + 1 === Number(event.sequence);
  if (!atomicTurnTermination) {
    invalid(event, 'A new Request terminal event requires latest-boundary causation');
  }
}

function reduceDurableEvent(state: DurableSessionState, event: DurableEventEnvelope): void {
  switch (event.type) {
    case DurableEventType.SESSION_CREATED:
    case DurableEventType.SESSION_CLOSED:
    case DurableEventType.REQUEST_ACCEPTED:
    case DurableEventType.REQUEST_STARTED:
    case DurableEventType.REQUEST_COMPLETED:
    case DurableEventType.REQUEST_FAILED:
    case DurableEventType.REQUEST_INTERRUPTED:
    case DurableEventType.TURN_STARTED:
    case DurableEventType.TURN_COMPLETED:
    case DurableEventType.TURN_ABORTED:
    case DurableEventType.INPUT_APPLIED:
      reduceRequestEvent(state, event);
      return;

    case DurableEventType.MODEL_REQUEST_STARTED:
    case DurableEventType.MODEL_REQUEST_COMPLETED:
    case DurableEventType.MODEL_REQUEST_FAILED:
    case DurableEventType.MODEL_REQUEST_ABORTED:
      reduceModelEvent(state, event);
      return;

    case DurableEventType.TOOL_SCHEDULED:
    case DurableEventType.PERMISSION_REQUESTED:
    case DurableEventType.PERMISSION_RESOLVED:
    case DurableEventType.TOOL_STARTED:
    case DurableEventType.TOOL_COMPLETED:
    case DurableEventType.TOOL_FAILED:
    case DurableEventType.TOOL_CANCELLED:
    case DurableEventType.TOOL_OUTCOME_UNKNOWN:
      reduceToolEvent(state, event);
      return;
  }
}

export function applyDurableEvent(state: DurableSessionState, event: DurableEventEnvelope): void {
  const expectedSequence = Number(state.headSequence ?? 0) + 1;
  if (event.sequence !== expectedSequence) {
    invalid(event, `Expected sequence ${expectedSequence}, received ${event.sequence}`);
  }
  if (state.sessionId && event.sessionId !== state.sessionId) {
    invalid(event, `Expected session ${state.sessionId}, received ${event.sessionId}`);
  }
  if (state.seenEventIds.has(event.eventId)) {
    invalid(event, `Event ID ${event.eventId} was already used`);
  }
  if (event.causationEventId && !state.seenEventIds.has(event.causationEventId)) {
    invalid(event, `Causation event ${event.causationEventId} has not been observed`);
  }
  state.seenEventIds.add(event.eventId);
  reduceDurableEvent(state, event);
  state.schemaVersion = event.schemaVersion;
  state.headSequence = event.sequence;
  state.lastEventId = event.eventId;
}
