import { SdkError } from '../../errors/SdkError.js';
import type { ModelIdentity } from '../../services/ModelIdentity.js';
import type { ToolSideEffect } from '../../tools/types/ToolKind.js';
import {
  type CommandId,
  EventId,
  EventSequence,
  type InputId,
  type ModelAttemptId,
  type PermissionRequestId,
  type RequestId,
  type SessionId,
  type ToolAttemptId,
  type ToolUseId,
  type TurnId,
} from '../../types/branded.js';
import type { JsonObject, JsonValue } from '../../types/common.js';
import { canonicalJson } from './canonicalJson.js';
import { parseDurableEventDraft, parseDurableEventEnvelope } from './schemas.js';
import {
  DURABLE_EVENT_SCHEMA_VERSION,
  type DurableEventDataMap,
  type DurableEventDraft,
  type DurableEventEnvelope,
  type DurableEventError,
  type DurableEventSchemaVersion,
  type DurableEventType,
  DurableEventType as DurableEventTypeValue,
  type DurableInputPriority,
  type DurableModelRequestAbortReason,
  type DurableModelResponse,
  type DurablePermissionDecision,
  type DurableRequestInterruptReason,
  type DurableRequestRecoveryOrigin,
  type DurableSessionCloseReason,
  type DurableToolCancelReason,
  type DurableToolInterruptBehavior,
  type DurableToolOutcomeUnknownReason,
  type DurableTurnAbortReason,
} from './types.js';

export type DurableSessionProjectionStatus = 'empty' | 'open' | 'closed';
export type DurableRequestStatus = 'accepted' | 'running';
export type DurableRequestRecoveryKind = 'turn' | 'pre_turn_request';
export type DurableTurnStatus = 'running';
export type DurableToolAttemptStatus =
  | 'scheduled'
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';
export type DurablePermissionStatus = 'pending' | 'resolved';
export type DurableModelAttemptStatus = 'started' | 'completed' | 'failed' | 'aborted';
export type DurableSessionRecoveryAction =
  | 'none'
  | 'resume_request'
  | 'rollover_request'
  | 'resume_turn'
  | 'resolve_permissions'
  | 'reconcile_tool_outcomes'
  | 'reconcile_model_outcome'
  | 'reconcile_request_inputs'
  | 'reconcile_request_outcome';

export interface DurablePermissionProjection {
  readonly permissionRequestId: PermissionRequestId;
  readonly input: JsonValue;
  readonly status: DurablePermissionStatus;
  readonly decision?: DurablePermissionDecision;
  readonly message?: string;
}

export interface DurableToolAttemptProjection {
  readonly toolAttemptId: ToolAttemptId;
  readonly toolCallId: ToolUseId;
  readonly toolName: string;
  readonly modelAttemptId?: ModelAttemptId;
  readonly modelInput?: JsonValue;
  readonly input: JsonValue;
  readonly sideEffect: ToolSideEffect;
  readonly interruptBehavior: DurableToolInterruptBehavior;
  readonly executionStarted: boolean;
  readonly status: DurableToolAttemptStatus;
  readonly permission: DurablePermissionProjection | null;
  readonly result?: JsonValue;
  readonly error?: DurableEventError;
  readonly cancelReason?: DurableToolCancelReason;
  readonly unknownReason?: DurableToolOutcomeUnknownReason;
}

export interface DurableModelAttemptProjection {
  readonly modelAttemptId: ModelAttemptId;
  readonly model: string;
  readonly modelIdentity?: ModelIdentity;
  readonly streaming: boolean;
  readonly status: DurableModelAttemptStatus;
  readonly response?: DurableModelResponse;
  readonly error?: DurableEventError;
  readonly abortReason?: DurableModelRequestAbortReason;
}

export interface DurableTurnProjection {
  readonly turnId: TurnId;
  readonly turn: number;
  readonly model?: string;
  readonly status: DurableTurnStatus;
  readonly modelAttempts: readonly DurableModelAttemptProjection[];
  readonly activeModelAttempt: DurableModelAttemptProjection | null;
  readonly toolAttempts: readonly DurableToolAttemptProjection[];
}

export interface DurableRequestProjection {
  readonly requestId: RequestId;
  readonly commandId: CommandId;
  readonly inputId: InputId;
  readonly input: JsonValue;
  readonly priority: DurableInputPriority;
  readonly acceptedAt: string;
  readonly maxTurns?: number;
  readonly model?: string;
  readonly context?: JsonObject;
  readonly recovery?: DurableRequestRecoveryOrigin;
  readonly recoveryKind?: DurableRequestRecoveryKind;
  readonly reconciledInputIds?: readonly InputId[];
  readonly status: DurableRequestStatus;
  readonly appliedInputIds?: readonly InputId[];
  readonly pendingInputIds?: readonly InputId[];
  readonly lastTurn: number;
  readonly lastTurnEventId?: EventId | null;
  readonly activeTurn: DurableTurnProjection | null;
}

export interface DurableSessionProjection {
  readonly sessionId: SessionId | null;
  readonly schemaVersion: DurableEventSchemaVersion | null;
  readonly status: DurableSessionProjectionStatus;
  readonly headSequence: EventSequence | null;
  readonly lastEventId: EventId | null;
  readonly created: DurableEventDataMap[typeof DurableEventTypeValue.SESSION_CREATED] | null;
  readonly closeReason: DurableSessionCloseReason | null;
  readonly activeRequest: DurableRequestProjection | null;
  readonly appliedInputIds: readonly InputId[];
  readonly reconciledInputIds?: readonly InputId[];
  readonly acceptedCommandIds: readonly CommandId[];
}

export interface DurableSessionRecoveryPlan {
  readonly action: DurableSessionRecoveryAction;
  readonly requestId: RequestId | null;
  readonly turnId: TurnId | null;
  readonly activeModelAttempt: DurableModelAttemptProjection | null;
  readonly retryableToolAttempts: readonly DurableToolAttemptProjection[];
  readonly cancelableToolAttempts: readonly DurableToolAttemptProjection[];
  readonly unknownToolAttempts: readonly DurableToolAttemptProjection[];
  readonly pendingPermissions: readonly DurablePermissionProjection[];
}

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

interface MutablePermissionProjection {
  permissionRequestId: PermissionRequestId;
  input: JsonValue;
  status: DurablePermissionStatus;
  decision?: DurablePermissionDecision;
  message?: string;
}

interface MutableToolAttemptProjection {
  toolAttemptId: ToolAttemptId;
  toolCallId: ToolUseId;
  toolName: string;
  modelAttemptId?: ModelAttemptId;
  modelInput?: JsonValue;
  input: JsonValue;
  sideEffect: ToolSideEffect;
  interruptBehavior: DurableToolInterruptBehavior;
  executionStarted: boolean;
  status: DurableToolAttemptStatus;
  permission: MutablePermissionProjection | null;
  result?: JsonValue;
  error?: DurableEventError;
  cancelReason?: DurableToolCancelReason;
  unknownReason?: DurableToolOutcomeUnknownReason;
}

interface MutableModelAttemptProjection {
  modelAttemptId: ModelAttemptId;
  model: string;
  modelIdentity?: ModelIdentity;
  streaming: boolean;
  status: DurableModelAttemptStatus;
  response?: DurableModelResponse;
  error?: DurableEventError;
  abortReason?: DurableModelRequestAbortReason;
}

interface MutableTurnProjection {
  turnId: TurnId;
  turn: number;
  model?: string;
  status: DurableTurnStatus;
  preparedInputIds: InputId[];
  modelAttempts: Map<ModelAttemptId, MutableModelAttemptProjection>;
  lastModelAttempt: MutableModelAttemptProjection | null;
  activeModelAttempt: MutableModelAttemptProjection | null;
  toolAttempts: Map<ToolAttemptId, MutableToolAttemptProjection>;
}

interface MutableRequestProjection {
  requestId: RequestId;
  commandId: CommandId;
  inputId: InputId;
  input: JsonValue;
  priority: DurableInputPriority;
  acceptedAt: string;
  maxTurns?: number;
  model?: string;
  context?: JsonObject;
  recovery?: DurableRequestRecoveryOrigin;
  recoveryKind?: DurableRequestRecoveryKind;
  reconciledInputIds: InputId[];
  status: DurableRequestStatus;
  appliedInputIds: InputId[];
  pendingInputIds: InputId[];
  lastTurn: number;
  lastTurnEventId: EventId | null;
  lastBoundaryEventId: EventId;
  activeTurn: MutableTurnProjection | null;
}

interface ProjectionAccumulator {
  sessionId: SessionId | null;
  schemaVersion: DurableEventSchemaVersion | null;
  status: DurableSessionProjectionStatus;
  headSequence: EventSequence | null;
  lastEventId: EventId | null;
  created: DurableEventDataMap[typeof DurableEventTypeValue.SESSION_CREATED] | null;
  closeReason: DurableSessionCloseReason | null;
  activeRequest: MutableRequestProjection | null;
  appliedInputIds: InputId[];
  reconciledInputIds: InputId[];
  acceptedCommandIds: CommandId[];
  seenEventIds: Set<EventId>;
  seenRequestIds: Set<RequestId>;
  seenTurnIds: Set<TurnId>;
  turnOrigins: Map<
    TurnId,
    {
      requestId: RequestId;
      turn: number;
      commandId?: CommandId;
      sequence: EventSequence;
    }
  >;
  lastTurnAbort: {
    requestId: RequestId;
    turnId: TurnId;
    turn: number;
    commandId?: CommandId;
    sequence: EventSequence;
    reason: DurableTurnAbortReason;
    preparedInputIds: readonly InputId[];
    unsafeNonIdempotentToolAttemptId: ToolAttemptId | null;
  } | null;
  lastTurnTerminal: {
    requestId: RequestId;
    commandId?: CommandId;
    sequence: EventSequence;
  } | null;
  lastRequestInterruption: {
    requestId: RequestId;
    inputId: InputId;
    appliedInputIds: readonly InputId[];
    status: DurableRequestStatus;
    lastTurn: number;
    commandId?: CommandId;
    sequence: EventSequence;
    reason: DurableRequestInterruptReason;
  } | null;
  seenModelAttemptIds: Set<ModelAttemptId>;
  seenToolAttemptIds: Set<ToolAttemptId>;
  seenPermissionRequestIds: Set<PermissionRequestId>;
  seenInputIds: Set<InputId>;
  seenAppliedInputIds: Set<InputId>;
  seenCommandIds: Set<CommandId>;
}

type RequestScopedEvent = DurableEventEnvelope & { readonly requestId: RequestId };
type TurnScopedEvent = RequestScopedEvent & { readonly turnId: TurnId };
type ModelScopedEvent = TurnScopedEvent & { readonly modelAttemptId: ModelAttemptId };
type ToolScopedEvent = TurnScopedEvent & { readonly toolAttemptId: ToolAttemptId };

function invalid(event: DurableEventEnvelope, message: string): never {
  throw new DurableEventProjectionError(
    `${message} at sequence ${event.sequence} (${event.type})`,
    event,
  );
}

function requireOpenSession(state: ProjectionAccumulator, event: DurableEventEnvelope): void {
  if (state.status !== 'open') {
    invalid(event, `Expected an open session, found ${state.status}`);
  }
}

function requireActiveRequest(
  state: ProjectionAccumulator,
  event: RequestScopedEvent,
): MutableRequestProjection {
  requireOpenSession(state, event);
  const request = state.activeRequest;
  if (!request || request.requestId !== event.requestId) {
    invalid(event, `No active request matches ${String(event.requestId)}`);
  }
  return request;
}

function requireRunningRequest(
  state: ProjectionAccumulator,
  event: RequestScopedEvent,
): MutableRequestProjection {
  const request = requireActiveRequest(state, event);
  if (request.status !== 'running') {
    invalid(event, `Request ${request.requestId} has not started`);
  }
  return request;
}

function requireActiveTurn(
  state: ProjectionAccumulator,
  event: TurnScopedEvent,
): MutableTurnProjection {
  const request = requireRunningRequest(state, event);
  const turn = request.activeTurn;
  if (!turn || turn.turnId !== event.turnId) {
    invalid(event, `No active turn matches ${String(event.turnId)}`);
  }
  return turn;
}

function requireToolAttempt(
  state: ProjectionAccumulator,
  event: ToolScopedEvent,
): MutableToolAttemptProjection {
  const turn = requireActiveTurn(state, event);
  const tool = turn.toolAttempts.get(event.toolAttemptId as ToolAttemptId);
  if (!tool) {
    invalid(event, `No tool attempt matches ${String(event.toolAttemptId)}`);
  }
  return tool;
}

function requireModelAttempt(
  state: ProjectionAccumulator,
  event: ModelScopedEvent,
): MutableModelAttemptProjection {
  const turn = requireActiveTurn(state, event);
  const attempt = turn.modelAttempts.get(event.modelAttemptId);
  if (
    !attempt
    || turn.activeModelAttempt?.modelAttemptId !== event.modelAttemptId
    || attempt.status !== 'started'
  ) {
    invalid(event, `No active model attempt matches ${String(event.modelAttemptId)}`);
  }
  return attempt;
}

function assertToolIdentity(
  event: DurableEventEnvelope,
  tool: MutableToolAttemptProjection,
  data: { toolCallId: ToolUseId; toolName: string },
): void {
  if (tool.toolCallId !== data.toolCallId || tool.toolName !== data.toolName) {
    invalid(event, `Tool identity does not match attempt ${tool.toolAttemptId}`);
  }
}

function assertToolMatchesModelAttempt(
  event: DurableEventEnvelope,
  turn: MutableTurnProjection,
  toolCallId: ToolUseId,
  toolName: string,
  modelAttemptId: ModelAttemptId | undefined,
  modelInput: JsonValue | undefined,
): void {
  if (!modelAttemptId) {
    if (event.schemaVersion >= 3) {
      invalid(event, `Tool call ${toolCallId} has no model attempt identity`);
    }
    return;
  }
  const modelAttempt = turn.modelAttempts.get(modelAttemptId);
  if (
    !modelAttempt
    || turn.lastModelAttempt?.modelAttemptId !== modelAttemptId
  ) {
    invalid(event, `Tool call ${toolCallId} does not belong to the current model attempt`);
  }
  if (modelAttempt.status === 'started') {
    if (modelInput === undefined) {
      invalid(event, `Tool call ${toolCallId} has no original model input`);
    }
    return;
  }
  if (modelAttempt.status !== 'completed') {
    invalid(
      event,
      `Tool call ${toolCallId} follows model attempt ${modelAttempt.modelAttemptId} with status ${modelAttempt.status}`,
    );
  }
  const declared = modelAttempt.response?.toolCalls?.find(
    (toolCall) => toolCall.id === toolCallId,
  );
  if (!declared || declared.name !== toolName) {
    invalid(
      event,
      `Tool call ${toolCallId}/${toolName} was not declared by model attempt ${modelAttempt.modelAttemptId}`,
    );
  }
  assertModelToolInput(event, toolCallId, declared.arguments, modelInput);
}

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

function assertCompletedResponseMatchesScheduledTools(
  event: DurableEventEnvelope<typeof DurableEventTypeValue.MODEL_REQUEST_COMPLETED>,
  turn: MutableTurnProjection,
): void {
  const toolCalls = event.data.response.toolCalls ?? [];
  const seenToolCallIds = new Set<ToolUseId>();
  for (const toolCall of toolCalls) {
    if (seenToolCallIds.has(toolCall.id)) {
      invalid(event, `Model response reused tool call ID ${toolCall.id}`);
    }
    seenToolCallIds.add(toolCall.id);
  }
  for (const tool of turn.toolAttempts.values()) {
    if (tool.modelAttemptId !== event.modelAttemptId) {
      continue;
    }
    const declared = toolCalls.find((toolCall) => toolCall.id === tool.toolCallId);
    if (!declared || declared.name !== tool.toolName) {
      invalid(
        event,
        `Model response does not declare durable tool call ${tool.toolCallId}/${tool.toolName}`,
      );
    }
    assertModelToolInput(
      event,
      tool.toolCallId,
      declared.arguments,
      tool.modelInput,
    );
  }
}

function assertNoPendingPermission(
  event: DurableEventEnvelope,
  tool: MutableToolAttemptProjection,
): void {
  if (tool.permission?.status === 'pending') {
    invalid(event, `Tool attempt ${tool.toolAttemptId} has an unresolved permission request`);
  }
}

function assertTurnCanEnd(event: DurableEventEnvelope, turn: MutableTurnProjection): void {
  if (turn.activeModelAttempt) {
    invalid(event, `Model attempt ${turn.activeModelAttempt.modelAttemptId} is not terminal`);
  }
  const unfinished = Array.from(turn.toolAttempts.values()).find(
    (tool) =>
      tool.status === 'scheduled' ||
      tool.status === 'started' ||
      tool.status === 'outcome_unknown' ||
      tool.permission?.status === 'pending',
  );
  if (unfinished) {
    invalid(event, `Tool attempt ${unfinished.toolAttemptId} is not terminal`);
  }
}

function assertRequestCausation(
  event: DurableEventEnvelope,
  request: MutableRequestProjection,
): void {
  // Schema v2 allowed no causation, and atomic rollover cannot reference an ID
  // assigned later in the same append. New standalone terminal writes include it.
  if (
    event.causationEventId !== undefined
    && event.causationEventId !== request.lastBoundaryEventId
  ) {
    invalid(
      event,
      `Request terminal causation ${event.causationEventId} does not match the latest boundary`,
    );
  }
}

function assertNewRequestTerminalCausation(
  state: ProjectionAccumulator,
  event: DurableEventEnvelope,
): void {
  if (
    event.type !== DurableEventTypeValue.REQUEST_COMPLETED
    && event.type !== DurableEventTypeValue.REQUEST_FAILED
    && event.type !== DurableEventTypeValue.REQUEST_INTERRUPTED
  ) {
    return;
  }
  const request = state.activeRequest;
  if (
    !request
    || request.requestId !== event.requestId
    || event.causationEventId === request.lastBoundaryEventId
  ) {
    return;
  }
  const terminal = state.lastTurnTerminal;
  const atomicTurnTermination =
    event.causationEventId === undefined
    && terminal?.requestId === event.requestId
    && terminal.commandId !== undefined
    && terminal.commandId === event.commandId
    && Number(terminal.sequence) + 1 === Number(event.sequence);
  if (!atomicTurnTermination) {
    invalid(event, 'A new Request terminal event requires latest-boundary causation');
  }
}

function assertNewInputApplicationBoundary(
  state: ProjectionAccumulator,
  event: DurableEventEnvelope,
): void {
  if (
    event.type === DurableEventTypeValue.INPUT_APPLIED
    && state.activeRequest?.activeTurn
  ) {
    invalid(event, 'A new input application requires a completed or aborted Turn');
  }
}

export function hasCrossedNonIdempotentBoundary(
  tool: DurableToolAttemptProjection,
): boolean {
  return tool.sideEffect === 'non_idempotent'
    && (
      tool.status === 'completed'
      || tool.status === 'failed'
      || (tool.status === 'cancelled' && tool.executionStarted)
    );
}

function clonePermission(
  permission: MutablePermissionProjection | null,
): DurablePermissionProjection | null {
  return permission ? { ...permission } : null;
}

function cloneTool(tool: MutableToolAttemptProjection): DurableToolAttemptProjection {
  return {
    ...tool,
    permission: clonePermission(tool.permission),
  };
}

function cloneModelAttempt(
  attempt: MutableModelAttemptProjection,
): DurableModelAttemptProjection {
  return {
    ...attempt,
    ...(attempt.modelIdentity
      ? { modelIdentity: { ...attempt.modelIdentity } }
      : {}),
  };
}

function cloneTurn(turn: MutableTurnProjection | null): DurableTurnProjection | null {
  if (!turn) {
    return null;
  }
  return {
    turnId: turn.turnId,
    turn: turn.turn,
    ...(turn.model ? { model: turn.model } : {}),
    status: turn.status,
    modelAttempts: Array.from(turn.modelAttempts.values(), cloneModelAttempt),
    activeModelAttempt: turn.activeModelAttempt
      ? cloneModelAttempt(turn.activeModelAttempt)
      : null,
    toolAttempts: Array.from(turn.toolAttempts.values(), cloneTool),
  };
}

function cloneRequest(request: MutableRequestProjection | null): DurableRequestProjection | null {
  if (!request) {
    return null;
  }
  return {
    requestId: request.requestId,
    commandId: request.commandId,
    inputId: request.inputId,
    input: request.input,
    priority: request.priority,
    acceptedAt: request.acceptedAt,
    ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.context ? { context: request.context } : {}),
    ...(request.recovery ? { recovery: request.recovery } : {}),
    ...(request.recoveryKind ? { recoveryKind: request.recoveryKind } : {}),
    reconciledInputIds: [...request.reconciledInputIds],
    status: request.status,
    appliedInputIds: [...request.appliedInputIds],
    pendingInputIds: [...request.pendingInputIds],
    lastTurn: request.lastTurn,
    lastTurnEventId: request.lastTurnEventId,
    activeTurn: cloneTurn(request.activeTurn),
  };
}

function applyEvent(state: ProjectionAccumulator, event: DurableEventEnvelope): void {
  switch (event.type) {
    case DurableEventTypeValue.SESSION_CREATED:
      if (state.status !== 'empty') {
        invalid(event, 'Session was already created');
      }
      state.sessionId = event.sessionId;
      state.status = 'open';
      state.created = event.data;
      return;

    case DurableEventTypeValue.SESSION_CLOSED:
      requireOpenSession(state, event);
      if (state.activeRequest) {
        invalid(event, `Request ${state.activeRequest.requestId} is still active`);
      }
      state.status = 'closed';
      state.closeReason = event.data.reason;
      return;

    case DurableEventTypeValue.REQUEST_ACCEPTED: {
      requireOpenSession(state, event);
      if (state.activeRequest) {
        invalid(event, `Request ${state.activeRequest.requestId} is still active`);
      }
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
      let recoveryKind: DurableRequestRecoveryKind | undefined;
      let reconciledInputIds: InputId[] = [];
      if (event.data.recovery) {
        const recovery = event.data.recovery;
        const origin = state.turnOrigins.get(recovery.turnId);
        const turnAbort = state.lastTurnAbort;
        const requestInterruption = state.lastRequestInterruption;
        if (
          !origin ||
          origin.requestId !== recovery.requestId ||
          origin.turn !== recovery.turn ||
          !turnAbort ||
          turnAbort.requestId !== recovery.requestId ||
          turnAbort.turnId !== recovery.turnId ||
          turnAbort.turn !== recovery.turn ||
          turnAbort.reason !== 'process_restart' ||
          turnAbort.commandId !== event.commandId ||
          !requestInterruption ||
          requestInterruption.requestId !== recovery.requestId ||
          requestInterruption.reason !== 'process_restart' ||
          requestInterruption.commandId !== event.commandId ||
          Number(turnAbort.sequence) + 1 !== Number(requestInterruption.sequence) ||
          Number(requestInterruption.sequence) + 1 !== Number(event.sequence) ||
          requestInterruption.status !== 'running' ||
          requestInterruption.lastTurn !== recovery.turn
        ) {
          invalid(
            event,
            `Recovery origin ${recovery.turnId} is not an atomic canonical rollover`,
          );
        }
        const syntheticPreTurn =
          origin.commandId === event.commandId
          && Number(origin.sequence) + 1 === Number(turnAbort.sequence);
        recoveryKind = syntheticPreTurn ? 'pre_turn_request' : 'turn';
        reconciledInputIds = syntheticPreTurn
          ? [
              ...(recovery.turn === 1 ? [requestInterruption.inputId] : []),
              ...turnAbort.preparedInputIds.filter(
                (inputId) =>
                  recovery.turn !== 1 || inputId !== requestInterruption.inputId,
              ),
            ]
          : [
              requestInterruption.inputId,
              ...requestInterruption.appliedInputIds.filter(
                (inputId) => inputId !== requestInterruption.inputId,
              ),
            ];
        if (syntheticPreTurn) {
          for (const inputId of reconciledInputIds) {
            if (!state.reconciledInputIds.includes(inputId)) {
              state.reconciledInputIds.push(inputId);
            }
          }
        }
        if (!syntheticPreTurn && origin.commandId === event.commandId) {
          invalid(
            event,
            `Recovery origin ${recovery.turnId} has a non-adjacent synthetic Turn`,
          );
        }
        if (turnAbort.unsafeNonIdempotentToolAttemptId) {
          invalid(
            event,
            `Recovery origin ${recovery.turnId} crossed non-idempotent tool attempt ${turnAbort.unsafeNonIdempotentToolAttemptId}`,
          );
        }
      }
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
        ...(recoveryKind ? { recoveryKind } : {}),
        reconciledInputIds,
        status: 'accepted',
        appliedInputIds: [],
        pendingInputIds: [],
        lastTurn: 0,
        lastTurnEventId: null,
        lastBoundaryEventId: event.eventId,
        activeTurn: null,
      };
      return;
    }

    case DurableEventTypeValue.REQUEST_STARTED: {
      const request = requireActiveRequest(state, event);
      if (request.status !== 'accepted') {
        invalid(event, `Request ${request.requestId} was already started`);
      }
      request.status = 'running';
      request.lastBoundaryEventId = event.eventId;
      if (
        request.pendingInputIds.length === 1
        && request.pendingInputIds[0] === request.inputId
      ) {
        request.pendingInputIds = [];
      }
      return;
    }

    case DurableEventTypeValue.REQUEST_COMPLETED: {
      const request = requireRunningRequest(state, event);
      if (request.activeTurn) {
        invalid(event, `Turn ${request.activeTurn.turnId} is still active`);
      }
      assertRequestCausation(event, request);
      state.activeRequest = null;
      return;
    }

    case DurableEventTypeValue.REQUEST_FAILED: {
      const request = requireActiveRequest(state, event);
      if (request.activeTurn) {
        invalid(event, `Turn ${request.activeTurn.turnId} is still active`);
      }
      assertRequestCausation(event, request);
      state.activeRequest = null;
      return;
    }

    case DurableEventTypeValue.REQUEST_INTERRUPTED: {
      const request = requireActiveRequest(state, event);
      if (request.activeTurn) {
        invalid(event, `Turn ${request.activeTurn.turnId} is still active`);
      }
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
      return;
    }

    case DurableEventTypeValue.TURN_STARTED: {
      const request = requireRunningRequest(state, event);
      if (request.activeTurn) {
        invalid(event, `Turn ${request.activeTurn.turnId} is still active`);
      }
      if (state.seenTurnIds.has(event.turnId)) {
        invalid(event, `Turn ID ${event.turnId} was already used`);
      }
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
        modelAttempts: new Map(),
        lastModelAttempt: null,
        activeModelAttempt: null,
        toolAttempts: new Map(),
      };
      return;
    }

    case DurableEventTypeValue.TURN_COMPLETED: {
      const request = requireRunningRequest(state, event);
      const turn = requireActiveTurn(state, event);
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
      return;
    }

    case DurableEventTypeValue.TURN_ABORTED: {
      const request = requireRunningRequest(state, event);
      const turn = requireActiveTurn(state, event);
      if (event.data.turn !== turn.turn) {
        invalid(event, `Turn number ${event.data.turn} does not match active turn ${turn.turn}`);
      }
      assertTurnCanEnd(event, turn);
      const unsafeNonIdempotentTool = Array.from(turn.toolAttempts.values()).find(
        hasCrossedNonIdempotentBoundary,
      );
      request.activeTurn = null;
      request.lastTurnEventId = event.eventId;
      request.lastBoundaryEventId = event.eventId;
      state.lastTurnTerminal = {
        requestId: event.requestId,
        ...(event.commandId ? { commandId: event.commandId } : {}),
        sequence: event.sequence,
      };
      state.lastTurnAbort = {
        requestId: event.requestId,
        turnId: event.turnId,
        turn: event.data.turn,
        ...(event.commandId ? { commandId: event.commandId } : {}),
        sequence: event.sequence,
        reason: event.data.reason,
        preparedInputIds: [...turn.preparedInputIds],
        unsafeNonIdempotentToolAttemptId: unsafeNonIdempotentTool?.toolAttemptId ?? null,
      };
      return;
    }

    case DurableEventTypeValue.MODEL_REQUEST_STARTED: {
      const request = requireRunningRequest(state, event);
      const turn = requireActiveTurn(state, event);
      if (turn.activeModelAttempt) {
        invalid(
          event,
          `Model attempt ${turn.activeModelAttempt.modelAttemptId} is still active`,
        );
      }
      const previousAttempt = turn.lastModelAttempt;
      if (previousAttempt && previousAttempt.status !== 'failed') {
        invalid(
          event,
          `Model attempt ${previousAttempt.modelAttemptId} ended as ${previousAttempt.status}`,
        );
      }
      if (previousAttempt && turn.toolAttempts.size > 0) {
        invalid(
          event,
          `Model attempt ${previousAttempt.modelAttemptId} dispatched tools before failing`,
        );
      }
      if (state.seenModelAttemptIds.has(event.modelAttemptId)) {
        invalid(event, `Model attempt ID ${event.modelAttemptId} was already used`);
      }
      const attempt: MutableModelAttemptProjection = {
        modelAttemptId: event.modelAttemptId,
        model: event.data.model,
        ...(event.data.modelIdentity
          ? { modelIdentity: { ...event.data.modelIdentity } }
          : {}),
        streaming: event.data.streaming,
        status: 'started',
      };
      state.seenModelAttemptIds.add(event.modelAttemptId);
      turn.modelAttempts.set(event.modelAttemptId, attempt);
      turn.lastModelAttempt = attempt;
      turn.activeModelAttempt = attempt;
      request.lastBoundaryEventId = event.eventId;
      return;
    }

    case DurableEventTypeValue.MODEL_REQUEST_COMPLETED: {
      const request = requireRunningRequest(state, event);
      const turn = requireActiveTurn(state, event);
      const attempt = requireModelAttempt(state, event);
      assertCompletedResponseMatchesScheduledTools(event, turn);
      attempt.status = 'completed';
      attempt.response = event.data.response;
      turn.activeModelAttempt = null;
      request.lastBoundaryEventId = event.eventId;
      return;
    }

    case DurableEventTypeValue.MODEL_REQUEST_FAILED: {
      const request = requireRunningRequest(state, event);
      const turn = requireActiveTurn(state, event);
      const attempt = requireModelAttempt(state, event);
      attempt.status = 'failed';
      attempt.error = event.data.error;
      turn.activeModelAttempt = null;
      request.lastBoundaryEventId = event.eventId;
      return;
    }

    case DurableEventTypeValue.MODEL_REQUEST_ABORTED: {
      const request = requireRunningRequest(state, event);
      const turn = requireActiveTurn(state, event);
      const attempt = requireModelAttempt(state, event);
      attempt.status = 'aborted';
      attempt.abortReason = event.data.reason;
      turn.activeModelAttempt = null;
      request.lastBoundaryEventId = event.eventId;
      return;
    }

    case DurableEventTypeValue.TOOL_SCHEDULED: {
      const turn = requireActiveTurn(state, event);
      if (state.seenToolAttemptIds.has(event.toolAttemptId)) {
        invalid(event, `Tool attempt ID ${event.toolAttemptId} was already used`);
      }
      if (
        Array.from(turn.toolAttempts.values()).some(
          (tool) => tool.toolCallId === event.data.toolCallId,
        )
      ) {
        invalid(event, `Tool call ID ${event.data.toolCallId} was already scheduled`);
      }
      assertToolMatchesModelAttempt(
        event,
        turn,
        event.data.toolCallId,
        event.data.toolName,
        event.modelAttemptId,
        event.data.modelInput,
      );
      state.seenToolAttemptIds.add(event.toolAttemptId);
      turn.toolAttempts.set(event.toolAttemptId, {
        toolAttemptId: event.toolAttemptId,
        toolCallId: event.data.toolCallId,
        toolName: event.data.toolName,
        ...(event.modelAttemptId
          ? { modelAttemptId: event.modelAttemptId }
          : {}),
        ...(event.data.modelInput !== undefined
          ? { modelInput: event.data.modelInput }
          : {}),
        input: event.data.input,
        sideEffect: event.data.sideEffect,
        interruptBehavior: event.data.interruptBehavior,
        executionStarted: false,
        status: 'scheduled',
        permission: null,
      });
      return;
    }

    case DurableEventTypeValue.PERMISSION_REQUESTED: {
      const tool = requireToolAttempt(state, event);
      assertToolIdentity(event, tool, event.data);
      if (tool.status !== 'scheduled') {
        invalid(event, `Tool attempt ${tool.toolAttemptId} already started`);
      }
      if (tool.permission) {
        invalid(event, `Tool attempt ${tool.toolAttemptId} already has a permission decision`);
      }
      if (state.seenPermissionRequestIds.has(event.data.permissionRequestId)) {
        invalid(event, `Permission request ID ${event.data.permissionRequestId} was already used`);
      }
      state.seenPermissionRequestIds.add(event.data.permissionRequestId);
      tool.permission = {
        permissionRequestId: event.data.permissionRequestId,
        input: event.data.input,
        status: 'pending',
        ...(event.data.message !== undefined ? { message: event.data.message } : {}),
      };
      return;
    }

    case DurableEventTypeValue.PERMISSION_RESOLVED: {
      const tool = requireToolAttempt(state, event);
      const permission = tool.permission;
      if (
        !permission ||
        permission.status !== 'pending' ||
        permission.permissionRequestId !== event.data.permissionRequestId
      ) {
        invalid(event, `No pending permission matches ${event.data.permissionRequestId}`);
      }
      permission.status = 'resolved';
      permission.decision = event.data.decision;
      if (event.data.message !== undefined) {
        permission.message = event.data.message;
      }
      return;
    }

    case DurableEventTypeValue.TOOL_STARTED: {
      const tool = requireToolAttempt(state, event);
      assertToolIdentity(event, tool, event.data);
      if (tool.status !== 'scheduled') {
        invalid(event, `Tool attempt ${tool.toolAttemptId} is ${tool.status}, not scheduled`);
      }
      assertNoPendingPermission(event, tool);
      if (tool.permission?.status === 'resolved' && tool.permission.decision !== 'allow') {
        invalid(event, `Tool attempt ${tool.toolAttemptId} did not receive permission`);
      }
      tool.input = event.data.input;
      tool.sideEffect = event.data.sideEffect;
      tool.executionStarted = true;
      tool.status = 'started';
      return;
    }

    case DurableEventTypeValue.TOOL_COMPLETED: {
      const tool = requireToolAttempt(state, event);
      assertToolIdentity(event, tool, event.data);
      if (tool.status !== 'started' && tool.status !== 'outcome_unknown') {
        invalid(event, `Tool attempt ${tool.toolAttemptId} cannot complete from ${tool.status}`);
      }
      tool.status = 'completed';
      tool.result = event.data.result;
      delete tool.unknownReason;
      return;
    }

    case DurableEventTypeValue.TOOL_FAILED: {
      const tool = requireToolAttempt(state, event);
      assertToolIdentity(event, tool, event.data);
      if (
        tool.status !== 'scheduled' &&
        tool.status !== 'started' &&
        tool.status !== 'outcome_unknown'
      ) {
        invalid(event, `Tool attempt ${tool.toolAttemptId} cannot fail from ${tool.status}`);
      }
      assertNoPendingPermission(event, tool);
      if (
        tool.status === 'scheduled' &&
        tool.permission?.status === 'resolved' &&
        tool.permission.decision !== 'allow'
      ) {
        invalid(
          event,
          `Tool attempt ${tool.toolAttemptId} must be cancelled after permission denial`,
        );
      }
      tool.status = 'failed';
      tool.error = event.data.error;
      delete tool.unknownReason;
      return;
    }

    case DurableEventTypeValue.TOOL_CANCELLED: {
      const tool = requireToolAttempt(state, event);
      assertToolIdentity(event, tool, event.data);
      if (
        tool.status !== 'scheduled' &&
        tool.status !== 'started' &&
        tool.status !== 'outcome_unknown'
      ) {
        invalid(
          event,
          `Tool attempt ${tool.toolAttemptId} cannot be cancelled from ${tool.status}`,
        );
      }
      assertNoPendingPermission(event, tool);
      if (event.data.reason === 'permission_denied' && permissionDecision(tool) !== 'deny') {
        invalid(event, `Tool attempt ${tool.toolAttemptId} has no denied permission`);
      }
      if (event.data.reason === 'permission_cancelled' && permissionDecision(tool) !== 'cancel') {
        invalid(event, `Tool attempt ${tool.toolAttemptId} has no cancelled permission`);
      }
      tool.status = 'cancelled';
      tool.cancelReason = event.data.reason;
      delete tool.unknownReason;
      return;
    }

    case DurableEventTypeValue.TOOL_OUTCOME_UNKNOWN: {
      const tool = requireToolAttempt(state, event);
      assertToolIdentity(event, tool, event.data);
      if (tool.status !== 'started') {
        invalid(
          event,
          `Tool attempt ${tool.toolAttemptId} cannot become unknown from ${tool.status}`,
        );
      }
      tool.status = 'outcome_unknown';
      tool.unknownReason = event.data.reason;
      return;
    }

    case DurableEventTypeValue.INPUT_APPLIED: {
      const request = requireActiveRequest(state, event);
      if (
        event.turnId !== undefined
        && request.activeTurn?.turnId !== event.turnId
      ) {
        invalid(event, `No active turn matches ${String(event.turnId)}`);
      }
      if (state.seenAppliedInputIds.has(event.data.inputId)) {
        invalid(event, `Input ID ${event.data.inputId} was already applied`);
      }
      if (
        state.seenInputIds.has(event.data.inputId)
        && event.data.inputId !== request.inputId
      ) {
        invalid(event, `Input ID ${event.data.inputId} was already used by another Request`);
      }
      state.seenAppliedInputIds.add(event.data.inputId);
      state.appliedInputIds.push(event.data.inputId);
      request.appliedInputIds.push(event.data.inputId);
      request.pendingInputIds.push(event.data.inputId);
      request.lastBoundaryEventId = event.eventId;
      return;
    }
  }
}

function createProjectionAccumulator(): ProjectionAccumulator {
  return {
    sessionId: null,
    schemaVersion: null,
    status: 'empty',
    headSequence: null,
    lastEventId: null,
    created: null,
    closeReason: null,
    activeRequest: null,
    appliedInputIds: [],
    reconciledInputIds: [],
    acceptedCommandIds: [],
    seenEventIds: new Set(),
    seenRequestIds: new Set(),
    seenTurnIds: new Set(),
    turnOrigins: new Map(),
    lastTurnAbort: null,
    lastTurnTerminal: null,
    lastRequestInterruption: null,
    seenModelAttemptIds: new Set(),
    seenToolAttemptIds: new Set(),
    seenPermissionRequestIds: new Set(),
    seenInputIds: new Set(),
    seenAppliedInputIds: new Set(),
    seenCommandIds: new Set(),
  };
}

export class DurableSessionProjector {
  private state = createProjectionAccumulator();
  private failure: DurableEventProjectionError | null = null;

  apply(events: readonly DurableEventEnvelope[]): this {
    this.assertHealthy();
    for (const candidate of events) {
      try {
        this.applyCandidate(candidate);
      } catch (error) {
        this.failure =
          error instanceof DurableEventProjectionError
            ? error
            : new DurableEventProjectionError('Failed to project durable event', undefined, {
                cause: error,
              });
        throw this.failure;
      }
    }
    return this;
  }

  snapshot(): DurableSessionProjection {
    this.assertHealthy();
    const state = this.state;
    return structuredClone({
      sessionId: state.sessionId,
      schemaVersion: state.schemaVersion,
      status: state.status,
      headSequence: state.headSequence,
      lastEventId: state.lastEventId,
      created: state.created,
      closeReason: state.closeReason,
      activeRequest: cloneRequest(state.activeRequest),
      appliedInputIds: [...state.appliedInputIds],
      reconciledInputIds: [...state.reconciledInputIds],
      acceptedCommandIds: [...state.acceptedCommandIds],
    });
  }

  recoveryPlan(): DurableSessionRecoveryPlan {
    return planDurableSessionRecovery(this.snapshot());
  }

  fork(): DurableSessionProjector {
    this.assertHealthy();
    const projector = new DurableSessionProjector();
    projector.state = structuredClone(this.state);
    return projector;
  }

  preview(sessionId: SessionId, drafts: readonly DurableEventDraft[]): DurableSessionProjection {
    const projector = this.fork();
    const recordedAt = new Date(0).toISOString();
    let nextSequence = Number(projector.state.headSequence ?? 0) + 1;

    for (const candidate of drafts) {
      let eventId = EventId(`__preview__:${nextSequence}`);
      let collision = 0;
      while (projector.state.seenEventIds.has(eventId)) {
        collision += 1;
        eventId = EventId(`__preview__:${nextSequence}:${collision}`);
      }
      const draft = parseDurableEventDraft(candidate);
      const event = parseDurableEventEnvelope({
        ...draft,
        schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
        eventId,
        sequence: EventSequence(nextSequence),
        sessionId,
        recordedAt,
        occurredAt: draft.occurredAt ?? recordedAt,
      });
      assertNewInputApplicationBoundary(projector.state, event);
      assertNewRequestTerminalCausation(projector.state, event);
      projector.apply([event]);
      nextSequence += 1;
    }

    return projector.snapshot();
  }

  private assertHealthy(): void {
    if (this.failure) {
      throw this.failure;
    }
  }

  private applyCandidate(candidate: DurableEventEnvelope): void {
    let event: DurableEventEnvelope;
    try {
      event = parseDurableEventEnvelope(candidate);
    } catch (cause) {
      throw new DurableEventProjectionError('Invalid durable event envelope', undefined, {
        cause,
      });
    }

    const state = this.state;
    const expectedSequence = (state.headSequence ?? 0) + 1;
    if (event.sequence !== expectedSequence) {
      invalid(event, `Expected sequence ${expectedSequence}, received ${event.sequence}`);
    }
    if (state.sessionId && event.sessionId !== state.sessionId) {
      invalid(event, `Expected session ${state.sessionId}, received ${event.sessionId}`);
    }
    if (state.schemaVersion !== null && event.schemaVersion < state.schemaVersion) {
      invalid(
        event,
        `Durable event schema regressed from v${state.schemaVersion} to v${event.schemaVersion}`,
      );
    }
    if (state.seenEventIds.has(event.eventId)) {
      invalid(event, `Event ID ${event.eventId} was already used`);
    }
    if (event.causationEventId && !state.seenEventIds.has(event.causationEventId)) {
      invalid(event, `Causation event ${event.causationEventId} has not been observed`);
    }

    state.seenEventIds.add(event.eventId);
    applyEvent(state, event);
    state.schemaVersion = event.schemaVersion;
    state.headSequence = event.sequence;
    state.lastEventId = event.eventId;
  }
}

export function projectDurableSession(
  events: readonly DurableEventEnvelope[],
): DurableSessionProjection {
  return new DurableSessionProjector().apply(events).snapshot();
}

function permissionDecision(
  tool: DurableToolAttemptProjection,
): DurablePermissionDecision | undefined {
  return tool.permission?.status === 'resolved' ? tool.permission.decision : undefined;
}

export function planDurableSessionRecovery(
  projection: DurableSessionProjection,
): DurableSessionRecoveryPlan {
  const request = projection.activeRequest;
  const turn = request?.activeTurn ?? null;
  const activeModelAttempt = turn?.activeModelAttempt ?? null;
  const pendingInputIds = request?.pendingInputIds ?? [];
  const tools = turn?.toolAttempts ?? [];
  const modelAttemptStatuses = new Map(
    (turn?.modelAttempts ?? []).map((attempt) => [attempt.modelAttemptId, attempt.status]),
  );
  const hasUnconfirmedModelResponse = (tool: DurableToolAttemptProjection): boolean =>
    tool.modelAttemptId !== undefined
    && modelAttemptStatuses.get(tool.modelAttemptId) !== 'completed';
  const unknownToolAttempts = tools.filter(
    (tool) =>
      (tool.status === 'started' || tool.status === 'outcome_unknown')
      && tool.sideEffect === 'non_idempotent',
  );
  const pendingPermissions = tools.flatMap((tool) =>
    tool.permission?.status === 'pending' && !hasUnconfirmedModelResponse(tool)
      ? [tool.permission]
      : [],
  );
  const retryableToolAttempts = tools.filter(
    (tool) =>
      !hasUnconfirmedModelResponse(tool)
      && (
        (
        tool.status === 'scheduled'
        && tool.permission?.status !== 'pending'
        && permissionDecision(tool) !== 'deny'
        && permissionDecision(tool) !== 'cancel'
        )
        || (
          (tool.status === 'started' || tool.status === 'outcome_unknown')
          && tool.sideEffect !== 'non_idempotent'
        )
      ),
  );
  const cancelableToolAttempts = tools.filter(
    (tool) =>
      (
        tool.status === 'scheduled'
        && (permissionDecision(tool) === 'deny' || permissionDecision(tool) === 'cancel')
      )
      || (
        hasUnconfirmedModelResponse(tool)
        && (
          tool.status === 'scheduled'
          || (
            (tool.status === 'started' || tool.status === 'outcome_unknown')
            && tool.sideEffect !== 'non_idempotent'
          )
        )
      ),
  );

  let action: DurableSessionRecoveryAction = 'none';
  if (activeModelAttempt) {
    action = 'reconcile_model_outcome';
  } else if (unknownToolAttempts.length > 0) {
    action = 'reconcile_tool_outcomes';
  } else if (pendingPermissions.length > 0) {
    action = 'resolve_permissions';
  } else if (turn) {
    action = 'resume_turn';
  } else if (request?.status === 'accepted') {
    action = (request.appliedInputIds ?? []).length === 0
      ? 'resume_request'
      : 'reconcile_request_inputs';
  } else if (pendingInputIds.length > 0) {
    action = 'reconcile_request_inputs';
  } else if (request?.lastTurn === 0) {
    const appliedInputIds = request.appliedInputIds ?? [];
    action =
      appliedInputIds.length === 1
      && appliedInputIds[0] === request.inputId
        ? 'rollover_request'
        : 'reconcile_request_inputs';
  } else if (request) {
    action = 'reconcile_request_outcome';
  }

  return {
    action,
    requestId: request?.requestId ?? null,
    turnId: turn?.turnId ?? null,
    activeModelAttempt,
    retryableToolAttempts,
    cancelableToolAttempts,
    unknownToolAttempts,
    pendingPermissions,
  };
}

export function isDurableEventType(value: string): value is DurableEventType {
  return Object.values(DurableEventTypeValue).includes(value as DurableEventType);
}
