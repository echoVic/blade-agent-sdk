import { z } from 'zod';
import {
  CommandId,
  EventId,
  EventSequence,
  RequestId,
  SessionId,
  ToolAttemptId,
  TurnId,
} from '../../types/branded.js';
import type { JsonObject, JsonValue } from '../../types/common.js';
import {
  DURABLE_EVENT_SCHEMA_VERSION,
  type DurableEventDataMap,
  type DurableEventDraft,
  type DurableEventEnvelope,
  type DurableEventType,
  DurableEventType as DurableEventTypeValue,
} from './types.js';

export const DURABLE_EVENT_LOG_FORMAT = 'blade.durable-events' as const;

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);
const NonEmptyStringSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const EventSequenceSchema = PositiveIntegerSchema;
const TimestampSchema = z.string().datetime({ offset: true });
const DurableEventTypeSchema = z.enum(
  Object.values(DurableEventTypeValue) as [DurableEventType, ...DurableEventType[]],
);
const DurableEventErrorSchema = z
  .object({
    message: NonEmptyStringSchema,
    code: NonEmptyStringSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
const DurableTokenUsageSchema = z
  .object({
    inputTokens: NonNegativeIntegerSchema,
    outputTokens: NonNegativeIntegerSchema,
    totalTokens: NonNegativeIntegerSchema,
  })
  .strict();
const ToolIdentitySchema = {
  toolCallId: NonEmptyStringSchema,
  toolName: NonEmptyStringSchema,
};

const DurableEventDataSchemas = {
  [DurableEventTypeValue.SESSION_CREATED]: z
    .object({
      source: z.enum(['create', 'resume', 'fork']).optional(),
      parentSessionId: NonEmptyStringSchema.optional(),
    })
    .strict(),
  [DurableEventTypeValue.SESSION_CLOSED]: z
    .object({
      reason: z.enum(['completed', 'user', 'shutdown', 'error']),
    })
    .strict(),
  [DurableEventTypeValue.REQUEST_ACCEPTED]: z
    .object({
      inputId: NonEmptyStringSchema,
      input: JsonValueSchema,
      priority: z.enum(['now', 'next', 'later']),
      maxTurns: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
      model: NonEmptyStringSchema.optional(),
      context: JsonObjectSchema.optional(),
      recovery: z
        .object({
          requestId: NonEmptyStringSchema,
          turnId: NonEmptyStringSchema,
          turn: PositiveIntegerSchema,
        })
        .strict()
        .optional(),
    })
    .strict(),
  [DurableEventTypeValue.REQUEST_STARTED]: z.object({}).strict(),
  [DurableEventTypeValue.REQUEST_COMPLETED]: z
    .object({
      output: JsonValueSchema.optional(),
      usage: DurableTokenUsageSchema.optional(),
    })
    .strict(),
  [DurableEventTypeValue.REQUEST_FAILED]: z
    .object({
      error: DurableEventErrorSchema,
    })
    .strict(),
  [DurableEventTypeValue.REQUEST_INTERRUPTED]: z
    .object({
      reason: z.enum(['user_abort', 'session_close', 'steering', 'process_restart']),
      byInputId: NonEmptyStringSchema.optional(),
    })
    .strict(),
  [DurableEventTypeValue.TURN_STARTED]: z
    .object({
      turn: PositiveIntegerSchema,
      model: NonEmptyStringSchema.optional(),
    })
    .strict(),
  [DurableEventTypeValue.TURN_COMPLETED]: z
    .object({
      turn: PositiveIntegerSchema,
      hasToolCalls: z.boolean(),
    })
    .strict(),
  [DurableEventTypeValue.TURN_ABORTED]: z
    .object({
      turn: PositiveIntegerSchema,
      reason: z.enum(['request_interrupted', 'error', 'process_restart', 'recovery_required']),
    })
    .strict(),
  [DurableEventTypeValue.TOOL_SCHEDULED]: z
    .object({
      ...ToolIdentitySchema,
      input: JsonValueSchema,
      sideEffect: z.enum(['pure', 'idempotent', 'non_idempotent']),
      interruptBehavior: z.enum(['block', 'cancel']),
    })
    .strict(),
  [DurableEventTypeValue.TOOL_STARTED]: z
    .object({
      ...ToolIdentitySchema,
      input: JsonValueSchema,
      sideEffect: z.enum(['pure', 'idempotent', 'non_idempotent']),
    })
    .strict(),
  [DurableEventTypeValue.TOOL_COMPLETED]: z
    .object({
      ...ToolIdentitySchema,
      result: JsonValueSchema,
    })
    .strict(),
  [DurableEventTypeValue.TOOL_FAILED]: z
    .object({
      ...ToolIdentitySchema,
      error: DurableEventErrorSchema,
    })
    .strict(),
  [DurableEventTypeValue.TOOL_CANCELLED]: z
    .object({
      ...ToolIdentitySchema,
      reason: z.enum([
        'request_interrupted',
        'permission_denied',
        'permission_cancelled',
        'cascade_abort',
        'process_restart',
      ]),
    })
    .strict(),
  [DurableEventTypeValue.TOOL_OUTCOME_UNKNOWN]: z
    .object({
      ...ToolIdentitySchema,
      reason: z.enum(['process_restart', 'commit_outcome_unknown']),
    })
    .strict(),
  [DurableEventTypeValue.PERMISSION_REQUESTED]: z
    .object({
      permissionRequestId: NonEmptyStringSchema,
      ...ToolIdentitySchema,
      input: JsonValueSchema,
      message: z.string().optional(),
    })
    .strict(),
  [DurableEventTypeValue.PERMISSION_RESOLVED]: z
    .object({
      permissionRequestId: NonEmptyStringSchema,
      decision: z.enum(['allow', 'deny', 'cancel']),
      message: z.string().optional(),
    })
    .strict(),
  [DurableEventTypeValue.INPUT_APPLIED]: z
    .object({
      inputId: NonEmptyStringSchema,
      priority: z.enum(['now', 'next']),
    })
    .strict(),
} satisfies Record<DurableEventType, z.ZodTypeAny>;

const DurableEventDraftBaseSchema = z
  .object({
    type: DurableEventTypeSchema,
    data: JsonObjectSchema,
    occurredAt: TimestampSchema.optional(),
    commandId: NonEmptyStringSchema.optional(),
    requestId: NonEmptyStringSchema.optional(),
    turnId: NonEmptyStringSchema.optional(),
    toolAttemptId: NonEmptyStringSchema.optional(),
    causationEventId: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine(validateEventScope);

const DurableEventEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(DURABLE_EVENT_SCHEMA_VERSION),
    eventId: NonEmptyStringSchema,
    sequence: EventSequenceSchema,
    sessionId: NonEmptyStringSchema,
    type: DurableEventTypeSchema,
    data: JsonObjectSchema,
    recordedAt: TimestampSchema,
    occurredAt: TimestampSchema,
    commandId: NonEmptyStringSchema.optional(),
    requestId: NonEmptyStringSchema.optional(),
    turnId: NonEmptyStringSchema.optional(),
    toolAttemptId: NonEmptyStringSchema.optional(),
    causationEventId: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine(validateEventScope);

const PersistedDurableEventBatchSchema = z
  .object({
    format: z.literal(DURABLE_EVENT_LOG_FORMAT),
    schemaVersion: z.literal(DURABLE_EVENT_SCHEMA_VERSION),
    sessionId: NonEmptyStringSchema,
    firstSequence: EventSequenceSchema,
    lastSequence: EventSequenceSchema,
    events: z.array(z.unknown()).min(1),
  })
  .strict();

interface ParsedEventScope {
  type: DurableEventType;
  commandId?: string;
  requestId?: string;
  turnId?: string;
  toolAttemptId?: string;
}

export interface PersistedDurableEventBatch {
  readonly format: typeof DURABLE_EVENT_LOG_FORMAT;
  readonly schemaVersion: typeof DURABLE_EVENT_SCHEMA_VERSION;
  readonly sessionId: SessionId;
  readonly firstSequence: EventSequence;
  readonly lastSequence: EventSequence;
  readonly events: readonly DurableEventEnvelope[];
}

function validateEventScope(value: ParsedEventScope, context: z.RefinementCtx): void {
  const requireField = (field: keyof ParsedEventScope): void => {
    if (!value[field]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${value.type} requires ${field}`,
      });
    }
  };
  const forbidField = (field: keyof ParsedEventScope): void => {
    if (value[field] !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${value.type} does not allow ${field}`,
      });
    }
  };

  switch (value.type) {
    case DurableEventTypeValue.SESSION_CREATED:
    case DurableEventTypeValue.SESSION_CLOSED:
      forbidField('requestId');
      forbidField('turnId');
      forbidField('toolAttemptId');
      return;
    case DurableEventTypeValue.REQUEST_ACCEPTED:
      requireField('commandId');
      requireField('requestId');
      forbidField('turnId');
      forbidField('toolAttemptId');
      return;
    case DurableEventTypeValue.REQUEST_STARTED:
    case DurableEventTypeValue.REQUEST_COMPLETED:
    case DurableEventTypeValue.REQUEST_FAILED:
    case DurableEventTypeValue.REQUEST_INTERRUPTED:
      requireField('requestId');
      forbidField('turnId');
      forbidField('toolAttemptId');
      return;
    case DurableEventTypeValue.TURN_STARTED:
    case DurableEventTypeValue.TURN_COMPLETED:
    case DurableEventTypeValue.TURN_ABORTED:
      requireField('requestId');
      requireField('turnId');
      forbidField('toolAttemptId');
      return;
    case DurableEventTypeValue.TOOL_SCHEDULED:
    case DurableEventTypeValue.TOOL_STARTED:
    case DurableEventTypeValue.TOOL_COMPLETED:
    case DurableEventTypeValue.TOOL_FAILED:
    case DurableEventTypeValue.TOOL_CANCELLED:
    case DurableEventTypeValue.TOOL_OUTCOME_UNKNOWN:
    case DurableEventTypeValue.PERMISSION_REQUESTED:
    case DurableEventTypeValue.PERMISSION_RESOLVED:
      requireField('requestId');
      requireField('turnId');
      requireField('toolAttemptId');
      return;
    case DurableEventTypeValue.INPUT_APPLIED:
      requireField('requestId');
      forbidField('toolAttemptId');
      return;
  }
}

function parseEventData<TType extends DurableEventType>(
  type: TType,
  data: JsonObject,
): DurableEventDataMap[TType] {
  return DurableEventDataSchemas[type].parse(data) as DurableEventDataMap[TType];
}

function toDurableEventDraft(
  parsed: z.infer<typeof DurableEventDraftBaseSchema>,
): DurableEventDraft {
  return {
    type: parsed.type,
    data: parseEventData(parsed.type, parsed.data),
    ...(parsed.occurredAt ? { occurredAt: parsed.occurredAt } : {}),
    ...(parsed.commandId ? { commandId: CommandId(parsed.commandId) } : {}),
    ...(parsed.requestId ? { requestId: RequestId(parsed.requestId) } : {}),
    ...(parsed.turnId ? { turnId: TurnId(parsed.turnId) } : {}),
    ...(parsed.toolAttemptId ? { toolAttemptId: ToolAttemptId(parsed.toolAttemptId) } : {}),
    ...(parsed.causationEventId ? { causationEventId: EventId(parsed.causationEventId) } : {}),
  } as DurableEventDraft;
}

export function parseDurableEventDraft(value: unknown): DurableEventDraft {
  return toDurableEventDraft(DurableEventDraftBaseSchema.parse(value));
}

export function parseDurableEventEnvelope(value: unknown): DurableEventEnvelope {
  const parsed = DurableEventEnvelopeSchema.parse(value);
  const draft = toDurableEventDraft(parsed);
  return {
    ...draft,
    schemaVersion: parsed.schemaVersion,
    eventId: EventId(parsed.eventId),
    sequence: EventSequence(parsed.sequence),
    sessionId: SessionId(parsed.sessionId),
    recordedAt: parsed.recordedAt,
    occurredAt: parsed.occurredAt,
  } as DurableEventEnvelope;
}

export function parsePersistedDurableEventBatch(value: unknown): PersistedDurableEventBatch {
  const parsed = PersistedDurableEventBatchSchema.parse(value);
  return {
    format: parsed.format,
    schemaVersion: parsed.schemaVersion,
    sessionId: SessionId(parsed.sessionId),
    firstSequence: EventSequence(parsed.firstSequence),
    lastSequence: EventSequence(parsed.lastSequence),
    events: parsed.events.map(parseDurableEventEnvelope),
  };
}
