import { generateText, jsonSchema, type LanguageModel, Output, streamText } from 'ai';
import type { JSONSchema7 } from 'json-schema';
import { ProviderRegistryError } from '../errors/ProviderRegistryError.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { ModelServiceConfig, OutputFormat } from '../model/config.js';
import { resolveModelIdentity } from '../model/identity.js';
import type { ModelContent, ModelMessage, ModelToolCall } from '../model/message.js';
import type { ModelRetryConfig, ModelRetryEvent } from '../model/retry.js';
import type {
  ModelResponse,
  ModelService,
  ModelSideQueryOptions,
  ModelStreamChunk,
} from '../model/service.js';
import type { ModelUsage } from '../model/usage.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import {
  buildDeepSeekProviderOptions,
  mergeDeepSeekUsage,
  normalizeDeepSeekModel,
  optimizeDeepSeekCachePrefix,
  prepareDeepSeekTools,
  resolveDeepSeekBaseUrl,
  shouldOmitDeepSeekSamplingOptions,
  shouldUseDeepSeekBetaBaseUrl,
} from './deepseek.js';
import { DEFAULT_RETRY_CONFIG, type RetryContext, withRetry } from './RetryPolicy.js';

function filterOrphanToolMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const availableToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        availableToolCallIds.add(tc.id);
      }
    }
  }
  return messages.filter((msg) => {
    if (msg.role === 'tool') {
      if (!msg.tool_call_id) return false;
      return availableToolCallIds.has(msg.tool_call_id);
    }
    return true;
  });
}

function filterDeepSeekToolContext(messages: readonly ModelMessage[]): ModelMessage[] {
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResultIds.add(msg.tool_call_id);
    }
  }

  const retainedToolCallIds = new Set<string>();
  const normalized = messages.map((msg) => {
    if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) {
      return msg;
    }

    const retainedToolCalls = msg.tool_calls.filter((tc) => toolResultIds.has(tc.id));
    for (const tc of retainedToolCalls) {
      retainedToolCallIds.add(tc.id);
    }

    if (retainedToolCalls.length === msg.tool_calls.length) {
      return msg;
    }

    return {
      ...msg,
      tool_calls: retainedToolCalls.length > 0 ? retainedToolCalls : undefined,
    };
  });

  return normalized.filter((msg) => {
    if (msg.role !== 'tool') return true;
    return Boolean(msg.tool_call_id && retainedToolCallIds.has(msg.tool_call_id));
  });
}

function getTextContent(content: string | ModelContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

type AIProviderOptions = Record<string, JsonObject>;

type AITextPart = {
  type: 'text';
  text: string;
  providerOptions?: AIProviderOptions;
};

type AIMessage =
  | { role: 'system'; content: string; providerOptions?: AIProviderOptions }
  | { role: 'user'; content: string | Array<AITextPart | { type: 'image'; image: string }> }
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

type AITool = {
  description?: string;
  inputSchema: unknown;
  strict?: boolean;
};

type RawToolCall = {
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
};

type RawToolCallResult = {
  text?: string;
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
};

function parseDataUrl(url: string): { data: string; mediaType?: string } | undefined {
  const match = url.match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) {
    return undefined;
  }

  return {
    mediaType: match[1] || undefined,
    data: match[2],
  };
}

function safeJsonParse(str: string, logger: InternalLogger, fallback: JsonValue = {}): JsonValue {
  try {
    return JSON.parse(str) as JsonValue;
  } catch {
    logger.warn('⚠️ [VercelAIModelService] Failed to parse JSON, using fallback', { str });
    return fallback;
  }
}

async function loadProviderPackage<T>(
  provider: string,
  packageName: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (cause) {
    throw new ProviderRegistryError(
      'PROVIDER_ADAPTER_NOT_FOUND',
      `Built-in provider "${provider}" requires the optional package "${packageName}"`,
      { providerType: provider, cause },
    );
  }
}

function getStreamTextDelta(part: unknown): string | undefined {
  const chunk = part as { text?: string; textDelta?: string; delta?: string };
  return chunk.text ?? chunk.textDelta ?? chunk.delta;
}

function getDeepSeekStreamToolCall(part: unknown, index: number): ModelToolCall {
  const raw = part as RawToolCall;
  return {
    id: raw.toolCallId ?? raw.tool_call_id ?? raw.id ?? `call_${index}`,
    type: 'function',
    function: {
      name: raw.toolName ?? raw.tool_name ?? raw.name ?? raw.function?.name ?? '',
      arguments: stringifyToolArgumentsValue(
        raw.args ?? raw.input ?? raw.arguments ?? raw.function?.arguments ?? {},
      ),
    },
  };
}

function stringifyToolArgumentsValue(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return value;
    }
  }
  return JSON.stringify(value ?? {});
}

/**
 * 消费 withRetry AsyncGenerator，收集 ModelRetryEvent 并返回结果
 */
async function consumeRetryGenerator<T>(
  gen: AsyncGenerator<ModelRetryEvent, T>,
  logger: InternalLogger,
): Promise<T> {
  while (true) {
    const { value, done } = await gen.next();
    if (done) return value;
    // ModelRetryEvent — log it
    const event = value as ModelRetryEvent;
    logger.warn(
      `🔄 [RetryPolicy] Attempt ${event.attempt}/${event.maxRetries}, ` +
        `delay ${event.delayMs}ms, error: ${event.error.status ?? 'unknown'} ${event.error.message}`,
    );
  }
}

export class VercelAIModelService implements ModelService {
  private model!: LanguageModel;
  private config: ModelServiceConfig;
  private initialized: Promise<void>;
  private readonly logger: InternalLogger;
  private retryConfig: ModelRetryConfig;

  constructor(config: ModelServiceConfig, logger: InternalLogger = NOOP_LOGGER) {
    this.config = config;
    this.logger = logger.child(LogCategory.CHAT);
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config.retry, currentModel: config.model };
    this.initialized = this.initModel(config);
  }

  async ready(): Promise<void> {
    await this.initialized;
  }

  private async initModel(config: ModelServiceConfig): Promise<void> {
    this.model = await this.createModel(config);
    this.logger.debug('🚀 [VercelAIModelService] Initialized', {
      provider: config.provider,
      model: config.model,
      providerId: config.providerId,
    });
  }

  private async createModel(config: ModelServiceConfig): Promise<LanguageModel> {
    const { provider, apiKey, baseUrl, model, customHeaders, providerId, apiVersion } = config;

    switch (provider) {
      case 'openai': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        const openai = createOpenAI({
          apiKey,
          baseURL: baseUrl || undefined,
          headers: customHeaders,
        });
        return openai(model);
      }

      case 'anthropic': {
        const { createAnthropic } = await loadProviderPackage(
          provider,
          '@ai-sdk/anthropic',
          () => import('@ai-sdk/anthropic'),
        );
        const anthropic = createAnthropic({
          apiKey,
          baseURL: baseUrl || undefined,
          headers: customHeaders,
        });
        return anthropic(model);
      }

      case 'gemini': {
        if (baseUrl && !this.isGeminiOfficialUrl(baseUrl)) {
          const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
          const compatible = createOpenAICompatible({
            name: 'gemini',
            apiKey,
            baseURL: baseUrl,
            headers: customHeaders,
          });
          return compatible(model);
        }
        const { createGoogleGenerativeAI } = await loadProviderPackage(
          provider,
          '@ai-sdk/google',
          () => import('@ai-sdk/google'),
        );
        const google = createGoogleGenerativeAI({
          apiKey,
          baseURL: baseUrl || undefined,
        });
        return google(model);
      }

      case 'azure-openai': {
        const resourceName = this.extractAzureResourceName(baseUrl);
        if (resourceName) {
          const { createAzure } = await loadProviderPackage(
            provider,
            '@ai-sdk/azure',
            () => import('@ai-sdk/azure'),
          );
          const azure = createAzure({
            apiKey,
            resourceName,
            apiVersion: apiVersion || '2024-08-01-preview',
          });
          return azure(model);
        }
        const azureBaseUrl = this.buildAzureBaseUrl(baseUrl, model);
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        const compatible = createOpenAICompatible({
          name: 'azure-openai',
          apiKey,
          baseURL: azureBaseUrl,
          headers: {
            ...customHeaders,
            'api-key': apiKey,
          },
          queryParams: {
            'api-version': apiVersion || '2024-08-01-preview',
          },
        });
        return compatible(model);
      }

      case 'deepseek': {
        const { createDeepSeek } = await loadProviderPackage(
          provider,
          '@ai-sdk/deepseek',
          () => import('@ai-sdk/deepseek'),
        );
        const deepseek = createDeepSeek({
          apiKey,
          baseURL: resolveDeepSeekBaseUrl(
            baseUrl,
            shouldUseDeepSeekBetaBaseUrl({
              provider,
              providerId,
              deepseek: config.providerOptions?.deepseek,
            }),
          ),
          headers: customHeaders,
        });
        return deepseek(normalizeDeepSeekModel(model));
      }

      case 'openai-compatible': {
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        const compatible = createOpenAICompatible({
          name: providerId || 'custom',
          apiKey,
          baseURL: baseUrl,
          headers: customHeaders,
        });
        return compatible(model);
      }

      default:
        throw new ProviderRegistryError(
          'PROVIDER_ADAPTER_NOT_FOUND',
          `No built-in provider adapter is registered for "${provider}"`,
          { providerType: provider },
        );
    }
  }

  private extractAzureResourceName(baseUrl?: string): string | undefined {
    if (!baseUrl) return undefined;
    const match = baseUrl.match(/https:\/\/([^.]+)\.openai\.azure(?:\.com|\.us|\.cn|\.de)/);
    return match ? match[1] : undefined;
  }

  private buildAzureBaseUrl(baseUrl?: string, deployment?: string): string {
    if (!baseUrl) return '';
    const url = baseUrl.replace(/\/$/, '').replace(/\?.*$/, '');
    if (url.includes('/openai/deployments/')) {
      return url;
    }
    return `${url}/openai/deployments/${deployment}`;
  }

  private isGeminiOfficialUrl(baseUrl: string): boolean {
    return (
      baseUrl.includes('generativelanguage.googleapis.com') ||
      baseUrl.includes('aiplatform.googleapis.com')
    );
  }

  private convertMessages(messages: readonly ModelMessage[]): AIMessage[] {
    const result: AIMessage[] = [];
    const isDeepSeek = this.isDeepSeekProvider();
    const targetModel = resolveModelIdentity(this.config);

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (Array.isArray(msg.content)) {
          const textPart = msg.content.find((p) => p.type === 'text') as
            | { type: 'text'; text: string; providerOptions?: AIProviderOptions }
            | undefined;
          const systemMsg: AIMessage = {
            role: 'system',
            content: getTextContent(msg.content),
          };
          if (textPart?.providerOptions) {
            (systemMsg as { providerOptions?: AIProviderOptions }).providerOptions =
              textPart.providerOptions as AIProviderOptions;
          }
          result.push(systemMsg);
        } else {
          result.push({ role: 'system', content: msg.content });
        }
      } else if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          const parts = msg.content.map((part) => {
            if (part.type === 'text') {
              const textPart: AITextPart = { type: 'text', text: part.text };
              if (part.providerOptions) {
                textPart.providerOptions = part.providerOptions as AIProviderOptions;
              }
              return textPart;
            }
            const dataUrl = parseDataUrl(part.image_url.url);
            if (dataUrl) {
              return {
                type: 'image' as const,
                image: dataUrl.data,
                mediaType: dataUrl.mediaType,
              };
            }
            return { type: 'image' as const, image: part.image_url.url };
          });
          result.push({ role: 'user', content: parts });
        } else {
          result.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'assistant') {
        const isSameModel =
          msg.modelIdentity?.provider === targetModel.provider &&
          msg.modelIdentity.api === targetModel.api &&
          msg.modelIdentity.model === targetModel.model;
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const content: Array<
            | { type: 'reasoning'; text: string }
            | { type: 'text'; text: string }
            | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
          > = [];
          if (msg.reasoningContent) {
            content.push(
              isSameModel
                ? { type: 'reasoning', text: msg.reasoningContent }
                : { type: 'text', text: msg.reasoningContent },
            );
          }
          const toolCalls = msg.tool_calls.map((tc) => {
            const fn = (tc as { function?: { name: string; arguments?: string } }).function;
            return {
              type: 'tool-call' as const,
              toolCallId: tc.id,
              toolName: fn?.name || '',
              input: safeJsonParse(fn?.arguments || '{}', this.logger, {}),
            };
          });
          const text = getTextContent(msg.content);
          if (text) {
            content.push({ type: 'text', text });
          }
          content.push(...toolCalls);
          result.push({ role: 'assistant', content });
        } else {
          const text = getTextContent(msg.content);
          if (msg.reasoningContent && isSameModel && !isDeepSeek) {
            result.push({
              role: 'assistant',
              content: [
                { type: 'reasoning', text: msg.reasoningContent },
                ...(text ? [{ type: 'text' as const, text }] : []),
              ],
            });
          } else if (msg.reasoningContent && !isSameModel) {
            result.push({
              role: 'assistant',
              content: [
                { type: 'text', text: msg.reasoningContent },
                ...(text ? [{ type: 'text' as const, text }] : []),
              ],
            });
          } else {
            result.push({ role: 'assistant', content: text });
          }
        }
      } else if (msg.role === 'tool') {
        if (!msg.tool_call_id) continue;
        result.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: msg.tool_call_id,
              toolName: msg.name || 'unknown',
              output: { type: 'text', value: getTextContent(msg.content) },
            },
          ],
        });
      }
    }

    return result;
  }

  private convertTools(
    tools?: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
  ): Record<string, AITool> | undefined {
    if (!tools || tools.length === 0) return undefined;

    const result: Record<string, AITool> = {};
    const preparedTools = this.isDeepSeekProvider()
      ? prepareDeepSeekTools(tools, this.config.providerOptions?.deepseek)
      : tools;
    for (const tool of preparedTools ?? []) {
      const strict = 'strict' in tool ? tool.strict : undefined;
      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as Parameters<typeof jsonSchema>[0]),
        ...(strict !== undefined ? { strict } : {}),
      };
    }
    return result;
  }

  private convertToolCalls(toolCalls: RawToolCall[]): ModelToolCall[] {
    return toolCalls.map((tc, index) => ({
      id: tc.toolCallId ?? tc.tool_call_id ?? tc.id ?? `call_${index}`,
      type: 'function' as const,
      function: {
        name: tc.toolName ?? tc.tool_name ?? tc.name ?? tc.function?.name ?? '',
        arguments: this.stringifyToolArguments(
          tc.args ?? tc.input ?? tc.arguments ?? tc.function?.arguments ?? {},
        ),
      },
    }));
  }

  private stringifyToolArguments(value: unknown): string {
    return stringifyToolArgumentsValue(value);
  }

  private convertOutputFormat(outputFormat?: OutputFormat) {
    if (!outputFormat || outputFormat.type !== 'json_schema') {
      return undefined;
    }

    const { json_schema } = outputFormat;
    if (!json_schema?.schema) {
      return undefined;
    }
    return Output.object({
      schema: jsonSchema(json_schema.schema as Parameters<typeof jsonSchema>[0]),
    });
  }

  private convertUsage(
    usage?: {
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
      outputTokenDetails?: {
        textTokens?: number;
        reasoningTokens?: number;
      };
      reasoningTokens?: number;
      cachedInputTokens?: number;
      billableInputTokens?: number;
      cacheMissInputTokens?: number;
    },
    providerMetadata?: {
      anthropic?: {
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      };
      deepseek?: {
        promptCacheHitTokens?: number;
        promptCacheMissTokens?: number;
      };
    },
  ): ModelUsage | undefined {
    if (!usage) return undefined;
    if (providerMetadata?.deepseek || this.config.provider === 'deepseek') {
      return mergeDeepSeekUsage(usage, providerMetadata);
    }

    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;
    const result: ModelUsage = {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: usage.totalTokens ?? prompt + completion,
    };
    if (providerMetadata?.anthropic) {
      if (providerMetadata.anthropic.cacheCreationInputTokens !== undefined) {
        result.cacheCreationInputTokens = providerMetadata.anthropic.cacheCreationInputTokens;
      }
      if (providerMetadata.anthropic.cacheReadInputTokens !== undefined) {
        result.cacheReadInputTokens = providerMetadata.anthropic.cacheReadInputTokens;
      }
    }
    return result;
  }

  private getProviderOptions(): AIProviderOptions | undefined {
    if (this.isDeepSeekProvider()) {
      const { deepseek, ...otherProviderOptions } = this.config.providerOptions ?? {};
      const deepseekOptions = buildDeepSeekProviderOptions({
        model: this.config.model,
        supportsThinking: this.config.supportsThinking,
        deepseek,
      });

      const providerOptions = {
        ...otherProviderOptions,
        ...deepseekOptions,
      } as AIProviderOptions;
      return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
    }
    return this.config.providerOptions as AIProviderOptions | undefined;
  }

  private isDeepSeekProvider(): boolean {
    return this.config.provider === 'deepseek';
  }

  private shouldOmitSamplingOptions(): boolean {
    return shouldOmitDeepSeekSamplingOptions({
      provider: this.config.provider,
      providerId: this.config.providerId,
      model: this.config.model,
      supportsThinking: this.config.supportsThinking,
      deepseek: this.config.providerOptions?.deepseek,
    });
  }

  private getTemperatureOverride(temperature?: number): number | undefined {
    if (this.shouldOmitSamplingOptions()) return undefined;
    return temperature;
  }

  private prepareRequest(
    messages: readonly ModelMessage[],
    tools?: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
  ) {
    const optimizedMessages = this.isDeepSeekProvider()
      ? optimizeDeepSeekCachePrefix(
          messages,
          this.config.providerOptions?.deepseek?.cacheOptimization,
        )
      : messages;
    const filteredMessages = this.isDeepSeekProvider()
      ? filterDeepSeekToolContext(optimizedMessages)
      : filterOrphanToolMessages(optimizedMessages);
    const coreMessages = this.convertMessages(filteredMessages);
    const coreTools = this.convertTools(tools);
    const experimentalOutput = this.convertOutputFormat(this.config.outputFormat);
    return { coreMessages, coreTools, experimentalOutput };
  }

  private extractToolCalls(result: RawToolCallResult): RawToolCall[] | undefined {
    if (result.toolCalls && result.toolCalls.length > 0) return result.toolCalls;
    if (result.tool_calls && result.tool_calls.length > 0) return result.tool_calls;
    if (result.message?.toolCalls && result.message.toolCalls.length > 0)
      return result.message.toolCalls;
    if (result.message?.tool_calls && result.message.tool_calls.length > 0)
      return result.message.tool_calls;
    const choiceToolCalls = result.choices?.flatMap(
      (choice) => choice.message?.toolCalls ?? choice.message?.tool_calls ?? [],
    );
    if (choiceToolCalls && choiceToolCalls.length > 0) return choiceToolCalls;
    const stepToolCalls = result.steps?.flatMap((step) => step.toolCalls ?? step.tool_calls ?? []);
    return stepToolCalls && stepToolCalls.length > 0 ? stepToolCalls : undefined;
  }

  private buildChatResponse(result: {
    text: string;
    toolCalls?: RawToolCall[];
    tool_calls?: RawToolCall[];
    message?: RawToolCallResult['message'];
    choices?: RawToolCallResult['choices'];
    steps?: RawToolCallResult['steps'];
    reasoning?: Array<{ text: string }>;
    usage?: {
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
      outputTokenDetails?: {
        textTokens?: number;
        reasoningTokens?: number;
      };
      reasoningTokens?: number;
      cachedInputTokens?: number;
      billableInputTokens?: number;
      cacheMissInputTokens?: number;
    };
    providerMetadata?: {
      anthropic?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
      deepseek?: { promptCacheHitTokens?: number; promptCacheMissTokens?: number };
    };
  }): ModelResponse {
    const rawToolCalls = this.extractToolCalls(result);
    const toolCalls =
      rawToolCalls && rawToolCalls.length > 0 ? this.convertToolCalls(rawToolCalls) : undefined;

    const reasoningText = Array.isArray(result.reasoning)
      ? result.reasoning.map((r) => r.text).join('')
      : (result as { reasoningText?: string }).reasoningText;

    return {
      content: result.text,
      reasoningContent: reasoningText,
      toolCalls,
      usage: this.convertUsage(
        result.usage,
        result.providerMetadata as {
          anthropic?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
          deepseek?: { promptCacheHitTokens?: number; promptCacheMissTokens?: number };
        },
      ),
    };
  }

  async chat(
    messages: readonly ModelMessage[],
    tools?: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    return consumeRetryGenerator(this.chatWithRetryEvents(messages, tools, signal), this.logger);
  }

  async sideQuery(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
    options?: ModelSideQueryOptions,
  ): Promise<ModelResponse> {
    await this.initialized;
    const startTime = Date.now();
    this.logger.debug('🚀 [VercelAIModelService] Starting side query request');

    const { coreMessages, experimentalOutput } = this.prepareRequest(messages);
    const retryConfig = {
      ...this.retryConfig,
      querySource: options?.querySource ?? 'side_question',
    };

    try {
      const gen = withRetry(
        (ctx: RetryContext) =>
          generateText({
            model: this.model,
            messages: coreMessages as never,
            maxOutputTokens:
              ctx.maxTokensOverride ?? options?.maxOutputTokens ?? this.config.maxOutputTokens,
            temperature: this.getTemperatureOverride(
              options?.temperature ?? this.config.temperature ?? 0,
            ),
            abortSignal: signal,
            experimental_output: experimentalOutput,
            providerOptions: this.getProviderOptions(),
          }),
        retryConfig,
        signal,
      );

      const result = await consumeRetryGenerator(gen, this.logger);

      const duration = Date.now() - startTime;
      this.logger.debug(
        '📥 [VercelAIModelService] Side query response received in',
        duration,
        'ms',
      );
      return this.buildChatResponse(result);
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('❌ [VercelAIModelService] Side query failed after', duration, 'ms');
      throw error;
    }
  }

  /**
   * chat 的 AsyncGenerator 版本 — 暴露 retry 事件
   *
   * yield: ModelRetryEvent（重试过程中的事件）
   * return: ModelResponse
   */
  async *chatWithRetryEvents(
    messages: readonly ModelMessage[],
    tools?: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelRetryEvent, ModelResponse> {
    await this.initialized;
    const startTime = Date.now();
    this.logger.debug('🚀 [VercelAIModelService] Starting chat request (with retry events)');

    const { coreMessages, coreTools, experimentalOutput } = this.prepareRequest(messages, tools);

    try {
      const gen = withRetry(
        (ctx: RetryContext) =>
          generateText({
            model: this.model,
            messages: coreMessages as never,
            tools: coreTools as never,
            maxOutputTokens: ctx.maxTokensOverride ?? this.config.maxOutputTokens,
            temperature: this.getTemperatureOverride(this.config.temperature ?? 0),
            abortSignal: signal,
            experimental_output: experimentalOutput,
            providerOptions: this.getProviderOptions(),
          }),
        this.retryConfig,
        signal,
      );

      // Forward all retry events to caller, then return the result
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          const duration = Date.now() - startTime;
          this.logger.debug('📥 [VercelAIModelService] Response received in', duration, 'ms');
          return this.buildChatResponse(value);
        }
        yield value;
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('❌ [VercelAIModelService] Chat failed after', duration, 'ms');
      throw error;
    }
  }

  async *streamChat(
    messages: readonly ModelMessage[],
    tools?: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelStreamChunk, void, unknown> {
    await this.initialized;
    const startTime = Date.now();
    this.logger.debug('🚀 [VercelAIModelService] Starting stream request');

    const { coreMessages, coreTools, experimentalOutput } = this.prepareRequest(messages, tools);

    try {
      const gen = withRetry(
        (ctx: RetryContext) =>
          Promise.resolve(
            streamText({
              model: this.model,
              messages: coreMessages as never,
              tools: coreTools as never,
              maxOutputTokens: ctx.maxTokensOverride ?? this.config.maxOutputTokens,
              temperature: this.getTemperatureOverride(this.config.temperature ?? 0),
              abortSignal: signal,
              experimental_output: experimentalOutput,
              providerOptions: this.getProviderOptions(),
            }),
          ),
        this.retryConfig,
        signal,
      );

      const result = await consumeRetryGenerator(gen, this.logger);

      this.logger.debug('📥 [VercelAIModelService] Stream started');

      let toolCallIndex = 0;
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta': {
            const delta = getStreamTextDelta(part);
            if (delta !== undefined) {
              yield { content: delta };
            }
            break;
          }

          case 'reasoning-delta': {
            const delta = getStreamTextDelta(part);
            if (delta !== undefined) {
              yield { reasoningContent: delta };
            }
            break;
          }

          case 'tool-call': {
            const toolCall = getDeepSeekStreamToolCall(part, toolCallIndex);
            yield {
              toolCalls: [
                {
                  index: toolCallIndex++,
                  ...toolCall,
                },
              ],
            };
            break;
          }

          case 'finish':
            yield {
              finishReason: (part as { finishReason?: string }).finishReason,
              usage: this.convertUsage(
                (
                  part as {
                    totalUsage?: Parameters<VercelAIModelService['convertUsage']>[0];
                  }
                ).totalUsage,
                (
                  part as {
                    providerMetadata?: {
                      anthropic?: {
                        cacheCreationInputTokens?: number;
                        cacheReadInputTokens?: number;
                      };
                      deepseek?: { promptCacheHitTokens?: number; promptCacheMissTokens?: number };
                    };
                  }
                ).providerMetadata,
              ),
            };
            break;
        }
      }

      const duration = Date.now() - startTime;
      this.logger.debug('✅ [VercelAIModelService] Stream completed in', duration, 'ms');
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('❌ [VercelAIModelService] Stream failed after', duration, 'ms');
      throw error;
    }
  }

  getConfig(): ModelServiceConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ModelServiceConfig>): void {
    this.logger.debug('🔄 [VercelAIModelService] Updating configuration');
    this.config = { ...this.config, ...newConfig };
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    this.initialized = this.initModel(this.config);
    this.logger.debug('✅ [VercelAIModelService] Configuration updated');
  }
}
