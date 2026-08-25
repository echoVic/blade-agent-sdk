import { z } from 'zod';
import type { JsonValue } from '../../types/common.js';
import type { SessionEvent } from '../types.js';

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

const NonEmptyStringSchema = z.string().min(1);
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
  sessionId: NonEmptyStringSchema,
  rootId: NonEmptyStringSchema,
  parentId: z.string().optional(),
  relationType: z.literal('subagent').optional(),
  title: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed']).optional(),
  agentType: z.string().optional(),
  model: z.string().optional(),
  permission: JsonValueSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

const SessionEventBase = {
  id: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  timestamp: TimestampSchema,
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: NonEmptyStringSchema,
};

const SessionEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...SessionEventBase,
    type: z.literal('session_created'),
    data: z.object(SessionInfoFields).passthrough(),
  }).passthrough(),
  z.object({
    ...SessionEventBase,
    type: z.literal('session_updated'),
    data: z.object({
      sessionId: NonEmptyStringSchema.optional(),
      rootId: NonEmptyStringSchema.optional(),
      parentId: z.string().optional(),
      relationType: z.literal('subagent').optional(),
      title: z.string().optional(),
      status: z.enum(['running', 'completed', 'failed']).optional(),
      agentType: z.string().optional(),
      model: z.string().optional(),
      permission: JsonValueSchema.optional(),
      createdAt: TimestampSchema.optional(),
      updatedAt: TimestampSchema.optional(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    ...SessionEventBase,
    type: z.literal('message_created'),
    data: z.object({
      messageId: NonEmptyStringSchema,
      role: MessageRoleSchema,
      parentMessageId: z.string().optional(),
      createdAt: TimestampSchema,
      model: z.string().optional(),
      modelIdentity: z.object({
        provider: NonEmptyStringSchema,
        api: NonEmptyStringSchema,
        model: NonEmptyStringSchema,
      }).strict().optional(),
      usage: z.object({
        input_tokens: z.number().finite().nonnegative(),
        output_tokens: z.number().finite().nonnegative(),
      }).passthrough().optional(),
      customMetadata: z.record(z.string(), JsonValueSchema).optional(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    ...SessionEventBase,
    type: z.literal('part_created'),
    data: z.object({
      partId: NonEmptyStringSchema,
      messageId: NonEmptyStringSchema,
      partType: PartTypeSchema,
      payload: JsonValueSchema,
      createdAt: TimestampSchema,
    }).passthrough(),
  }).passthrough(),
  z.object({
    ...SessionEventBase,
    type: z.literal('part_updated'),
    data: z.object({
      partId: NonEmptyStringSchema,
      messageId: NonEmptyStringSchema,
      partType: PartTypeSchema,
      payload: JsonValueSchema,
      createdAt: TimestampSchema,
    }).passthrough(),
  }).passthrough(),
  z.object({
    ...SessionEventBase,
    type: z.literal('input_enqueued'),
    data: z.object({
      inputId: NonEmptyStringSchema,
      content: JsonValueSchema,
      priority: InputPrioritySchema,
      targetRequestId: NonEmptyStringSchema.optional(),
      acceptedAt: z.number().finite().nonnegative(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    ...SessionEventBase,
    type: z.literal('input_applied'),
    data: z.object({
      inputId: NonEmptyStringSchema,
      requestId: NonEmptyStringSchema,
      messageId: NonEmptyStringSchema,
      appliedAt: z.number().finite().nonnegative(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    ...SessionEventBase,
    type: z.literal('input_cancelled'),
    data: z.object({
      inputId: NonEmptyStringSchema,
      reason: z.string(),
      cancelledAt: z.number().finite().nonnegative(),
    }).passthrough(),
  }).passthrough(),
]);

export function parseSessionEvent(value: unknown): SessionEvent {
  const event = SessionEventSchema.parse(value);
  if (
    event.type === 'session_created'
    && event.data.sessionId !== event.sessionId
  ) {
    throw new Error(
      `Session creation payload ${event.data.sessionId} does not match envelope ${event.sessionId}`,
    );
  }
  return event as unknown as SessionEvent;
}
