import { z } from 'zod';
import { InputId, RequestId, SessionId, ToolUseId } from '../types/identifiers.js';
import { jsonObjectSchema, jsonValueSchema } from '../types/jsonSchema.js';
import type { SessionStreamEvent } from './types.js';

const identifierSchema = z.string().min(1);
const inputIdSchema = identifierSchema.transform(InputId);
const requestIdSchema = identifierSchema.transform(RequestId);
const sessionIdSchema = identifierSchema.transform(SessionId);
const toolUseIdSchema = identifierSchema.transform(ToolUseId);

const modelToolCallSchema = z
  .object({
    id: identifierSchema,
    type: z.literal('function'),
    function: z
      .object({
        name: z.string(),
        arguments: z.string(),
      })
      .strict(),
  })
  .strict();

const modelContentSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      text: z.string(),
      providerOptions: jsonObjectSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('image_url'),
      image_url: z.object({ url: z.string() }).strict(),
    })
    .strict(),
]);

const modelMessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(modelContentSchema)]),
    reasoningContent: z.string().optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
    tool_calls: z.array(modelToolCallSchema).optional(),
    metadata: jsonValueSchema.optional(),
    modelIdentity: z
      .object({
        provider: z.string(),
        api: z.string(),
        model: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

const toolDisplayContentSchema = z
  .object({
    summary: z.string(),
    detail: jsonValueSchema.optional(),
  })
  .strict();

const toolProgressSchema = z
  .object({
    kind: z.literal('progress'),
    message: z.string().optional(),
    data: jsonValueSchema.optional(),
    completed: z.number().optional(),
    total: z.number().optional(),
    resumeToken: z.string().optional(),
  })
  .strict();

const runtimeContextSchema = z
  .object({
    id: z.string().optional(),
    capabilities: z
      .object({
        filesystem: z
          .object({
            roots: z.array(z.string()),
            cwd: z.string().optional(),
          })
          .strict()
          .optional(),
        browser: z
          .object({
            pageId: z.string().optional(),
            tabId: z.string().optional(),
          })
          .strict()
          .optional(),
        network: z
          .object({
            allowDomains: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    environment: z.record(z.string()).optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();

const runtimePatchScopeSchema = z.enum(['turn', 'session']);
const runtimePatchSchema = z
  .object({
    scope: runtimePatchScopeSchema,
    source: z.enum(['skill', 'tool', 'system']),
    skill: z
      .object({
        id: z.string(),
        name: z.string(),
        basePath: z.string(),
      })
      .strict()
      .optional(),
    toolPolicy: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    toolDiscovery: z
      .object({
        discover: z.array(z.string()).optional(),
        reset: z.boolean().optional(),
      })
      .strict()
      .optional(),
    modelOverride: z
      .object({
        modelId: z.string(),
        effort: z.union([z.string(), z.number()]).optional(),
      })
      .strict()
      .optional(),
    systemPromptAppend: z.string().optional(),
    environment: z.record(z.string()).optional(),
    hooks: z
      .array(
        z
          .object({
            event: z.enum([
              'PreToolUse',
              'PostToolUse',
              'PostToolUseFailure',
              'PermissionRequest',
              'UserPromptSubmit',
              'SessionStart',
              'SessionEnd',
              'TaskCompleted',
            ]),
            type: z.string(),
            value: z.string().optional(),
            tools: z.array(z.string()).optional(),
            once: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const runtimeContextPatchSchema = z
  .object({
    scope: runtimePatchScopeSchema,
    context: runtimeContextSchema.optional(),
    reset: z.boolean().optional(),
  })
  .strict();

const permissionUpdateSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('addRules'),
      rules: z.array(
        z
          .object({
            toolName: z.string(),
            ruleContent: z.string().optional(),
          })
          .strict(),
      ),
      behavior: z.enum(['allow', 'deny']),
    })
    .strict(),
  z
    .object({
      type: z.literal('removeRules'),
      rules: z.array(
        z
          .object({
            toolName: z.string(),
            ruleContent: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
]);

const tokenUsageSchema = z
  .object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    maxContextTokens: z.number().nonnegative(),
    cacheReadInputTokens: z.number().nonnegative().optional(),
    cacheMissInputTokens: z.number().nonnegative().optional(),
    billableInputTokens: z.number().nonnegative().optional(),
    reasoningTokens: z.number().nonnegative().optional(),
  })
  .strict();

const eventBase = {
  sessionId: sessionIdSchema,
};
const toolEventBase = {
  ...eventBase,
  id: toolUseIdSchema,
  name: z.string(),
};

const sessionStreamEventSchemaImpl = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('turn_start'), turn: z.number().int() }).strict(),
  z.object({ ...eventBase, type: z.literal('turn_end'), turn: z.number().int() }).strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('turn_interrupted'),
      inputId: inputIdSchema,
      requestId: requestIdSchema,
      turn: z.number().int(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('input_applied'),
      inputId: inputIdSchema,
      requestId: requestIdSchema,
      priority: z.enum(['now', 'next']),
      turn: z.number().int(),
    })
    .strict(),
  z.object({ ...eventBase, type: z.literal('content'), delta: z.string() }).strict(),
  z.object({ ...eventBase, type: z.literal('thinking'), delta: z.string() }).strict(),
  z
    .object({
      ...toolEventBase,
      type: z.literal('tool_use'),
      input: jsonValueSchema,
    })
    .strict(),
  z
    .object({
      ...toolEventBase,
      type: z.literal('tool_progress'),
      progress: toolProgressSchema,
    })
    .strict(),
  z
    .object({
      ...toolEventBase,
      type: z.literal('tool_message'),
      content: toolDisplayContentSchema,
    })
    .strict(),
  z
    .object({
      ...toolEventBase,
      type: z.literal('tool_runtime_patch'),
      patch: runtimePatchSchema,
    })
    .strict(),
  z
    .object({
      ...toolEventBase,
      type: z.literal('tool_context_patch'),
      patch: runtimeContextPatchSchema,
    })
    .strict(),
  z
    .object({
      ...toolEventBase,
      type: z.literal('tool_new_messages'),
      messages: z.array(modelMessageSchema),
    })
    .strict(),
  z
    .object({
      ...toolEventBase,
      type: z.literal('tool_permission_updates'),
      updates: z.array(permissionUpdateSchema),
    })
    .strict(),
  z
    .object({
      ...toolEventBase,
      type: z.literal('tool_result'),
      output: jsonValueSchema,
      display: toolDisplayContentSchema.optional(),
      isError: z.boolean().optional(),
    })
    .strict(),
  z.object({ ...eventBase, type: z.literal('usage'), usage: tokenUsageSchema }).strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('result'),
      subtype: z.enum(['success', 'error']),
      content: z.string().optional(),
      error: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('error'),
      message: z.string(),
      code: z.string().optional(),
    })
    .strict(),
]);

export const sessionStreamEventSchema = sessionStreamEventSchemaImpl as z.ZodType<
  SessionStreamEvent,
  z.ZodTypeDef,
  unknown
>;

export function parseSessionStreamEvent(value: unknown): SessionStreamEvent {
  return sessionStreamEventSchema.parse(value);
}
