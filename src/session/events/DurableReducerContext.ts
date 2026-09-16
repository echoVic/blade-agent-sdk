import { SdkError } from '../../errors/SdkError.js';
import type {
  EventId,
  EventSequence,
  ModelAttemptId,
  RequestId,
  ToolAttemptId,
  TurnId,
} from '../../types/identifiers.js';
import type {
  DurableSessionState,
  MutableRequestProjection,
  MutableTurnProjection,
} from './DurableSessionState.js';
import type { DurableEventEnvelope } from './types.js';

export class DurableEventProjectionError extends SdkError {
  readonly eventId?: EventId;
  readonly sequence?: EventSequence;

  constructor(
    message: string,
    event?: Pick<DurableEventEnvelope, 'eventId' | 'sequence'>,
    options?: { cause?: unknown },
  ) {
    super('DURABLE_EVENT_INVALID_TRANSITION', message, options);
    this.eventId = event?.eventId;
    this.sequence = event?.sequence;
  }
}

export type RequestEvent = DurableEventEnvelope & { readonly requestId: RequestId };
export type TurnEvent = RequestEvent & { readonly turnId: TurnId };
export type ModelEvent = TurnEvent & { readonly modelAttemptId: ModelAttemptId };
export type ToolEvent = TurnEvent & { readonly toolAttemptId: ToolAttemptId };

export function invalid(event: DurableEventEnvelope, message: string): never {
  throw new DurableEventProjectionError(
    `${message} at sequence ${event.sequence} (${event.type})`,
    event,
  );
}

export function requireOpen(state: DurableSessionState, event: DurableEventEnvelope): void {
  if (state.status !== 'open') {
    invalid(event, `Expected an open session, found ${state.status}`);
  }
}

export function requireRequest(
  state: DurableSessionState,
  event: RequestEvent,
): MutableRequestProjection {
  requireOpen(state, event);
  const request = state.activeRequest;
  if (!request || request.requestId !== event.requestId) {
    invalid(event, `No active request matches ${String(event.requestId)}`);
  }
  return request;
}

export function requireRunningRequest(
  state: DurableSessionState,
  event: RequestEvent,
): MutableRequestProjection {
  const request = requireRequest(state, event);
  if (request.status !== 'running') {
    invalid(event, `Request ${request.requestId} has not started`);
  }
  return request;
}

export function requireTurn(state: DurableSessionState, event: TurnEvent): MutableTurnProjection {
  const request = requireRunningRequest(state, event);
  const turn = request.activeTurn;
  if (!turn || turn.turnId !== event.turnId) {
    invalid(event, `No active turn matches ${String(event.turnId)}`);
  }
  return turn;
}

export function requireTool(
  state: DurableSessionState,
  event: ToolEvent,
): MutableTurnProjection['toolAttempts'][number] {
  const tool = requireTurn(state, event).toolAttempts.find(
    (candidate) => candidate.toolAttemptId === event.toolAttemptId,
  );
  if (!tool) {
    invalid(event, `No tool attempt matches ${String(event.toolAttemptId)}`);
  }
  return tool;
}

export function requireModel(
  state: DurableSessionState,
  event: ModelEvent,
): MutableTurnProjection['modelAttempts'][number] {
  const turn = requireTurn(state, event);
  const attempt = turn.modelAttempts.find(
    (candidate) => candidate.modelAttemptId === event.modelAttemptId,
  );
  if (
    !attempt ||
    turn.activeModelAttempt?.modelAttemptId !== event.modelAttemptId ||
    attempt.status !== 'started'
  ) {
    invalid(event, `No active model attempt matches ${String(event.modelAttemptId)}`);
  }
  return attempt;
}
