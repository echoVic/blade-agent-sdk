import { z } from 'zod';
import type { JsonValue } from '../types/common.js';
import {
  AGENT_PROTOCOL_VERSION,
  AgentCommandType,
  type AgentCommand,
  type AgentCommandResult,
  type AgentEventCursor,
  type AgentServerEvent,
} from './types.js';

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/);
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);
const jsonObjectSchema = z.record(jsonValueSchema);

const textInputSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  providerOptions: jsonObjectSchema.optional(),
}).strict();

const imageInputSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1),
  }).strict(),
}).strict();

const userInputSchema = z.union([
  z.string(),
  z.array(z.union([textInputSchema, imageInputSchema])),
]);

const commandBase = {
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  commandId: identifierSchema,
};

export const agentCommandSchema = z.discriminatedUnion('type', [
  z.object({
    ...commandBase,
    type: z.literal(AgentCommandType.INITIALIZE),
    data: z.object({
      client: z.object({
        name: identifierSchema,
        version: identifierSchema,
        title: z.string().min(1).max(256).optional(),
      }).strict(),
      capabilities: z.object({
        approvals: z.boolean().optional(),
        durableEvents: z.boolean().optional(),
        eventReplay: z.boolean().optional(),
      }).strict().optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...commandBase,
    type: z.literal(AgentCommandType.SESSION_CREATE),
    data: z.object({
      metadata: jsonObjectSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...commandBase,
    type: z.literal(AgentCommandType.SESSION_READ),
    data: z.object({ sessionId: identifierSchema }).strict(),
  }).strict(),
  z.object({
    ...commandBase,
    type: z.literal(AgentCommandType.SESSION_LIST),
    data: z.object({
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...commandBase,
    type: z.literal(AgentCommandType.SESSION_RESUME),
    data: z.object({ sessionId: identifierSchema }).strict(),
  }).strict(),
  z.object({
    ...commandBase,
    type: z.literal(AgentCommandType.SESSION_FORK),
    data: z.object({
      sessionId: identifierSchema,
      messageId: identifierSchema.optional(),
      metadata: jsonObjectSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...commandBase,
    type: z.literal(AgentCommandType.SESSION_CLOSE),
    data: z.object({ sessionId: identifierSchema }).strict(),
  }).strict(),
  z.object({
    ...commandBase,
    type: z.literal(AgentCommandType.INPUT_SUBMIT),
    data: z.object({
      sessionId: identifierSchema,
      input: userInputSchema,
      priority: z.enum(['now', 'next', 'later']).optional(),
      expectedRequestId: identifierSchema.optional(),
      maxTurns: z.number().int().positive().optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...commandBase,
    type: z.literal(AgentCommandType.REQUEST_ABORT),
    data: z.object({ sessionId: identifierSchema }).strict(),
  }).strict(),
  z.object({
    ...commandBase,
    type: z.literal(AgentCommandType.PERMISSION_RESOLVE),
    data: z.object({
      sessionId: identifierSchema,
      permissionRequestId: identifierSchema,
      approved: z.boolean(),
      reason: z.string().max(4096).optional(),
      scope: z.enum(['once', 'session']).optional(),
    }).strict(),
  }).strict(),
]);

export const agentCommandResultSchema = z.discriminatedUnion('ok', [
  z.object({
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    commandId: identifierSchema,
    ok: z.literal(true),
    data: jsonObjectSchema,
  }).strict(),
  z.object({
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    commandId: identifierSchema,
    ok: z.literal(false),
    error: z.object({
      code: z.enum([
        'PROTOCOL_VERSION_UNSUPPORTED',
        'INVALID_COMMAND',
        'UNAUTHENTICATED',
        'FORBIDDEN',
        'SESSION_NOT_FOUND',
        'SESSION_CONFLICT',
        'COMMAND_CONFLICT',
        'COMMAND_IN_PROGRESS',
        'RATE_LIMITED',
        'OVERLOADED',
        'STALE_CURSOR',
        'PERMISSION_NOT_FOUND',
        'INTERNAL_ERROR',
      ]),
      message: z.string(),
      retryable: z.boolean(),
      retryAfterMs: z.number().int().nonnegative().optional(),
      details: jsonObjectSchema.optional(),
    }).strict(),
  }).strict(),
]);

export const agentEventCursorSchema = z.object({
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  sessionId: identifierSchema,
  sequence: z.number().int().positive(),
  eventId: identifierSchema,
}).strict();

export const agentServerEventSchema = z.object({
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  eventId: identifierSchema,
  sequence: z.number().int().positive(),
  sessionId: identifierSchema,
  requestId: identifierSchema.optional(),
  occurredAt: z.string().datetime({ offset: true }),
  type: z.enum(['session.stream', 'permission.requested', 'session.closed']),
  data: jsonObjectSchema,
}).strict();

export function parseAgentCommand(value: unknown): AgentCommand {
  return agentCommandSchema.parse(value) as AgentCommand;
}

export function parseAgentCommandResult(value: unknown): AgentCommandResult {
  return agentCommandResultSchema.parse(value) as AgentCommandResult;
}

export function parseAgentEventCursor(value: unknown): AgentEventCursor {
  return agentEventCursorSchema.parse(value) as AgentEventCursor;
}

export function parseAgentServerEvent(value: unknown): AgentServerEvent {
  return agentServerEventSchema.parse(value) as unknown as AgentServerEvent;
}
