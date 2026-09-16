import type { InputId } from '../../types/identifiers.js';
import {
  invalid,
  requireOpen,
  requireRequest,
  requireRunningRequest,
  requireTurn,
} from './DurableReducerContext.js';
import type {
  DurableRequestProjection,
  DurableSessionState,
  MutableRequestProjection,
  MutableTurnProjection,
} from './DurableSessionState.js';
import { assertTurnCanEnd, hasCrossedNonIdempotentBoundary } from './DurableToolReducer.js';
import { type DurableEventEnvelope, DurableEventType } from './types.js';

type Event<T extends DurableEventType> = DurableEventEnvelope<T>;

export function reduceRequestEvent(state: DurableSessionState, event: DurableEventEnvelope): void {
  switch (event.type) {
    case DurableEventType.SESSION_CREATED:
      createSession(state, event);
      return;
    case DurableEventType.SESSION_CLOSED:
      closeSession(state, event);
      return;
    case DurableEventType.REQUEST_ACCEPTED:
      acceptRequest(state, event);
      return;
    case DurableEventType.REQUEST_STARTED:
      startRequest(state, event);
      return;
    case DurableEventType.REQUEST_COMPLETED:
      finishRequest(state, event, true);
      return;
    case DurableEventType.REQUEST_FAILED:
      finishRequest(state, event, false);
      return;
    case DurableEventType.REQUEST_INTERRUPTED:
      interruptRequest(state, event);
      return;
    case DurableEventType.TURN_STARTED:
      startTurn(state, event);
      return;
    case DurableEventType.TURN_COMPLETED:
      finishTurn(state, event);
      return;
    case DurableEventType.TURN_ABORTED:
      abortTurn(state, event);
      return;
    case DurableEventType.INPUT_APPLIED:
      applyInput(state, event);
      return;
  }
}

function createSession(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.SESSION_CREATED>,
): void {
  if (state.status !== 'empty') invalid(event, 'Session was already created');
  state.sessionId = event.sessionId;
  state.status = 'open';
  state.created = event.data;
}

function closeSession(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.SESSION_CLOSED>,
): void {
  requireOpen(state, event);
  if (state.activeRequest)
    invalid(event, `Request ${state.activeRequest.requestId} is still active`);
  state.status = 'closed';
  state.closeReason = event.data.reason;
}

function acceptRequest(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.REQUEST_ACCEPTED>,
): void {
  requireOpen(state, event);
  if (state.activeRequest)
    invalid(event, `Request ${state.activeRequest.requestId} is still active`);
  if (state.seenRequestIds.has(event.requestId)) {
    invalid(event, `Request ID ${event.requestId} was already used`);
  }
  if (state.seenCommandIds.has(event.commandId)) {
    invalid(event, `Command ID ${event.commandId} was already accepted`);
  }
  if (state.seenInputIds.has(event.data.inputId)) {
    invalid(event, `Input ID ${event.data.inputId} was already accepted`);
  }
  if (state.seenAppliedInputIds.has(event.data.inputId)) {
    invalid(event, `Input ID ${event.data.inputId} was already applied`);
  }

  const recovery = recoverRequest(state, event);
  state.seenRequestIds.add(event.requestId);
  state.seenCommandIds.add(event.commandId);
  state.seenInputIds.add(event.data.inputId);
  state.acceptedCommandIds.push(event.commandId);
  state.activeRequest = {
    requestId: event.requestId,
    commandId: event.commandId,
    inputId: event.data.inputId,
    input: event.data.input,
    priority: event.data.priority,
    acceptedAt: event.occurredAt,
    ...(event.data.maxTurns !== undefined ? { maxTurns: event.data.maxTurns } : {}),
    ...(event.data.model ? { model: event.data.model } : {}),
    ...(event.data.context ? { context: event.data.context } : {}),
    ...(event.data.recovery ? { recovery: event.data.recovery } : {}),
    ...(recovery.kind ? { recoveryKind: recovery.kind } : {}),
    reconciledInputIds: recovery.inputIds,
    status: 'accepted',
    appliedInputIds: [],
    pendingInputIds: [],
    lastTurn: 0,
    lastTurnEventId: null,
    lastBoundaryEventId: event.eventId,
    activeTurn: null,
  };
}

function recoverRequest(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.REQUEST_ACCEPTED>,
): { kind?: DurableRequestProjection['recoveryKind']; inputIds: InputId[] } {
  const recovery = event.data.recovery;
  if (!recovery) return { inputIds: [] };
  const origin = state.turnOrigins.get(recovery.turnId);
  const abort = state.lastTurnAbort;
  const interruption = state.lastRequestInterruption;
  const canonical =
    origin?.requestId === recovery.requestId &&
    origin.turn === recovery.turn &&
    abort?.requestId === recovery.requestId &&
    abort.turnId === recovery.turnId &&
    abort.turn === recovery.turn &&
    abort.reason === 'process_restart' &&
    abort.commandId === event.commandId &&
    interruption?.requestId === recovery.requestId &&
    interruption.reason === 'process_restart' &&
    interruption.commandId === event.commandId &&
    Number(abort.sequence) + 1 === Number(interruption.sequence) &&
    Number(interruption.sequence) + 1 === Number(event.sequence) &&
    interruption.status === 'running' &&
    interruption.lastTurn === recovery.turn;
  if (!canonical) {
    invalid(event, `Recovery origin ${recovery.turnId} is not an atomic canonical rollover`);
  }
  const synthetic =
    origin.commandId === event.commandId && Number(origin.sequence) + 1 === Number(abort.sequence);
  const inputIds = synthetic
    ? [
        ...(recovery.turn === 1 ? [interruption.inputId] : []),
        ...abort.preparedInputIds.filter(
          (inputId) => recovery.turn !== 1 || inputId !== interruption.inputId,
        ),
      ]
    : [
        interruption.inputId,
        ...interruption.appliedInputIds.filter((inputId) => inputId !== interruption.inputId),
      ];
  if (synthetic) {
    for (const inputId of inputIds) {
      if (!state.reconciledInputIds.includes(inputId)) state.reconciledInputIds.push(inputId);
    }
  } else if (origin.commandId === event.commandId) {
    invalid(event, `Recovery origin ${recovery.turnId} has a non-adjacent synthetic Turn`);
  }
  if (abort.unsafeNonIdempotentToolAttemptId) {
    invalid(
      event,
      `Recovery origin ${recovery.turnId} crossed non-idempotent tool attempt ${abort.unsafeNonIdempotentToolAttemptId}`,
    );
  }
  return { kind: synthetic ? 'pre_turn_request' : 'turn', inputIds };
}

function startRequest(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.REQUEST_STARTED>,
): void {
  const request = requireRequest(state, event);
  if (request.status !== 'accepted')
    invalid(event, `Request ${request.requestId} was already started`);
  request.status = 'running';
  request.lastBoundaryEventId = event.eventId;
  if (request.pendingInputIds.length === 1 && request.pendingInputIds[0] === request.inputId) {
    request.pendingInputIds = [];
  }
}

function finishRequest(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.REQUEST_COMPLETED | typeof DurableEventType.REQUEST_FAILED>,
  mustBeRunning: boolean,
): void {
  const request = mustBeRunning
    ? requireRunningRequest(state, event)
    : requireRequest(state, event);
  if (request.activeTurn) invalid(event, `Turn ${request.activeTurn.turnId} is still active`);
  assertRequestCausation(event, request);
  state.activeRequest = null;
}

function interruptRequest(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.REQUEST_INTERRUPTED>,
): void {
  const request = requireRequest(state, event);
  if (request.activeTurn) invalid(event, `Turn ${request.activeTurn.turnId} is still active`);
  assertRequestCausation(event, request);
  state.activeRequest = null;
  state.lastRequestInterruption = {
    requestId: event.requestId,
    inputId: request.inputId,
    appliedInputIds: [...request.appliedInputIds],
    status: request.status,
    lastTurn: request.lastTurn,
    ...(event.commandId ? { commandId: event.commandId } : {}),
    sequence: event.sequence,
    reason: event.data.reason,
  };
}

function startTurn(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.TURN_STARTED>,
): void {
  const request = requireRunningRequest(state, event);
  if (request.activeTurn) invalid(event, `Turn ${request.activeTurn.turnId} is still active`);
  if (state.seenTurnIds.has(event.turnId))
    invalid(event, `Turn ID ${event.turnId} was already used`);
  if (event.data.turn !== request.lastTurn + 1) {
    invalid(event, `Expected turn number ${request.lastTurn + 1}, received ${event.data.turn}`);
  }
  state.seenTurnIds.add(event.turnId);
  state.turnOrigins.set(event.turnId, {
    requestId: request.requestId,
    turn: event.data.turn,
    ...(event.commandId ? { commandId: event.commandId } : {}),
    sequence: event.sequence,
  });
  const preparedInputIds = request.pendingInputIds;
  request.pendingInputIds = [];
  request.lastTurn = event.data.turn;
  request.lastBoundaryEventId = event.eventId;
  request.activeTurn = {
    turnId: event.turnId,
    turn: event.data.turn,
    ...(event.data.model ? { model: event.data.model } : {}),
    status: 'running',
    preparedInputIds,
    modelAttempts: [],
    activeModelAttempt: null,
    toolAttempts: [],
  };
}

function finishTurn(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.TURN_COMPLETED | typeof DurableEventType.TURN_ABORTED>,
): { request: MutableRequestProjection; turn: MutableTurnProjection } {
  const request = requireRunningRequest(state, event);
  const turn = requireTurn(state, event);
  if (event.data.turn !== turn.turn) {
    invalid(event, `Turn number ${event.data.turn} does not match active turn ${turn.turn}`);
  }
  assertTurnCanEnd(event, turn);
  request.activeTurn = null;
  request.lastTurnEventId = event.eventId;
  request.lastBoundaryEventId = event.eventId;
  state.lastTurnTerminal = {
    requestId: event.requestId,
    ...(event.commandId ? { commandId: event.commandId } : {}),
    sequence: event.sequence,
  };
  return { request, turn };
}

function abortTurn(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.TURN_ABORTED>,
): void {
  const { turn } = finishTurn(state, event);
  const unsafeTool = turn.toolAttempts.find(hasCrossedNonIdempotentBoundary);
  state.lastTurnAbort = {
    requestId: event.requestId,
    turnId: event.turnId,
    turn: event.data.turn,
    ...(event.commandId ? { commandId: event.commandId } : {}),
    sequence: event.sequence,
    reason: event.data.reason,
    preparedInputIds: [...turn.preparedInputIds],
    unsafeNonIdempotentToolAttemptId: unsafeTool?.toolAttemptId ?? null,
  };
}

function applyInput(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.INPUT_APPLIED>,
): void {
  const request = requireRequest(state, event);
  if (event.turnId !== undefined && request.activeTurn?.turnId !== event.turnId) {
    invalid(event, `No active turn matches ${String(event.turnId)}`);
  }
  if (state.seenAppliedInputIds.has(event.data.inputId)) {
    invalid(event, `Input ID ${event.data.inputId} was already applied`);
  }
  if (state.seenInputIds.has(event.data.inputId) && event.data.inputId !== request.inputId) {
    invalid(event, `Input ID ${event.data.inputId} was already used by another Request`);
  }
  state.seenAppliedInputIds.add(event.data.inputId);
  state.appliedInputIds.push(event.data.inputId);
  request.appliedInputIds.push(event.data.inputId);
  request.pendingInputIds.push(event.data.inputId);
  request.lastBoundaryEventId = event.eventId;
}

function assertRequestCausation(
  event: DurableEventEnvelope,
  request: MutableRequestProjection,
): void {
  if (
    event.causationEventId !== undefined &&
    event.causationEventId !== request.lastBoundaryEventId
  ) {
    invalid(
      event,
      `Request terminal causation ${event.causationEventId} does not match the latest boundary`,
    );
  }
}
