import { z } from 'zod';
import type { TranscriptEvent } from '../../session/transcript.js';
import {
  EventId,
  InputId,
  MessageId,
  PartId,
  RequestId,
  SessionId,
} from '../../types/identifiers.js';
import { jsonValueSchema as JsonValueSchema } from '../../types/jsonSchema.js';

const NonEmptyStringSchema = z.string().min(1);
const EventIdSchema = NonEmptyStringSchema.transform(EventId);
const InputIdSchema = NonEmptyStringSchema.transform(InputId);
const MessageIdSchema = NonEmptyStringSchema.transform(MessageId);
const PartIdSchema = NonEmptyStringSchema.transform(PartId);
const RequestIdSchema = NonEmptyStringSchema.transform(RequestId);
const SessionIdSchema = NonEmptyStringSchema.transform(SessionId);
const TimestampSchema = NonEmptyStringSchema;
const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
const PartTypeSchema = z.enum([
  'text',
  'reasoning',
  'image',
  'tool_call',
  'tool_result',
  'diff',
  'patch',
  'summary',
  'subtask_ref',
]);
const InputPrioritySchema = z.enum(['now', 'next', 'later']);

const SessionInfoFields = {
  sessionId: SessionIdSchema,
  rootId: SessionIdSchema,
  parentId: SessionIdSchema.optional(),
  relationType: z.literal('subagent').optional(),
  title: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed']).optional(),
  agentType: z.string().optional(),
  model: z.string().optional(),
  permission: JsonValueSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

const TranscriptEventBase = {
  id: EventIdSchema,
  sessionId: SessionIdSchema,
  timestamp: TimestampSchema,
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: NonEmptyStringSchema,
};

const SessionEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...TranscriptEventBase,
      type: z.literal('session_created'),
      data: z.object(SessionInfoFields).passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...TranscriptEventBase,
      type: z.literal('session_updated'),
      data: z
        .object({
          sessionId: SessionIdSchema.optional(),
          rootId: SessionIdSchema.optional(),
          parentId: SessionIdSchema.optional(),
          relationType: z.literal('subagent').optional(),
          title: z.string().optional(),
          status: z.enum(['running', 'completed', 'failed']).optional(),
          agentType: z.string().optional(),
          model: z.string().optional(),
          permission: JsonValueSchema.optional(),
          createdAt: TimestampSchema.optional(),
          updatedAt: TimestampSchema.optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...TranscriptEventBase,
      type: z.literal('message_created'),
      data: z
        .object({
          messageId: MessageIdSchema,
          role: MessageRoleSchema,
          parentMessageId: MessageIdSchema.optional(),
          createdAt: TimestampSchema,
          model: z.string().optional(),
          modelIdentity: z
            .object({
              provider: NonEmptyStringSchema,
              api: NonEmptyStringSchema,
              model: NonEmptyStringSchema,
            })
            .strict()
            .optional(),
          usage: z
            .object({
              input_tokens: z.number().finite().nonnegative(),
              output_tokens: z.number().finite().nonnegative(),
            })
            .passthrough()
            .optional(),
          providerOptions: z.record(z.string(), JsonValueSchema).optional(),
          provenance: z
            .object({
              source: z.enum(['catalog', 'tool_injection', 'compaction_summary']),
            })
            .strict()
            .optional(),
          correlation: z
            .object({
              inputId: InputIdSchema,
              requestId: RequestIdSchema,
            })
            .strict()
            .optional(),
          extensions: z.record(z.string(), JsonValueSchema).optional(),
          customMetadata: z.record(z.string(), JsonValueSchema).optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...TranscriptEventBase,
      type: z.literal('part_created'),
      data: z
        .object({
          partId: PartIdSchema,
          messageId: MessageIdSchema,
          partType: PartTypeSchema,
          payload: JsonValueSchema,
          createdAt: TimestampSchema,
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...TranscriptEventBase,
      type: z.literal('part_updated'),
      data: z
        .object({
          partId: PartIdSchema,
          messageId: MessageIdSchema,
          partType: PartTypeSchema,
          payload: JsonValueSchema,
          createdAt: TimestampSchema,
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...TranscriptEventBase,
      type: z.literal('input_enqueued'),
      data: z
        .object({
          inputId: InputIdSchema,
          content: JsonValueSchema,
          priority: InputPrioritySchema,
          targetRequestId: RequestIdSchema.optional(),
          acceptedAt: z.number().finite().nonnegative(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...TranscriptEventBase,
      type: z.literal('input_applied'),
      data: z
        .object({
          inputId: InputIdSchema,
          requestId: RequestIdSchema,
          messageId: MessageIdSchema,
          appliedAt: z.number().finite().nonnegative(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...TranscriptEventBase,
      type: z.literal('input_cancelled'),
      data: z
        .object({
          inputId: InputIdSchema,
          reason: z.string(),
          cancelledAt: z.number().finite().nonnegative(),
        })
        .passthrough(),
    })
    .passthrough(),
]);

export function parseSessionEvent(value: unknown): TranscriptEvent {
  const event = SessionEventSchema.parse(value);
  if (event.type === 'session_created' && event.data.sessionId !== event.sessionId) {
    throw new Error(
      `Session creation payload ${event.data.sessionId} does not match envelope ${event.sessionId}`,
    );
  }
  return event;
}
