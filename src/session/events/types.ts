import type {
  CommandId,
  EventId,
  EventSequence,
  RequestId,
  SessionId,
  ToolAttemptId,
  TurnId,
} from '../../types/branded.js';
import type { JsonObject } from '../../types/common.js';

export const DURABLE_EVENT_SCHEMA_VERSION = 1 as const;

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

export interface DurableEventEnvelope<
  TType extends DurableEventType = DurableEventType,
  TData extends JsonObject = JsonObject,
> {
  readonly schemaVersion: typeof DURABLE_EVENT_SCHEMA_VERSION;
  readonly eventId: EventId;
  readonly sequence: EventSequence;
  readonly sessionId: SessionId;
  readonly type: TType;
  readonly data: TData;
  readonly recordedAt: string;
  readonly occurredAt: string;
  readonly commandId?: CommandId;
  readonly requestId?: RequestId;
  readonly turnId?: TurnId;
  readonly toolAttemptId?: ToolAttemptId;
  readonly causationEventId?: EventId;
}

export type DurableEventDraft<
  TType extends DurableEventType = DurableEventType,
  TData extends JsonObject = JsonObject,
> = Pick<DurableEventEnvelope<TType, TData>, 'type' | 'data'> &
  Partial<
    Pick<
      DurableEventEnvelope<TType, TData>,
      'occurredAt' | 'commandId' | 'requestId' | 'turnId' | 'toolAttemptId' | 'causationEventId'
    >
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
   * - null: require an empty stream
   * - EventSequence: require an exact current head
   */
  expectedLastSequence?: EventSequence | null;
}

export interface DurableEventAppendResult {
  readonly events: readonly DurableEventEnvelope[];
  readonly previousSequence: EventSequence | null;
  readonly lastSequence: EventSequence;
}
