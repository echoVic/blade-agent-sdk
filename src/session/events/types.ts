import type { ModelIdentity } from '../../model/identity.js';
import type { ModelUsage, TokenUsage } from '../../model/usage.js';
import type { ToolSideEffect } from '../../tools/types/kind.js';
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
import type { DurableExecutionFence } from './DurableExecutionLeaseStore.js';

export const DURABLE_EVENT_SCHEMA_VERSION = 4 as const;
export type DurableEventSchemaVersion = 2 | 3 | typeof DURABLE_EVENT_SCHEMA_VERSION;

export const DurableEventType = {
  SESSION_CREATED: 'session_created',
  SESSION_CLOSED: 'session_closed',
  REQUEST_ACCEPTED: 'request_accepted',
  REQUEST_STARTED: 'request_started',
  REQUEST_COMPLETED: 'request_completed',
  REQUEST_FAILED: 'request_failed',
  REQUEST_INTERRUPTED: 'request_interrupted',
  TURN_STARTED: 'turn_started',
  TURN_COMPLETED: 'turn_completed',
  TURN_ABORTED: 'turn_aborted',
  MODEL_REQUEST_STARTED: 'model_request_started',
  MODEL_REQUEST_COMPLETED: 'model_request_completed',
  MODEL_REQUEST_FAILED: 'model_request_failed',
  MODEL_REQUEST_ABORTED: 'model_request_aborted',
  TOOL_SCHEDULED: 'tool_scheduled',
  TOOL_STARTED: 'tool_started',
  TOOL_COMPLETED: 'tool_completed',
  TOOL_FAILED: 'tool_failed',
  TOOL_CANCELLED: 'tool_cancelled',
  TOOL_OUTCOME_UNKNOWN: 'tool_outcome_unknown',
  PERMISSION_REQUESTED: 'permission_requested',
  PERMISSION_RESOLVED: 'permission_resolved',
  INPUT_APPLIED: 'input_applied',
} as const;

export type DurableEventType = (typeof DurableEventType)[keyof typeof DurableEventType];

export type DurableInputPriority = 'now' | 'next' | 'later';
export type DurableToolInterruptBehavior = 'block' | 'cancel';
export type DurablePermissionDecision = 'allow' | 'deny' | 'cancel';
export type DurableSessionCloseReason = 'completed' | 'user' | 'shutdown' | 'error';
export type DurableRequestInterruptReason =
  | 'user_abort'
  | 'session_close'
  | 'steering'
  | 'process_restart';
export type DurableTurnAbortReason =
  | 'request_interrupted'
  | 'error'
  | 'process_restart'
  | 'recovery_required';
export type DurableToolCancelReason =
  | 'request_interrupted'
  | 'permission_denied'
  | 'permission_cancelled'
  | 'cascade_abort'
  | 'process_restart';
export type DurableToolOutcomeUnknownReason = 'process_restart' | 'commit_outcome_unknown';
export type DurableModelRequestAbortReason = 'request_interrupted' | 'steering' | 'process_restart';

export interface DurableEventError {
  message: string;
  code?: string;
  retryable?: boolean;
}

export type DurableTokenUsage = Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>;

export type DurableModelUsage = ModelUsage;

export interface DurableModelToolCall {
  id: ToolUseId;
  name: string;
  arguments: string;
}

export interface DurableModelResponse {
  content: string;
  reasoningContent?: string;
  toolCalls?: readonly DurableModelToolCall[];
  usage?: DurableModelUsage;
}

export interface DurableRequestRecoveryOrigin {
  requestId: RequestId;
  turnId: TurnId;
  turn: number;
}

export interface DurableEventDataMap {
  [DurableEventType.SESSION_CREATED]: {
    source?: 'create' | 'resume' | 'fork';
    parentSessionId?: SessionId;
  };
  [DurableEventType.SESSION_CLOSED]: {
    reason: DurableSessionCloseReason;
  };
  [DurableEventType.REQUEST_ACCEPTED]: {
    inputId: InputId;
    input: JsonValue;
    priority: DurableInputPriority;
    maxTurns?: number;
    model?: string;
    context?: JsonObject;
    recovery?: DurableRequestRecoveryOrigin;
  };
  [DurableEventType.REQUEST_STARTED]: Record<string, never>;
  [DurableEventType.REQUEST_COMPLETED]: {
    output?: JsonValue;
    usage?: DurableTokenUsage;
  };
  [DurableEventType.REQUEST_FAILED]: {
    error: DurableEventError;
  };
  [DurableEventType.REQUEST_INTERRUPTED]: {
    reason: DurableRequestInterruptReason;
    byInputId?: InputId;
  };
  [DurableEventType.TURN_STARTED]: {
    turn: number;
    model?: string;
  };
  [DurableEventType.TURN_COMPLETED]: {
    turn: number;
    hasToolCalls: boolean;
  };
  [DurableEventType.TURN_ABORTED]: {
    turn: number;
    reason: DurableTurnAbortReason;
  };
  [DurableEventType.MODEL_REQUEST_STARTED]: {
    model: string;
    modelIdentity?: ModelIdentity;
    streaming: boolean;
  };
  [DurableEventType.MODEL_REQUEST_COMPLETED]: {
    response: DurableModelResponse;
  };
  [DurableEventType.MODEL_REQUEST_FAILED]: {
    error: DurableEventError;
  };
  [DurableEventType.MODEL_REQUEST_ABORTED]: {
    reason: DurableModelRequestAbortReason;
  };
  [DurableEventType.TOOL_SCHEDULED]: {
    toolCallId: ToolUseId;
    toolName: string;
    modelInput?: JsonValue;
    input: JsonValue;
    sideEffect: ToolSideEffect;
    interruptBehavior: DurableToolInterruptBehavior;
  };
  [DurableEventType.TOOL_STARTED]: {
    toolCallId: ToolUseId;
    toolName: string;
    input: JsonValue;
    sideEffect: ToolSideEffect;
  };
  [DurableEventType.TOOL_COMPLETED]: {
    toolCallId: ToolUseId;
    toolName: string;
    result: JsonValue;
  };
  [DurableEventType.TOOL_FAILED]: {
    toolCallId: ToolUseId;
    toolName: string;
    error: DurableEventError;
  };
  [DurableEventType.TOOL_CANCELLED]: {
    toolCallId: ToolUseId;
    toolName: string;
    reason: DurableToolCancelReason;
  };
  [DurableEventType.TOOL_OUTCOME_UNKNOWN]: {
    toolCallId: ToolUseId;
    toolName: string;
    reason: DurableToolOutcomeUnknownReason;
  };
  [DurableEventType.PERMISSION_REQUESTED]: {
    permissionRequestId: PermissionRequestId;
    toolCallId: ToolUseId;
    toolName: string;
    input: JsonValue;
    message?: string;
  };
  [DurableEventType.PERMISSION_RESOLVED]: {
    permissionRequestId: PermissionRequestId;
    decision: DurablePermissionDecision;
    message?: string;
  };
  [DurableEventType.INPUT_APPLIED]: {
    inputId: InputId;
    priority: Exclude<DurableInputPriority, 'later'>;
  };
}

interface SessionEventCorrelation {
  readonly commandId?: CommandId;
  readonly modelAttemptId?: never;
}

interface RequestAcceptedCorrelation {
  readonly requestId: RequestId;
  readonly commandId: CommandId;
}

interface RequestEventCorrelation {
  readonly requestId: RequestId;
  readonly commandId?: CommandId;
  readonly modelAttemptId?: never;
}

interface TurnEventCorrelation extends RequestEventCorrelation {
  readonly turnId: TurnId;
  readonly toolAttemptId?: never;
}

interface ModelEventCorrelation {
  readonly requestId: RequestId;
  readonly turnId: TurnId;
  readonly modelAttemptId: ModelAttemptId;
  readonly commandId?: CommandId;
}

interface ToolScheduledCorrelation {
  readonly requestId: RequestId;
  readonly turnId: TurnId;
  readonly modelAttemptId?: ModelAttemptId;
  readonly toolAttemptId: ToolAttemptId;
  readonly commandId?: CommandId;
}

interface ToolEventCorrelation {
  readonly requestId: RequestId;
  readonly turnId: TurnId;
  readonly toolAttemptId: ToolAttemptId;
  readonly modelAttemptId?: never;
  readonly commandId?: CommandId;
}

interface InputAppliedCorrelation {
  readonly requestId: RequestId;
  readonly turnId?: TurnId;
  readonly modelAttemptId?: never;
  readonly toolAttemptId?: never;
  readonly commandId?: CommandId;
}

interface DurableEventCorrelationMap {
  [DurableEventType.SESSION_CREATED]: SessionEventCorrelation;
  [DurableEventType.SESSION_CLOSED]: SessionEventCorrelation;
  [DurableEventType.REQUEST_ACCEPTED]: RequestAcceptedCorrelation;
  [DurableEventType.REQUEST_STARTED]: RequestEventCorrelation;
  [DurableEventType.REQUEST_COMPLETED]: RequestEventCorrelation;
  [DurableEventType.REQUEST_FAILED]: RequestEventCorrelation;
  [DurableEventType.REQUEST_INTERRUPTED]: RequestEventCorrelation;
  [DurableEventType.TURN_STARTED]: TurnEventCorrelation;
  [DurableEventType.TURN_COMPLETED]: TurnEventCorrelation;
  [DurableEventType.TURN_ABORTED]: TurnEventCorrelation;
  [DurableEventType.MODEL_REQUEST_STARTED]: ModelEventCorrelation;
  [DurableEventType.MODEL_REQUEST_COMPLETED]: ModelEventCorrelation;
  [DurableEventType.MODEL_REQUEST_FAILED]: ModelEventCorrelation;
  [DurableEventType.MODEL_REQUEST_ABORTED]: ModelEventCorrelation;
  [DurableEventType.TOOL_SCHEDULED]: ToolScheduledCorrelation;
  [DurableEventType.TOOL_STARTED]: ToolEventCorrelation;
  [DurableEventType.TOOL_COMPLETED]: ToolEventCorrelation;
  [DurableEventType.TOOL_FAILED]: ToolEventCorrelation;
  [DurableEventType.TOOL_CANCELLED]: ToolEventCorrelation;
  [DurableEventType.TOOL_OUTCOME_UNKNOWN]: ToolEventCorrelation;
  [DurableEventType.PERMISSION_REQUESTED]: ToolEventCorrelation;
  [DurableEventType.PERMISSION_RESOLVED]: ToolEventCorrelation;
  [DurableEventType.INPUT_APPLIED]: InputAppliedCorrelation;
}

type DurableEventCorrelation<TType extends DurableEventType> = DurableEventCorrelationMap[TType];

type DurableEventDraftVariant<TType extends DurableEventType> = {
  readonly type: TType;
  readonly data: DurableEventDataMap[TType];
  readonly occurredAt?: string;
  readonly causationEventId?: EventId;
} & DurableEventCorrelation<TType>;

export type DurableEventDraft<TType extends DurableEventType = DurableEventType> =
  TType extends DurableEventType ? DurableEventDraftVariant<TType> : never;

type DurableEventEnvelopeFields = {
  readonly schemaVersion: DurableEventSchemaVersion;
  readonly eventId: EventId;
  readonly sequence: EventSequence;
  readonly sessionId: SessionId;
  readonly recordedAt: string;
  readonly occurredAt: string;
};

export type DurableEventEnvelope<TType extends DurableEventType = DurableEventType> =
  TType extends DurableEventType
    ? Omit<DurableEventDraftVariant<TType>, 'occurredAt'> & DurableEventEnvelopeFields
    : never;

export type DurableEventOfType<TType extends DurableEventType> = Extract<
  DurableEventEnvelope,
  { type: TType }
>;

export interface DurableEventReadOptions {
  /** Cooperative cancellation signal supplied by the SDK deadline boundary. */
  signal?: AbortSignal;
  /** Exclusive cursor. Omit to read from the first event. */
  after?: EventSequence;
  /** Maximum number of events to return. */
  limit?: number;
}

export interface DurableEventPage {
  readonly events: readonly DurableEventEnvelope[];
  readonly headSequence: EventSequence | null;
  readonly nextCursor: EventSequence | null;
  readonly hasMore: boolean;
}

export interface DurableEventAppendOptions {
  /** Cooperative cancellation signal supplied by the SDK deadline boundary. */
  signal?: AbortSignal;
  /**
   * Compare-and-append precondition.
   * - undefined: append to the current head
   * - null: require an empty event stream
   * - EventSequence: require an exact current head
   */
  expectedLastSequence?: EventSequence | null;
  /**
   * Fences the append to a currently active execution lease. Lease-capable
   * stores must validate this in the same transaction as the append and reject
   * an omitted fence once the Session has entered fenced execution mode.
   */
  executionFence?: DurableExecutionFence;
}

export interface DurableEventAppendResult {
  readonly events: readonly DurableEventEnvelope[];
  readonly previousSequence: EventSequence | null;
  readonly lastSequence: EventSequence;
}
