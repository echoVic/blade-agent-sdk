import type { ModelIdentity } from '../../model/identity.js';
import type { ToolSideEffect } from '../../tools/behavior.js';
import type {
  CommandId,
  EventId,
  EventSequence,
  InputId,
  ModelAttemptId,
  PermissionRequestId,
  RequestId,
  SessionId,
  ToolAttemptId,
  ToolUseId,
  TurnId,
} from '../../types/identifiers.js';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type {
  DurableEventDataMap,
  DurableEventError,
  DurableEventSchemaVersion,
  DurableEventType,
  DurableInputPriority,
  DurableModelRequestAbortReason,
  DurableModelResponse,
  DurablePermissionDecision,
  DurableRequestInterruptReason,
  DurableRequestRecoveryOrigin,
  DurableSessionCloseReason,
  DurableToolCancelReason,
  DurableToolInterruptBehavior,
  DurableToolOutcomeUnknownReason,
  DurableTurnAbortReason,
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
  readonly reconciledInputIds: readonly InputId[];
  readonly status: DurableRequestStatus;
  readonly appliedInputIds: readonly InputId[];
  readonly pendingInputIds: readonly InputId[];
  readonly lastTurn: number;
  readonly lastTurnEventId: EventId | null;
  readonly activeTurn: DurableTurnProjection | null;
}

export interface DurableSessionProjection {
  readonly sessionId: SessionId | null;
  readonly schemaVersion: DurableEventSchemaVersion | null;
  readonly status: DurableSessionProjectionStatus;
  readonly headSequence: EventSequence | null;
  readonly lastEventId: EventId | null;
  readonly created: DurableEventDataMap[typeof DurableEventType.SESSION_CREATED] | null;
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

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type MutablePermissionProjection = Mutable<DurablePermissionProjection>;
export type MutableToolAttemptProjection = Omit<
  Mutable<DurableToolAttemptProjection>,
  'permission'
> & {
  permission: MutablePermissionProjection | null;
};
export type MutableModelAttemptProjection = Mutable<DurableModelAttemptProjection>;
export type MutableTurnProjection = Omit<
  Mutable<DurableTurnProjection>,
  'activeModelAttempt' | 'modelAttempts' | 'toolAttempts'
> & {
  preparedInputIds: InputId[];
  modelAttempts: MutableModelAttemptProjection[];
  activeModelAttempt: MutableModelAttemptProjection | null;
  toolAttempts: MutableToolAttemptProjection[];
};

export type MutableRequestProjection = Omit<
  Mutable<DurableRequestProjection>,
  'activeTurn' | 'appliedInputIds' | 'pendingInputIds' | 'reconciledInputIds'
> & {
  activeTurn: MutableTurnProjection | null;
  appliedInputIds: InputId[];
  pendingInputIds: InputId[];
  reconciledInputIds: InputId[];
  lastBoundaryEventId: EventId;
};

export interface DurableSessionState {
  sessionId: SessionId | null;
  schemaVersion: DurableEventSchemaVersion | null;
  status: DurableSessionProjectionStatus;
  headSequence: EventSequence | null;
  lastEventId: EventId | null;
  created: DurableEventDataMap[typeof DurableEventType.SESSION_CREATED] | null;
  closeReason: DurableSessionCloseReason | null;
  activeRequest: MutableRequestProjection | null;
  appliedInputIds: InputId[];
  reconciledInputIds: InputId[];
  acceptedCommandIds: CommandId[];
  seenEventIds: Set<EventId>;
  seenRequestIds: Set<RequestId>;
  seenTurnIds: Set<TurnId>;
  seenModelAttemptIds: Set<ModelAttemptId>;
  seenToolAttemptIds: Set<ToolAttemptId>;
  seenPermissionRequestIds: Set<PermissionRequestId>;
  seenInputIds: Set<InputId>;
  seenAppliedInputIds: Set<InputId>;
  seenCommandIds: Set<CommandId>;
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
    preparedInputIds: InputId[];
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
    appliedInputIds: InputId[];
    status: DurableRequestStatus;
    lastTurn: number;
    commandId?: CommandId;
    sequence: EventSequence;
    reason: DurableRequestInterruptReason;
  } | null;
}

export function createDurableSessionState(): DurableSessionState {
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
    seenModelAttemptIds: new Set(),
    seenToolAttemptIds: new Set(),
    seenPermissionRequestIds: new Set(),
    seenInputIds: new Set(),
    seenAppliedInputIds: new Set(),
    seenCommandIds: new Set(),
    turnOrigins: new Map(),
    lastTurnAbort: null,
    lastTurnTerminal: null,
    lastRequestInterruption: null,
  };
}

export function snapshotDurableSessionState(state: DurableSessionState): DurableSessionProjection {
  const activeRequest = state.activeRequest
    ? (({ lastBoundaryEventId: _, ...request }) => request)(state.activeRequest)
    : null;
  return structuredClone({
    sessionId: state.sessionId,
    schemaVersion: state.schemaVersion,
    status: state.status,
    headSequence: state.headSequence,
    lastEventId: state.lastEventId,
    created: state.created,
    closeReason: state.closeReason,
    activeRequest,
    appliedInputIds: state.appliedInputIds,
    reconciledInputIds: state.reconciledInputIds,
    acceptedCommandIds: state.acceptedCommandIds,
  });
}
