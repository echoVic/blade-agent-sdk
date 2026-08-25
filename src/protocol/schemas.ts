import { z } from 'zod';
import { sessionStreamEventSchema } from '../session/streamSchema.js';
import {
  CommandId,
  EventId,
  EventSequence,
  InputId,
  MessageId,
  PermissionRequestId,
  RequestId,
  SessionId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import { jsonObjectSchema } from '../types/jsonSchema.js';
import {
  AGENT_PROTOCOL_VERSION,
  type AgentCommand,
  type AgentCommandResult,
  AgentCommandType,
  type AgentEventCursor,
  type AgentInitializationData,
  type AgentInputSubmissionData,
  type AgentPermissionRequest,
  type AgentServerEvent,
  type AgentSessionDescriptor,
} from './types.js';

const identifierSchema = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/);
const commandIdSchema = identifierSchema.transform(CommandId);
const eventIdSchema = identifierSchema.transform(EventId);
const eventSequenceSchema = z.number().int().positive().transform(EventSequence);
const inputIdSchema = identifierSchema.transform(InputId);
const messageIdSchema = identifierSchema.transform(MessageId);
const permissionRequestIdSchema = identifierSchema.transform(PermissionRequestId);
const requestIdSchema = identifierSchema.transform(RequestId);
const sessionIdSchema = identifierSchema.transform(SessionId);
const textInputSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    providerOptions: jsonObjectSchema.optional(),
  })
  .strict();

const imageInputSchema = z
  .object({
    type: z.literal('image_url'),
    image_url: z
      .object({
        url: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const userInputSchema = z.union([
  z.string(),
  z.array(z.union([textInputSchema, imageInputSchema])),
]);

const commandBase = {
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  commandId: commandIdSchema,
};

const agentCommandSchemaImpl = z.discriminatedUnion('type', [
  z
    .object({
      ...commandBase,
      type: z.literal(AgentCommandType.INITIALIZE),
      data: z
        .object({
          client: z
            .object({
              name: identifierSchema,
              version: identifierSchema,
              title: z.string().min(1).max(256).optional(),
            })
            .strict(),
          capabilities: z
            .object({
              approvals: z.boolean().optional(),
              durableEvents: z.boolean().optional(),
              eventReplay: z.boolean().optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal(AgentCommandType.SESSION_CREATE),
      data: z
        .object({
          metadata: jsonObjectSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal(AgentCommandType.SESSION_READ),
      data: z.object({ sessionId: sessionIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal(AgentCommandType.SESSION_LIST),
      data: z
        .object({
          cursor: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal(AgentCommandType.SESSION_RESUME),
      data: z.object({ sessionId: sessionIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal(AgentCommandType.SESSION_FORK),
      data: z
        .object({
          sessionId: sessionIdSchema,
          messageId: messageIdSchema.optional(),
          metadata: jsonObjectSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal(AgentCommandType.SESSION_CLOSE),
      data: z.object({ sessionId: sessionIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal(AgentCommandType.INPUT_SUBMIT),
      data: z
        .object({
          sessionId: sessionIdSchema,
          input: userInputSchema,
          priority: z.enum(['now', 'next', 'later']).optional(),
          expectedRequestId: requestIdSchema.optional(),
          maxTurns: z.number().int().positive().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal(AgentCommandType.REQUEST_ABORT),
      data: z.object({ sessionId: sessionIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal(AgentCommandType.PERMISSION_RESOLVE),
      data: z
        .object({
          sessionId: sessionIdSchema,
          permissionRequestId: permissionRequestIdSchema,
          approved: z.boolean(),
          reason: z.string().max(4096).optional(),
          scope: z.enum(['once', 'session']).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const agentCommandSchema = agentCommandSchemaImpl as z.ZodType<
  AgentCommand,
  z.ZodTypeDef,
  unknown
>;

const agentCommandResultSchemaImpl = z.discriminatedUnion('ok', [
  z
    .object({
      protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
      commandId: commandIdSchema,
      ok: z.literal(true),
      data: jsonObjectSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
      commandId: commandIdSchema,
      ok: z.literal(false),
      error: z
        .object({
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
        })
        .strict(),
    })
    .strict(),
]);

export const agentCommandResultSchema = agentCommandResultSchemaImpl as z.ZodType<
  AgentCommandResult<JsonObject>,
  z.ZodTypeDef,
  unknown
>;

const agentSessionDescriptorSchemaImpl = z
  .object({
    sessionId: sessionIdSchema,
    status: z.enum(['active', 'closed']),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();

export const agentSessionDescriptorSchema = agentSessionDescriptorSchemaImpl as z.ZodType<
  AgentSessionDescriptor,
  z.ZodTypeDef,
  unknown
>;

export const agentInitializationDataSchema: z.ZodType<AgentInitializationData> = z
  .object({
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    commands: z.array(z.nativeEnum(AgentCommandType)),
    transports: z.tuple([z.literal('http-sse')]),
    serverTime: z.string().datetime({ offset: true }),
    features: z
      .object({
        approvals: z.literal(true),
        durableEvents: z.literal(true),
        eventReplay: z.literal(true),
        idempotentCommands: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const agentSessionResultSchema = z
  .object({
    session: agentSessionDescriptorSchema,
  })
  .strict();

export const agentSessionListDataSchema = z
  .object({
    sessions: z.array(agentSessionDescriptorSchema),
    nextCursor: z.string().optional(),
  })
  .strict();

const agentInputSubmissionDataSchemaImpl = z
  .object({
    sessionId: sessionIdSchema,
    inputId: inputIdSchema,
    requestId: requestIdSchema.optional(),
    status: z.enum(['started', 'steered', 'queued']),
    priority: z.enum(['now', 'next', 'later']).optional(),
  })
  .strict();

export const agentInputSubmissionDataSchema = agentInputSubmissionDataSchemaImpl as z.ZodType<
  AgentInputSubmissionData,
  z.ZodTypeDef,
  unknown
>;

const agentEventCursorSchemaImpl = z
  .object({
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    sessionId: sessionIdSchema,
    sequence: eventSequenceSchema,
    eventId: eventIdSchema,
  })
  .strict();

export const agentEventCursorSchema = agentEventCursorSchemaImpl as z.ZodType<
  AgentEventCursor,
  z.ZodTypeDef,
  unknown
>;

const agentServerEventBase = {
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  eventId: eventIdSchema,
  sequence: eventSequenceSchema,
  sessionId: sessionIdSchema,
  requestId: requestIdSchema.optional(),
  occurredAt: z.string().datetime({ offset: true }),
};

export const agentPermissionRequestSchema: z.ZodType<
  AgentPermissionRequest,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    permissionRequestId: permissionRequestIdSchema,
    toolName: z.string(),
    input: jsonObjectSchema,
    title: z.string(),
    message: z.string(),
    kind: z.string().optional(),
    affectedPaths: z.array(z.string()),
    risks: z.array(z.string()),
  })
  .strict() as z.ZodType<AgentPermissionRequest, z.ZodTypeDef, unknown>;

const agentServerEventSchemaImpl = z
  .discriminatedUnion('type', [
    z
      .object({
        ...agentServerEventBase,
        type: z.literal('session.stream'),
        data: sessionStreamEventSchema,
      })
      .strict(),
    z
      .object({
        ...agentServerEventBase,
        type: z.literal('permission.requested'),
        data: agentPermissionRequestSchema,
      })
      .strict(),
    z
      .object({
        ...agentServerEventBase,
        type: z.literal('session.closed'),
        data: jsonObjectSchema,
      })
      .strict(),
  ])
  .superRefine((event, context) => {
    if (event.type === 'session.stream' && event.data.sessionId !== event.sessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['data', 'sessionId'],
        message: 'Stream event Session does not match the server event envelope',
      });
    }
  });

export const agentServerEventSchema = agentServerEventSchemaImpl as z.ZodType<
  AgentServerEvent,
  z.ZodTypeDef,
  unknown
>;

export function parseAgentCommand(value: unknown): AgentCommand {
  return agentCommandSchema.parse(value);
}

export function parseAgentCommandResult(value: unknown): AgentCommandResult<JsonObject> {
  return agentCommandResultSchema.parse(value);
}

export function parseAgentEventCursor(value: unknown): AgentEventCursor {
  return agentEventCursorSchema.parse(value);
}

export function parseAgentServerEvent(value: unknown): AgentServerEvent {
  return agentServerEventSchema.parse(value);
}
