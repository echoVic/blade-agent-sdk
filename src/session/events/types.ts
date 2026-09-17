import type { ModelIdentity } from '../../model/identity.js';
import type { ModelUsage, TokenUsage } from '../../model/usage.js';
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
import type { DurableExecutionFence } from './DurableExecutionLeaseStore.js';

export const DURABLE_EVENT_SCHEMA_VERSION = 4 as const;
export type DurableEventSchemaVersion = typeof DURABLE_EVENT_SCHEMA_VERSION;

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

export const DurableEventScope = {
  [DurableEventType.SESSION_CREATED]: 'session',
  [DurableEventType.SESSION_CLOSED]: 'session',
  [DurableEventType.REQUEST_ACCEPTED]: 'accepted_request',
  [DurableEventType.REQUEST_STARTED]: 'request',
  [DurableEventType.REQUEST_COMPLETED]: 'request',
  [DurableEventType.REQUEST_FAILED]: 'request',
  [DurableEventType.REQUEST_INTERRUPTED]: 'request',
  [DurableEventType.TURN_STARTED]: 'turn',
  [DurableEventType.TURN_COMPLETED]: 'turn',
  [DurableEventType.TURN_ABORTED]: 'turn',
  [DurableEventType.MODEL_REQUEST_STARTED]: 'model',
  [DurableEventType.MODEL_REQUEST_COMPLETED]: 'model',
  [DurableEventType.MODEL_REQUEST_FAILED]: 'model',
  [DurableEventType.MODEL_REQUEST_ABORTED]: 'model',
  [DurableEventType.TOOL_SCHEDULED]: 'scheduled_tool',
  [DurableEventType.TOOL_STARTED]: 'tool',
  [DurableEventType.TOOL_COMPLETED]: 'tool',
  [DurableEventType.TOOL_FAILED]: 'tool',
  [DurableEventType.TOOL_CANCELLED]: 'tool',
  [DurableEventType.TOOL_OUTCOME_UNKNOWN]: 'tool',
  [DurableEventType.PERMISSION_REQUESTED]: 'tool',
  [DurableEventType.PERMISSION_RESOLVED]: 'tool',
  [DurableEventType.INPUT_APPLIED]: 'input',
} as const satisfies Record<DurableEventType, DurableEventScopeName>;

export type DurableEventScopeName =
  | 'session'
  | 'accepted_request'
  | 'request'
  | 'turn'
  | 'model'
  | 'scheduled_tool'
  | 'tool'
  | 'input';

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

type OptionalCommand = { readonly commandId?: CommandId };
type CorrelationForScope<TScope extends DurableEventScopeName> = TScope extends 'session'
  ? OptionalCommand & {
      readonly requestId?: never;
      readonly turnId?: never;
      readonly modelAttemptId?: never;
      readonly toolAttemptId?: never;
    }
  : TScope extends 'accepted_request'
    ? { readonly commandId: CommandId; readonly requestId: RequestId }
    : TScope extends 'request'
      ? OptionalCommand & {
          readonly requestId: RequestId;
          readonly turnId?: never;
          readonly modelAttemptId?: never;
          readonly toolAttemptId?: never;
        }
      : TScope extends 'turn'
        ? OptionalCommand & {
            readonly requestId: RequestId;
            readonly turnId: TurnId;
            readonly modelAttemptId?: never;
            readonly toolAttemptId?: never;
          }
        : TScope extends 'model'
          ? OptionalCommand & {
              readonly requestId: RequestId;
              readonly turnId: TurnId;
              readonly modelAttemptId: ModelAttemptId;
              readonly toolAttemptId?: never;
            }
          : TScope extends 'scheduled_tool'
            ? OptionalCommand & {
                readonly requestId: RequestId;
                readonly turnId: TurnId;
                readonly modelAttemptId: ModelAttemptId;
                readonly toolAttemptId: ToolAttemptId;
              }
            : TScope extends 'tool'
              ? OptionalCommand & {
                  readonly requestId: RequestId;
                  readonly turnId: TurnId;
                  readonly modelAttemptId?: never;
                  readonly toolAttemptId: ToolAttemptId;
                }
              : OptionalCommand & {
                  readonly requestId: RequestId;
                  readonly turnId?: TurnId;
                  readonly modelAttemptId?: never;
                  readonly toolAttemptId?: never;
                };
type DurableEventCorrelation<TType extends DurableEventType> = CorrelationForScope<
  (typeof DurableEventScope)[TType]
>;

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
