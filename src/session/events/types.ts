import type { ToolSideEffect } from '../../tools/types/ToolKind.js';
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
} from '../../types/branded.js';
import type { JsonObject, JsonValue } from '../../types/common.js';
import type { DurableExecutionFence } from './DurableExecutionLeaseStore.js';

export const DURABLE_EVENT_SCHEMA_VERSION = 3 as const;
export type DurableEventSchemaVersion = 2 | typeof DURABLE_EVENT_SCHEMA_VERSION;

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

export interface DurableTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface DurableModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
  billableInputTokens?: number;
}

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

type SessionEventType =
  | typeof DurableEventType.SESSION_CREATED
  | typeof DurableEventType.SESSION_CLOSED;

type RequestEventType =
  | typeof DurableEventType.REQUEST_ACCEPTED
  | typeof DurableEventType.REQUEST_STARTED
  | typeof DurableEventType.REQUEST_COMPLETED
  | typeof DurableEventType.REQUEST_FAILED
  | typeof DurableEventType.REQUEST_INTERRUPTED;

type TurnEventType =
  | typeof DurableEventType.TURN_STARTED
  | typeof DurableEventType.TURN_COMPLETED
  | typeof DurableEventType.TURN_ABORTED;

type ModelEventType =
  | typeof DurableEventType.MODEL_REQUEST_STARTED
  | typeof DurableEventType.MODEL_REQUEST_COMPLETED
  | typeof DurableEventType.MODEL_REQUEST_FAILED
  | typeof DurableEventType.MODEL_REQUEST_ABORTED;

type ToolEventType =
  | typeof DurableEventType.TOOL_STARTED
  | typeof DurableEventType.TOOL_COMPLETED
  | typeof DurableEventType.TOOL_FAILED
  | typeof DurableEventType.TOOL_CANCELLED
  | typeof DurableEventType.TOOL_OUTCOME_UNKNOWN;

type PermissionEventType =
  | typeof DurableEventType.PERMISSION_REQUESTED
  | typeof DurableEventType.PERMISSION_RESOLVED;

type DurableEventCorrelation<TType extends DurableEventType> =
  TType extends typeof DurableEventType.REQUEST_ACCEPTED
    ? { readonly requestId: RequestId; readonly commandId: CommandId }
    : TType extends ModelEventType
      ? {
          readonly requestId: RequestId;
          readonly turnId: TurnId;
          readonly modelAttemptId: ModelAttemptId;
          readonly commandId?: CommandId;
        }
      : TType extends typeof DurableEventType.TOOL_SCHEDULED
        ? {
            readonly requestId: RequestId;
            readonly turnId: TurnId;
            readonly modelAttemptId?: ModelAttemptId;
            readonly toolAttemptId: ToolAttemptId;
            readonly commandId?: CommandId;
          }
        : TType extends ToolEventType | PermissionEventType
          ? {
              readonly requestId: RequestId;
              readonly turnId: TurnId;
              readonly toolAttemptId: ToolAttemptId;
              readonly modelAttemptId?: never;
              readonly commandId?: CommandId;
            }
          : TType extends TurnEventType
            ? {
                readonly requestId: RequestId;
                readonly turnId: TurnId;
                readonly modelAttemptId?: never;
                readonly toolAttemptId?: never;
                readonly commandId?: CommandId;
              }
            : TType extends typeof DurableEventType.INPUT_APPLIED
              ? {
                  readonly requestId: RequestId;
                  readonly turnId?: TurnId;
                  readonly modelAttemptId?: never;
                  readonly toolAttemptId?: never;
                  readonly commandId?: CommandId;
                }
              : TType extends Exclude<RequestEventType, typeof DurableEventType.REQUEST_ACCEPTED>
                ? {
                    readonly requestId: RequestId;
                    readonly modelAttemptId?: never;
                    readonly commandId?: CommandId;
                  }
                : TType extends SessionEventType
                  ? { readonly commandId?: CommandId; readonly modelAttemptId?: never }
                  : never;

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
