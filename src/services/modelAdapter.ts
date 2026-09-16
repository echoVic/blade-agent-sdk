import { jsonSchema, Output } from 'ai';
import type { InternalLogger } from '../logging/Logger.js';
import type { ModelServiceConfig, OutputFormat } from '../model/config.js';
import { resolveModelIdentity } from '../model/identity.js';
import type { ModelContent, ModelMessage, ModelToolCall } from '../model/message.js';
import type { ModelResponse, ModelToolDefinition } from '../model/service.js';
import type { ModelUsage } from '../model/usage.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import {
  buildDeepSeekProviderOptions,
  mergeDeepSeekUsage,
  optimizeDeepSeekCachePrefix,
  prepareDeepSeekTools,
  shouldOmitDeepSeekSamplingOptions,
} from './deepseek.js';

type AIProviderOptions = Record<string, JsonObject>;

type AIMessage =
  | { role: 'system'; content: string; providerOptions?: AIProviderOptions }
  | {
      role: 'user';
      content:
        | string
        | Array<
            | { type: 'text'; text: string; providerOptions?: AIProviderOptions }
            | { type: 'image'; image: string; mediaType?: string }
          >;
    }
  | {
      role: 'assistant';
      content:
        | string
        | Array<
            | { type: 'reasoning'; text: string }
            | { type: 'text'; text: string }
            | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
          >;
    }
  | {
      role: 'tool';
      content: Array<{
        type: 'tool-result';
        toolCallId: string;
        toolName: string;
        output: { type: 'text'; value: string };
      }>;
    };

type AITool = { description?: string; inputSchema: unknown; strict?: boolean };

export interface RawToolCall {
  toolCallId?: string;
  tool_call_id?: string;
  id?: string;
  toolName?: string;
  tool_name?: string;
  name?: string;
  args?: unknown;
  input?: unknown;
  arguments?: unknown;
  function?: { name?: string; arguments?: unknown };
}

export interface RawModelResult {
  text: string;
  toolCalls?: RawToolCall[];
  tool_calls?: RawToolCall[];
  message?: { toolCalls?: RawToolCall[]; tool_calls?: RawToolCall[] };
  choices?: Array<{ message?: { toolCalls?: RawToolCall[]; tool_calls?: RawToolCall[] } }>;
  steps?: Array<{ toolCalls?: RawToolCall[]; tool_calls?: RawToolCall[] }>;
  reasoning?: Array<{ text: string }>;
  reasoningText?: string;
  usage?: RawUsage;
  providerMetadata?: RawProviderMetadata;
}

interface RawUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: { textTokens?: number; reasoningTokens?: number };
  reasoningTokens?: number;
  cachedInputTokens?: number;
  billableInputTokens?: number;
  cacheMissInputTokens?: number;
}

interface RawProviderMetadata {
  anthropic?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
  deepseek?: { promptCacheHitTokens?: number; promptCacheMissTokens?: number };
}

export interface PreparedModelRequest {
  coreMessages: AIMessage[];
  coreTools?: Record<string, AITool>;
  experimentalOutput?: ReturnType<typeof Output.object>;
}

export function prepareModelRequest(
  config: ModelServiceConfig,
  logger: InternalLogger,
  messages: readonly ModelMessage[],
  tools?: readonly ModelToolDefinition[],
): PreparedModelRequest {
  const deepseek = config.provider === 'deepseek';
  const optimized = deepseek
    ? optimizeDeepSeekCachePrefix(messages, config.providerOptions?.deepseek?.cacheOptimization)
    : messages;
  return {
    coreMessages: convertMessages(
      config,
      logger,
      deepseek ? filterDeepSeekToolContext(optimized) : filterOrphanToolMessages(optimized),
    ),
    coreTools: convertTools(config, tools),
    experimentalOutput: convertOutputFormat(config.outputFormat),
  };
}

export function buildModelResponse(
  config: ModelServiceConfig,
  result: RawModelResult,
): ModelResponse {
  const calls = extractToolCalls(result);
  return {
    content: result.text,
    reasoningContent: Array.isArray(result.reasoning)
      ? result.reasoning.map(({ text }) => text).join('')
      : result.reasoningText,
    toolCalls: calls?.map(normalizeToolCall),
    usage: convertUsage(config, result.usage, result.providerMetadata),
  };
}

export function providerOptions(config: ModelServiceConfig): AIProviderOptions | undefined {
  if (config.provider !== 'deepseek') {
    return config.providerOptions as AIProviderOptions | undefined;
  }
  const { deepseek, ...other } = config.providerOptions ?? {};
  const options = {
    ...other,
    ...buildDeepSeekProviderOptions({
      model: config.model,
      supportsThinking: config.supportsThinking,
      deepseek,
    }),
  } as AIProviderOptions;
  return Object.keys(options).length > 0 ? options : undefined;
}

export function samplingTemperature(
  config: ModelServiceConfig,
  temperature?: number,
): number | undefined {
  return shouldOmitDeepSeekSamplingOptions({
    provider: config.provider,
    providerId: config.providerId,
    model: config.model,
    supportsThinking: config.supportsThinking,
    deepseek: config.providerOptions?.deepseek,
  })
    ? undefined
    : temperature;
}

export function normalizeToolCall(value: unknown, index: number): ModelToolCall {
  const call = value as RawToolCall;
  return {
    id: call.toolCallId ?? call.tool_call_id ?? call.id ?? `call_${index}`,
    type: 'function',
    function: {
      name: call.toolName ?? call.tool_name ?? call.name ?? call.function?.name ?? '',
      arguments: stringifyArguments(
        call.args ?? call.input ?? call.arguments ?? call.function?.arguments ?? {},
      ),
    },
  };
}

export function convertUsage(
  config: ModelServiceConfig,
  usage?: RawUsage,
  metadata?: RawProviderMetadata,
): ModelUsage | undefined {
  if (!usage) return undefined;
  if (metadata?.deepseek || config.provider === 'deepseek') {
    return mergeDeepSeekUsage(usage, metadata);
  }
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
    ...(metadata?.anthropic?.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: metadata.anthropic.cacheCreationInputTokens }
      : {}),
    ...(metadata?.anthropic?.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: metadata.anthropic.cacheReadInputTokens }
      : {}),
  };
}

function convertMessages(
  config: ModelServiceConfig,
  logger: InternalLogger,
  messages: readonly ModelMessage[],
): AIMessage[] {
  const identity = resolveModelIdentity(config);
  return messages.flatMap((message): AIMessage[] => {
    const text = textContent(message.content);
    if (message.role === 'system') {
      const options = Array.isArray(message.content)
        ? message.content.find((part) => part.type === 'text')?.providerOptions
        : undefined;
      return [
        {
          role: 'system',
          content: text,
          ...(options ? { providerOptions: options as AIProviderOptions } : {}),
        },
      ];
    }
    if (message.role === 'user') {
      return [
        {
          role: 'user',
          content: Array.isArray(message.content)
            ? message.content.map((part) => {
                if (part.type === 'text') {
                  return {
                    type: 'text',
                    text: part.text,
                    ...(part.providerOptions
                      ? { providerOptions: part.providerOptions as AIProviderOptions }
                      : {}),
                  };
                }
                const data = parseDataUrl(part.image_url.url);
                return {
                  type: 'image',
                  image: data?.data ?? part.image_url.url,
                  ...(data?.mediaType ? { mediaType: data.mediaType } : {}),
                };
              })
            : message.content,
        },
      ];
    }
    if (message.role === 'tool') {
      return message.tool_call_id
        ? [
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: message.tool_call_id,
                  toolName: message.name || 'unknown',
                  output: { type: 'text', value: text },
                },
              ],
            },
          ]
        : [];
    }

    const sameModel =
      message.modelIdentity?.provider === identity.provider &&
      message.modelIdentity.api === identity.api &&
      message.modelIdentity.model === identity.model;
    if (!message.tool_calls?.length) {
      if (message.reasoningContent && sameModel && config.provider !== 'deepseek') {
        return [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: message.reasoningContent },
              ...(text ? [{ type: 'text' as const, text }] : []),
            ],
          },
        ];
      }
      if (message.reasoningContent && !sameModel) {
        return [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: message.reasoningContent },
              ...(text ? [{ type: 'text' as const, text }] : []),
            ],
          },
        ];
      }
      return [{ role: 'assistant', content: text }];
    }
    const content: Extract<AIMessage, { role: 'assistant' }>['content'] = [];
    if (message.reasoningContent) {
      content.push({
        type: sameModel ? 'reasoning' : 'text',
        text: message.reasoningContent,
      });
    }
    if (text) content.push({ type: 'text', text });
    for (const call of message.tool_calls ?? []) {
      content.push({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.function?.name || '',
        input: parseJson(call.function?.arguments || '{}', logger),
      });
    }
    return [{ role: 'assistant', content }];
  });
}

function convertTools(
  config: ModelServiceConfig,
  tools?: readonly ModelToolDefinition[],
): Record<string, AITool> | undefined {
  if (!tools?.length) return undefined;
  const prepared =
    config.provider === 'deepseek'
      ? prepareDeepSeekTools(tools, config.providerOptions?.deepseek)
      : tools;
  return Object.fromEntries(
    (prepared ?? []).map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as Parameters<typeof jsonSchema>[0]),
        ...('strict' in tool && tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    ]),
  );
}

function convertOutputFormat(output?: OutputFormat): ReturnType<typeof Output.object> | undefined {
  return output?.type === 'json_schema' && output.json_schema?.schema
    ? Output.object({
        schema: jsonSchema(output.json_schema.schema as Parameters<typeof jsonSchema>[0]),
      })
    : undefined;
}

function extractToolCalls(result: RawModelResult): RawToolCall[] | undefined {
  const direct = result.toolCalls?.length ? result.toolCalls : result.tool_calls;
  if (direct?.length) return direct;
  const message = result.message?.toolCalls?.length
    ? result.message.toolCalls
    : result.message?.tool_calls;
  if (message?.length) return message;
  const choices = result.choices?.flatMap(
    (choice) => choice.message?.toolCalls ?? choice.message?.tool_calls ?? [],
  );
  if (choices?.length) return choices;
  const steps = result.steps?.flatMap((step) => step.toolCalls ?? step.tool_calls ?? []);
  return steps?.length ? steps : undefined;
}

function filterOrphanToolMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const calls = new Set(
    messages.flatMap((message) =>
      message.role === 'assistant' ? (message.tool_calls ?? []).map(({ id }) => id) : [],
    ),
  );
  return messages.filter(
    (message) =>
      message.role !== 'tool' || Boolean(message.tool_call_id && calls.has(message.tool_call_id)),
  );
}

function filterDeepSeekToolContext(messages: readonly ModelMessage[]): ModelMessage[] {
  const results = new Set(
    messages.flatMap((message) =>
      message.role === 'tool' && message.tool_call_id ? [message.tool_call_id] : [],
    ),
  );
  const retained = new Set<string>();
  const normalized = messages.map((message) => {
    if (message.role !== 'assistant' || !message.tool_calls?.length) return message;
    const toolCalls = message.tool_calls.filter(({ id }) => results.has(id));
    toolCalls.forEach(({ id }) => {
      retained.add(id);
    });
    return toolCalls.length === message.tool_calls.length
      ? message
      : { ...message, tool_calls: toolCalls.length ? toolCalls : undefined };
  });
  return normalized.filter(
    (message) =>
      message.role !== 'tool' ||
      Boolean(message.tool_call_id && retained.has(message.tool_call_id)),
  );
}

function textContent(content: string | ModelContent[]): string {
  return typeof content === 'string'
    ? content
    : content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
}

function parseDataUrl(url: string): { data: string; mediaType?: string } | undefined {
  const match = /^data:([^;,]+)?;base64,(.+)$/.exec(url);
  return match ? { data: match[2], mediaType: match[1] || undefined } : undefined;
}

function parseJson(value: string, logger: InternalLogger): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    logger.warn('Failed to parse tool arguments as JSON; using an empty object');
    return {};
  }
}

function stringifyArguments(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value ?? {});
  if (!value.trim()) return '{}';
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}
