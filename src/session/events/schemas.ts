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
  type DurableEventDraft,
  type DurableEventEnvelope,
  DurableEventType,
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
const EventSequenceSchema = z.number().int().positive();
const TimestampSchema = z.string().datetime({ offset: true });
const DurableEventTypeSchema = z.enum(
  Object.values(DurableEventType) as [DurableEventType, ...DurableEventType[]],
);

const DurableEventDraftSchema = z
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
  .strict();

const DurableEventEnvelopeSchema = DurableEventDraftSchema.extend({
  schemaVersion: z.literal(DURABLE_EVENT_SCHEMA_VERSION),
  eventId: NonEmptyStringSchema,
  sequence: EventSequenceSchema,
  sessionId: NonEmptyStringSchema,
  recordedAt: TimestampSchema,
  occurredAt: TimestampSchema,
}).strict();

const PersistedDurableEventBatchSchema = z
  .object({
    format: z.literal(DURABLE_EVENT_LOG_FORMAT),
    schemaVersion: z.literal(DURABLE_EVENT_SCHEMA_VERSION),
    sessionId: NonEmptyStringSchema,
    firstSequence: EventSequenceSchema,
    lastSequence: EventSequenceSchema,
    events: z.array(DurableEventEnvelopeSchema).min(1),
  })
  .strict();

type ParsedDurableEventDraft = z.infer<typeof DurableEventDraftSchema>;

export interface PersistedDurableEventBatch {
  readonly format: typeof DURABLE_EVENT_LOG_FORMAT;
  readonly schemaVersion: typeof DURABLE_EVENT_SCHEMA_VERSION;
  readonly sessionId: SessionId;
  readonly firstSequence: EventSequence;
  readonly lastSequence: EventSequence;
  readonly events: readonly DurableEventEnvelope[];
}

function toDurableEventDraft(parsed: ParsedDurableEventDraft): DurableEventDraft {
  return {
    type: parsed.type,
    data: parsed.data,
    ...(parsed.occurredAt ? { occurredAt: parsed.occurredAt } : {}),
    ...(parsed.commandId ? { commandId: CommandId(parsed.commandId) } : {}),
    ...(parsed.requestId ? { requestId: RequestId(parsed.requestId) } : {}),
    ...(parsed.turnId ? { turnId: TurnId(parsed.turnId) } : {}),
    ...(parsed.toolAttemptId ? { toolAttemptId: ToolAttemptId(parsed.toolAttemptId) } : {}),
    ...(parsed.causationEventId ? { causationEventId: EventId(parsed.causationEventId) } : {}),
  };
}

export function parseDurableEventDraft(value: unknown): DurableEventDraft {
  return toDurableEventDraft(DurableEventDraftSchema.parse(value));
}

export function parseDurableEventEnvelope(value: unknown): DurableEventEnvelope {
  const parsed = DurableEventEnvelopeSchema.parse(value);
  return {
    ...toDurableEventDraft(parsed),
    schemaVersion: parsed.schemaVersion,
    eventId: EventId(parsed.eventId),
    sequence: EventSequence(parsed.sequence),
    sessionId: SessionId(parsed.sessionId),
    recordedAt: parsed.recordedAt,
    occurredAt: parsed.occurredAt,
  };
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
