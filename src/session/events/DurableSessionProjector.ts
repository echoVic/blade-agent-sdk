import { SdkError } from '../../errors/SdkError.js';
import type { ToolSideEffect } from '../../tools/types/ToolKind.js';
import {
  type CommandId,
  EventId,
  EventSequence,
  type InputId,
  type PermissionRequestId,
  type RequestId,
  type SessionId,
  type ToolAttemptId,
  type ToolUseId,
  type TurnId,
} from '../../types/branded.js';
import type { JsonObject, JsonValue } from '../../types/common.js';
import { parseDurableEventDraft, parseDurableEventEnvelope } from './schemas.js';
import {
  DURABLE_EVENT_SCHEMA_VERSION,
  type DurableEventDataMap,
  type DurableEventDraft,
  type DurableEventEnvelope,
  type DurableEventError,
  type DurableEventType,
  DurableEventType as DurableEventTypeValue,
  type DurableInputPriority,
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
export type DurableTurnStatus = 'running';
export type DurableToolAttemptStatus =
  | 'scheduled'
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';
export type DurablePermissionStatus = 'pending' | 'resolved';
export type DurableSessionRecoveryAction =
  | 'none'
  | 'resume_request'
  | 'resume_turn'
  | 'resolve_permissions'
  | 'reconcile_tool_outcomes';

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

export interface DurableTurnProjection {
  readonly turnId: TurnId;
  readonly turn: number;
  readonly model?: string;
  readonly status: DurableTurnStatus;
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
  readonly status: DurableRequestStatus;
  readonly lastTurn: number;
  readonly activeTurn: DurableTurnProjection | null;
}

export interface DurableSessionProjection {
  readonly sessionId: SessionId | null;
  readonly status: DurableSessionProjectionStatus;
  readonly headSequence: EventSequence | null;
  readonly lastEventId: EventId | null;
  readonly created: DurableEventDataMap[typeof DurableEventTypeValue.SESSION_CREATED] | null;
  readonly closeReason: DurableSessionCloseReason | null;
  readonly activeRequest: DurableRequestProjection | null;
  readonly appliedInputIds: readonly InputId[];
  readonly acceptedCommandIds: readonly CommandId[];
}

export interface DurableSessionRecoveryPlan {
  readonly action: DurableSessionRecoveryAction;
  readonly requestId: RequestId | null;
  readonly turnId: TurnId | null;
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

interface MutableTurnProjection {
  turnId: TurnId;
  turn: number;
  model?: string;
  status: DurableTurnStatus;
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
  status: DurableRequestStatus;
  lastTurn: number;
  activeTurn: MutableTurnProjection | null;
}

interface ProjectionAccumulator {
  sessionId: SessionId | null;
  status: DurableSessionProjectionStatus;
  headSequence: EventSequence | null;
  lastEventId: EventId | null;
  created: DurableEventDataMap[typeof DurableEventTypeValue.SESSION_CREATED] | null;
  closeReason: DurableSessionCloseReason | null;
  activeRequest: MutableRequestProjection | null;
  appliedInputIds: InputId[];
  acceptedCommandIds: CommandId[];
  seenEventIds: Set<EventId>;
  seenRequestIds: Set<RequestId>;
  seenTurnIds: Set<TurnId>;
  turnOrigins: Map<TurnId, { requestId: RequestId; turn: number }>;
  lastTurnAbort: {
    requestId: RequestId;
    turnId: TurnId;
    turn: number;
    commandId?: CommandId;
    sequence: EventSequence;
    reason: DurableTurnAbortReason;
    unsafeNonIdempotentToolAttemptId: ToolAttemptId | null;
  } | null;
  lastRequestInterruption: {
    requestId: RequestId;
    commandId?: CommandId;
    sequence: EventSequence;
    reason: DurableRequestInterruptReason;
  } | null;
  seenToolAttemptIds: Set<ToolAttemptId>;
  seenPermissionRequestIds: Set<PermissionRequestId>;
  seenInputIds: Set<InputId>;
  seenAppliedInputIds: Set<InputId>;
  seenCommandIds: Set<CommandId>;
}

type RequestScopedEvent = DurableEventEnvelope & { readonly requestId: RequestId };
type TurnScopedEvent = RequestScopedEvent & { readonly turnId: TurnId };
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

function assertToolIdentity(
  event: DurableEventEnvelope,
  tool: MutableToolAttemptProjection,
  data: { toolCallId: ToolUseId; toolName: string },
): void {
  if (tool.toolCallId !== data.toolCallId || tool.toolName !== data.toolName) {
    invalid(event, `Tool identity does not match attempt ${tool.toolAttemptId}`);
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

function cloneTurn(turn: MutableTurnProjection | null): DurableTurnProjection | null {
  if (!turn) {
    return null;
  }
  return {
    turnId: turn.turnId,
    turn: turn.turn,
    ...(turn.model ? { model: turn.model } : {}),
    status: turn.status,
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
    status: request.status,
    lastTurn: request.lastTurn,
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

    case DurableEventTypeValue.REQUEST_ACCEPTED:
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
      if (event.data.recovery) {
        const origin = state.turnOrigins.get(event.data.recovery.turnId);
        const turnAbort = state.lastTurnAbort;
        const requestInterruption = state.lastRequestInterruption;
        if (
          !origin ||
          origin.requestId !== event.data.recovery.requestId ||
          origin.turn !== event.data.recovery.turn ||
          !turnAbort ||
          turnAbort.requestId !== event.data.recovery.requestId ||
          turnAbort.turnId !== event.data.recovery.turnId ||
          turnAbort.turn !== event.data.recovery.turn ||
          turnAbort.reason !== 'process_restart' ||
          turnAbort.commandId !== event.commandId ||
          !requestInterruption ||
          requestInterruption.requestId !== event.data.recovery.requestId ||
          requestInterruption.reason !== 'process_restart' ||
          requestInterruption.commandId !== event.commandId ||
          Number(turnAbort.sequence) + 1 !== Number(requestInterruption.sequence) ||
          Number(requestInterruption.sequence) + 1 !== Number(event.sequence)
        ) {
          invalid(
            event,
            `Recovery origin ${event.data.recovery.turnId} is not an atomic canonical rollover`,
          );
        }
        if (turnAbort.unsafeNonIdempotentToolAttemptId) {
          invalid(
            event,
            `Recovery origin ${event.data.recovery.turnId} crossed non-idempotent tool attempt ${turnAbort.unsafeNonIdempotentToolAttemptId}`,
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
        status: 'accepted',
        lastTurn: 0,
        activeTurn: null,
      };
      return;

    case DurableEventTypeValue.REQUEST_STARTED: {
      const request = requireActiveRequest(state, event);
      if (request.status !== 'accepted') {
        invalid(event, `Request ${request.requestId} was already started`);
      }
      request.status = 'running';
      return;
    }

    case DurableEventTypeValue.REQUEST_COMPLETED: {
      const request = requireRunningRequest(state, event);
      if (request.activeTurn) {
        invalid(event, `Turn ${request.activeTurn.turnId} is still active`);
      }
      state.activeRequest = null;
      return;
    }

    case DurableEventTypeValue.REQUEST_FAILED: {
      const request = requireActiveRequest(state, event);
      if (request.activeTurn) {
        invalid(event, `Turn ${request.activeTurn.turnId} is still active`);
      }
      state.activeRequest = null;
      return;
    }

    case DurableEventTypeValue.REQUEST_INTERRUPTED: {
      const request = requireActiveRequest(state, event);
      if (request.activeTurn) {
        invalid(event, `Turn ${request.activeTurn.turnId} is still active`);
      }
      state.activeRequest = null;
      state.lastRequestInterruption = {
        requestId: event.requestId,
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
      });
      request.lastTurn = event.data.turn;
      request.activeTurn = {
        turnId: event.turnId,
        turn: event.data.turn,
        ...(event.data.model ? { model: event.data.model } : {}),
        status: 'running',
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
      state.lastTurnAbort = {
        requestId: event.requestId,
        turnId: event.turnId,
        turn: event.data.turn,
        ...(event.commandId ? { commandId: event.commandId } : {}),
        sequence: event.sequence,
        reason: event.data.reason,
        unsafeNonIdempotentToolAttemptId: unsafeNonIdempotentTool?.toolAttemptId ?? null,
      };
      return;
    }

    case DurableEventTypeValue.TOOL_SCHEDULED: {
      const turn = requireActiveTurn(state, event);
      if (state.seenToolAttemptIds.has(event.toolAttemptId)) {
        invalid(event, `Tool attempt ID ${event.toolAttemptId} was already used`);
      }
      state.seenToolAttemptIds.add(event.toolAttemptId);
      turn.toolAttempts.set(event.toolAttemptId, {
        toolAttemptId: event.toolAttemptId,
        toolCallId: event.data.toolCallId,
        toolName: event.data.toolName,
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
      requireActiveRequest(state, event);
      if (state.seenAppliedInputIds.has(event.data.inputId)) {
        invalid(event, `Input ID ${event.data.inputId} was already applied`);
      }
      state.seenAppliedInputIds.add(event.data.inputId);
      state.appliedInputIds.push(event.data.inputId);
      return;
    }
  }
}

function createProjectionAccumulator(): ProjectionAccumulator {
  return {
    sessionId: null,
    status: 'empty',
    headSequence: null,
    lastEventId: null,
    created: null,
    closeReason: null,
    activeRequest: null,
    appliedInputIds: [],
    acceptedCommandIds: [],
    seenEventIds: new Set(),
    seenRequestIds: new Set(),
    seenTurnIds: new Set(),
    turnOrigins: new Map(),
    lastTurnAbort: null,
    lastRequestInterruption: null,
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
      status: state.status,
      headSequence: state.headSequence,
      lastEventId: state.lastEventId,
      created: state.created,
      closeReason: state.closeReason,
      activeRequest: cloneRequest(state.activeRequest),
      appliedInputIds: [...state.appliedInputIds],
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
      projector.apply([
        parseDurableEventEnvelope({
          ...draft,
          schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
          eventId,
          sequence: EventSequence(nextSequence),
          sessionId,
          recordedAt,
          occurredAt: draft.occurredAt ?? recordedAt,
        }),
      ]);
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
    if (state.seenEventIds.has(event.eventId)) {
      invalid(event, `Event ID ${event.eventId} was already used`);
    }
    if (event.causationEventId && !state.seenEventIds.has(event.causationEventId)) {
      invalid(event, `Causation event ${event.causationEventId} has not been observed`);
    }

    state.seenEventIds.add(event.eventId);
    applyEvent(state, event);
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
  const tools = turn?.toolAttempts ?? [];
  const unknownToolAttempts = tools.filter(
    (tool) =>
      (tool.status === 'started' || tool.status === 'outcome_unknown')
      && tool.sideEffect === 'non_idempotent',
  );
  const pendingPermissions = tools.flatMap((tool) =>
    tool.permission?.status === 'pending' ? [tool.permission] : [],
  );
  const retryableToolAttempts = tools.filter(
    (tool) =>
      (
        tool.status === 'scheduled'
        && tool.permission?.status !== 'pending'
        && permissionDecision(tool) !== 'deny'
        && permissionDecision(tool) !== 'cancel'
      )
      || (
        (tool.status === 'started' || tool.status === 'outcome_unknown')
        && tool.sideEffect !== 'non_idempotent'
      ),
  );
  const cancelableToolAttempts = tools.filter(
    (tool) =>
      tool.status === 'scheduled' &&
      (permissionDecision(tool) === 'deny' || permissionDecision(tool) === 'cancel'),
  );

  let action: DurableSessionRecoveryAction = 'none';
  if (unknownToolAttempts.length > 0) {
    action = 'reconcile_tool_outcomes';
  } else if (pendingPermissions.length > 0) {
    action = 'resolve_permissions';
  } else if (turn) {
    action = 'resume_turn';
  } else if (request) {
    action = 'resume_request';
  }

  return {
    action,
    requestId: request?.requestId ?? null,
    turnId: turn?.turnId ?? null,
    retryableToolAttempts,
    cancelableToolAttempts,
    unknownToolAttempts,
    pendingPermissions,
  };
}

export function isDurableEventType(value: string): value is DurableEventType {
  return Object.values(DurableEventTypeValue).includes(value as DurableEventType);
}
