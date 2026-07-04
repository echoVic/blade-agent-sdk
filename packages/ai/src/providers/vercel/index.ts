import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, type LanguageModel, Output, streamText } from 'ai';
import {
  buildDeepSeekProviderOptions,
  prepareDeepSeekTools,
  normalizeDeepSeekModel,
  resolveDeepSeekBaseUrl,
  shouldUseDeepSeekBetaBaseUrl,
  type DeepSeekProviderOptions,
} from '../../deepseek/index.js';
import type {
  JsonObject,
  JsonValue,
  ModelPort,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
  ModelToolDefinition,
  UsageInfo,
} from '../../model/index.js';

export interface VercelLanguageModelOptions {
  provider: ModelProvider | string;
  providerId?: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  headers?: Record<string, string>;
  apiVersion?: string;
  providerOptions?: JsonObject;
  supportsThinking?: boolean;
}

export function createVercelLanguageModel(options: VercelLanguageModelOptions): LanguageModel {
  const { provider, apiKey, baseUrl, model, headers, providerId, apiVersion } = options;

  switch (provider) {
    case 'openai': {
      const openai = createOpenAI({
        apiKey,
        baseURL: baseUrl || undefined,
        headers,
      });
      return openai(model);
    }

    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey,
        baseURL: baseUrl || undefined,
        headers,
      });
      return anthropic(model);
    }

    case 'gemini': {
      if (baseUrl && !isGeminiOfficialUrl(baseUrl)) {
        return createCompatibleModel({
          name: 'gemini',
          apiKey,
          baseUrl,
          headers,
          model,
        });
      }

      const google = createGoogleGenerativeAI({
        apiKey,
        baseURL: baseUrl || undefined,
      });
      return google(model);
    }

    case 'azure-openai': {
      const resourceName = extractAzureResourceName(baseUrl);
      if (resourceName) {
        const azure = createAzure({
          apiKey,
          resourceName,
          apiVersion: apiVersion || '2024-08-01-preview',
        });
        return azure(model);
      }

      const compatible = createOpenAICompatible({
        name: 'azure-openai',
        apiKey,
        baseURL: buildAzureBaseUrl(baseUrl, model),
        headers: {
          ...headers,
          'api-key': apiKey,
        },
        queryParams: {
          'api-version': apiVersion || '2024-08-01-preview',
        },
      });
      return compatible(model);
    }

    case 'deepseek': {
      return createDeepSeekLanguageModel(options);
    }

    default: {
      if (providerId === 'deepseek') {
        return createDeepSeekLanguageModel(options);
      }

      return createCompatibleModel({
        name: providerId || 'custom',
        apiKey,
        baseUrl,
        headers,
        model,
      });
    }
  }
}

type RawUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    noCacheTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
};

type RawToolCall = {
  toolCallId?: string;
  tool_call_id?: string;
  id?: string;
  toolName?: string;
  tool_name?: string;
  name?: string;
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

type GenerateTextResult = {
  text?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  reasoningText?: string;
  reasoning?: Array<{ text?: string }>;
  toolCalls?: RawToolCall[];
  tool_calls?: RawToolCall[];
  message?: {
    toolCalls?: RawToolCall[];
    tool_calls?: RawToolCall[];
  };
  choices?: Array<{
    message?: {
      toolCalls?: RawToolCall[];
      tool_calls?: RawToolCall[];
    };
  }>;
  steps?: Array<{
    toolCalls?: RawToolCall[];
    tool_calls?: RawToolCall[];
  }>;
  usage?: RawUsage;
  totalUsage?: RawUsage;
  finishReason?: string;
  providerMetadata?: JsonObject;
};

type StreamPart = {
  type?: string;
  text?: string;
  textDelta?: string;
  delta?: string;
  finishReason?: string;
  usage?: RawUsage;
  totalUsage?: RawUsage;
  providerMetadata?: JsonObject;
  error?: unknown;
} & RawToolCall;

export function createVercelModelPort(options: VercelLanguageModelOptions): ModelPort {
  return {
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const result = await generateText({
        model: createVercelLanguageModel({
          ...options,
          model: request.model ?? options.model,
        }),
        messages: toAiMessages(request.messages),
        tools: toAiTools(prepareTools(options, request)),
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        abortSignal: request.signal,
        experimental_output: toExperimentalOutput(request.outputFormat),
        providerOptions: toProviderOptions(options, request),
      } as never) as GenerateTextResult;

      return toModelResponse(result);
    },

    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const result = streamText({
        model: createVercelLanguageModel({
          ...options,
          model: request.model ?? options.model,
        }),
        messages: toAiMessages(request.messages),
        tools: toAiTools(prepareTools(options, request)),
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        abortSignal: request.signal,
        experimental_output: toExperimentalOutput(request.outputFormat),
        providerOptions: toProviderOptions(options, request),
      } as never) as { fullStream: AsyncIterable<StreamPart> };

      for await (const part of result.fullStream) {
        yield* toModelStreamEvents(part);
      }
    },
  };
}

function isDeepSeekProvider(options: Pick<VercelLanguageModelOptions, 'provider' | 'providerId'>): boolean {
  return options.provider === 'deepseek' || options.providerId === 'deepseek';
}

function prepareTools(
  options: VercelLanguageModelOptions,
  request: ModelRequest,
): readonly ModelToolDefinition[] | undefined {
  if (!isDeepSeekProvider(options)) return request.tools;
  const providerOptions = request.providerOptions as { deepseek?: DeepSeekProviderOptions } | undefined;
  return prepareDeepSeekTools(
    request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters as never,
    })),
    providerOptions?.deepseek,
  ) as readonly ModelToolDefinition[] | undefined;
}

function toProviderOptions(
  options: VercelLanguageModelOptions,
  request: ModelRequest,
): JsonObject | undefined {
  if (!isDeepSeekProvider(options)) return request.providerOptions;

  const { deepseek, ...otherProviderOptions } = (request.providerOptions ?? {}) as JsonObject & {
    deepseek?: DeepSeekProviderOptions;
  };
  const deepseekOptions = buildDeepSeekProviderOptions({
    model: request.model ?? options.model,
    supportsThinking: options.supportsThinking,
    deepseek,
  }) as JsonObject | undefined;
  const providerOptions = {
    ...otherProviderOptions,
    ...deepseekOptions,
  } as JsonObject;
  return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
}

function toExperimentalOutput(outputFormat: ModelRequest['outputFormat']): unknown {
  if (!outputFormat || outputFormat.type !== 'json_schema') return undefined;
  const schema = outputFormat.json_schema?.schema;
  if (!schema) return undefined;
  return Output.object({
    schema: jsonSchema(schema as never),
  });
}

function toAiMessages(messages: readonly ModelRequest['messages'][number][]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const content: unknown[] = [];
      if (message.reasoningContent) {
        content.push({ type: 'reasoning', text: message.reasoningContent });
      }
      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }
      content.push(...message.toolCalls.map((toolCall) => ({
        type: 'tool-call',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.input,
      })));
      return { role: 'assistant', content };
    }

    if (message.role === 'assistant' && message.reasoningContent) {
      return {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: message.reasoningContent },
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ],
      };
    }

    if (message.role === 'tool' && message.toolCallId) {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId,
            toolName: message.name || 'unknown',
            output: { type: 'text', value: message.content },
          },
        ],
      };
    }

    return {
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    };
  });
}

function toAiTools(tools: readonly ModelToolDefinition[] | undefined): Record<string, {
  description?: string;
  inputSchema: unknown;
  strict?: boolean;
}> | undefined {
  if (!tools || tools.length === 0) return undefined;

  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as never),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    ]),
  );
}

function toModelResponse(result: GenerateTextResult): ModelResponse {
  return {
    content: getTextContent(result),
    reasoningContent: getReasoningText(result),
    toolCalls: toModelToolCalls(extractToolCalls(result)),
    usage: toUsageInfo(result.totalUsage ?? result.usage),
    finishReason: result.finishReason,
    raw: result as JsonValue,
  };
}

function getTextContent(result: GenerateTextResult): string {
  if (typeof result.text === 'string') return result.text;
  return result.content
    ?.filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('') ?? '';
}

function getReasoningText(result: GenerateTextResult): string | undefined {
  if (typeof result.reasoningText === 'string') return result.reasoningText;
  const contentReasoning = result.content
    ?.filter((part) => part.type === 'reasoning')
    .map((part) => part.text ?? '')
    .join('');
  if (contentReasoning) return contentReasoning;
  const reasoning = result.reasoning
    ?.map((item) => item.text ?? '')
    .join('');
  return reasoning || undefined;
}

function extractToolCalls(result: GenerateTextResult): RawToolCall[] | undefined {
  if (result.toolCalls && result.toolCalls.length > 0) return result.toolCalls;
  if (result.tool_calls && result.tool_calls.length > 0) return result.tool_calls;
  if (result.message?.toolCalls && result.message.toolCalls.length > 0) return result.message.toolCalls;
  if (result.message?.tool_calls && result.message.tool_calls.length > 0) return result.message.tool_calls;
  const choiceToolCalls = result.choices?.flatMap((choice) => (
    choice.message?.toolCalls ?? choice.message?.tool_calls ?? []
  ));
  if (choiceToolCalls && choiceToolCalls.length > 0) return choiceToolCalls;
  const stepToolCalls = result.steps?.flatMap((step) => (
    step.toolCalls ?? step.tool_calls ?? []
  ));
  return stepToolCalls && stepToolCalls.length > 0 ? stepToolCalls : undefined;
}

function toModelToolCalls(toolCalls: RawToolCall[] | undefined): ModelToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((toolCall, index) => ({
    id: toolCall.toolCallId ?? toolCall.tool_call_id ?? toolCall.id ?? `call_${index}`,
    name: toolCall.toolName ?? toolCall.tool_name ?? toolCall.name ?? toolCall.function?.name ?? '',
    input: toJsonObject(
      toolCall.input
      ?? toolCall.args
      ?? toolCall.arguments
      ?? toolCall.function?.arguments
      ?? {},
    ),
  }));
}

function toJsonObject(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return toJsonObject(parsed);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
}

function toUsageInfo(usage: RawUsage | undefined): UsageInfo | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
    ...(usage.reasoningTokens !== undefined || usage.outputTokenDetails?.reasoningTokens !== undefined
      ? { reasoningTokens: usage.reasoningTokens ?? usage.outputTokenDetails?.reasoningTokens }
      : {}),
    ...(usage.inputTokenDetails?.cacheReadTokens !== undefined || usage.cachedInputTokens !== undefined
      ? { cacheReadInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens }
      : {}),
    ...(usage.inputTokenDetails?.cacheWriteTokens !== undefined
      ? { cacheCreationInputTokens: usage.inputTokenDetails.cacheWriteTokens }
      : {}),
    ...(usage.inputTokenDetails?.noCacheTokens !== undefined
      ? {
          cacheMissInputTokens: usage.inputTokenDetails.noCacheTokens,
          billableInputTokens: usage.inputTokenDetails.noCacheTokens,
        }
      : {}),
  };
}

async function* toModelStreamEvents(part: StreamPart): AsyncIterable<ModelStreamEvent> {
  switch (part.type) {
    case 'text-delta': {
      const delta = part.text ?? part.textDelta ?? part.delta;
      if (delta !== undefined) yield { type: 'content_delta', delta };
      return;
    }
    case 'reasoning-delta': {
      const delta = part.text ?? part.textDelta ?? part.delta;
      if (delta !== undefined) yield { type: 'reasoning_delta', delta };
      return;
    }
    case 'tool-call': {
      yield {
        type: 'tool_call',
        toolCall: toModelToolCalls([part])?.[0] ?? { id: 'call_0', name: '', input: {} },
      };
      return;
    }
    case 'finish': {
      const usage = toUsageInfo(part.totalUsage ?? part.usage);
      if (usage) yield { type: 'usage', usage };
      yield { type: 'done', finishReason: part.finishReason };
      return;
    }
    case 'error': {
      yield {
        type: 'error',
        error: part.error instanceof Error ? part.error : new Error(String(part.error ?? 'Model stream error')),
      };
      return;
    }
  }
}

function createDeepSeekLanguageModel(options: VercelLanguageModelOptions): LanguageModel {
  const deepseek = createDeepSeek({
    apiKey: options.apiKey,
    baseURL: resolveDeepSeekBaseUrl(
      options.baseUrl,
      shouldUseDeepSeekBetaBaseUrl({
        provider: options.provider,
        providerId: options.providerId,
        deepseek: getDeepSeekProviderOptions(options.providerOptions),
      }),
    ),
    headers: options.headers,
  });
  return deepseek(normalizeDeepSeekModel(options.model));
}

function createCompatibleModel(options: {
  name: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  model: string;
}): LanguageModel {
  const compatible = createOpenAICompatible({
    name: options.name,
    apiKey: options.apiKey,
    baseURL: options.baseUrl ?? '',
    headers: options.headers,
  });
  return compatible(options.model);
}

function getDeepSeekProviderOptions(providerOptions?: JsonObject): DeepSeekProviderOptions | undefined {
  const candidate = providerOptions?.deepseek;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  return candidate as DeepSeekProviderOptions;
}

function extractAzureResourceName(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const match = baseUrl.match(/https:\/\/([^.]+)\.openai\.azure(?:\.com|\.us|\.cn|\.de)/);
  return match ? match[1] : undefined;
}

function buildAzureBaseUrl(baseUrl?: string, deployment?: string): string {
  if (!baseUrl) return '';
  const url = baseUrl.replace(/\/$/, '').replace(/\?.*$/, '');
  if (url.includes('/openai/deployments/')) {
    return url;
  }
  return `${url}/openai/deployments/${deployment}`;
}

function isGeminiOfficialUrl(baseUrl: string): boolean {
  return baseUrl.includes('generativelanguage.googleapis.com') || baseUrl.includes('aiplatform.googleapis.com');
}
