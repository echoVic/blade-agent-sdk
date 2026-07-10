import {
  createOpenAICompatibleModelPort,
} from '@blade-ai/ai/providers/openai-compatible';
import { createVercelModelPort } from '@blade-ai/ai/providers/vercel';
import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
} from '@blade-ai/ai/model';
import type { JSONSchema7 } from 'json-schema';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { JsonObject, JsonValue } from '../types/common.js';
import type {
  ChatConfig,
  ChatResponse,
  ContentPart,
  IChatService,
  Message,
  SideQueryOptions,
  StreamChunk,
  ToolCall,
} from '@blade-ai/ai/chat';
import {
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
  type RetryContext,
  type RetryEvent,
  withRetry,
} from '../services/RetryPolicy.js';
import {
  optimizeDeepSeekCachePrefix,
  shouldOmitDeepSeekSamplingOptions,
} from '@blade-ai/ai/deepseek';

function filterOrphanToolMessages(messages: readonly Message[]): Message[] {
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

function filterDeepSeekToolContext(messages: readonly Message[]): Message[] {
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

function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function safeJsonParse(
  str: string,
  logger: InternalLogger,
  fallback: JsonValue = {},
): JsonValue {
  try {
    return JSON.parse(str) as JsonValue;
  } catch {
    logger.warn('⚠️ [VercelAIChatService] Failed to parse JSON, using fallback', { str });
    return fallback;
  }
}

/**
 * 消费 withRetry AsyncGenerator，收集 RetryEvent 并返回结果
 */
async function consumeRetryGenerator<T>(
  gen: AsyncGenerator<RetryEvent, T>,
  logger: InternalLogger,
): Promise<T> {
  while (true) {
    const { value, done } = await gen.next();
    if (done) return value;
    // RetryEvent — log it
    const event = value as RetryEvent;
    logger.warn(
      `🔄 [RetryPolicy] Attempt ${event.attempt}/${event.maxRetries}, ` +
      `delay ${event.delayMs}ms, error: ${event.error.status ?? 'unknown'} ${event.error.message}`,
    );
  }
}

export class VercelAIChatService implements IChatService {
  private modelPort?: ModelPort;
  private config: ChatConfig;
  private initialized: Promise<void>;
  private readonly logger: InternalLogger;
  private retryConfig: RetryConfig;

  constructor(config: ChatConfig, logger: InternalLogger = NOOP_LOGGER) {
    this.config = config;
    this.logger = logger.child(LogCategory.CHAT);
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config.retry, currentModel: config.model };
    this.initialized = this.initModel(config);
  }

  async ready(): Promise<void> {
    await this.initialized;
  }

  private async initModel(config: ChatConfig): Promise<void> {
    this.modelPort = undefined;
    if (this.shouldUseModelPort(config)) {
      this.modelPort = createOpenAICompatibleModelPort({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        headers: config.customHeaders,
        model: config.model,
        name: config.providerId || 'openai-compatible',
      });
      this.logger.debug('🚀 [VercelAIChatService] Initialized with AI ModelPort', {
        provider: config.provider,
        model: config.model,
        providerId: config.providerId,
      });
      return;
    }

    this.modelPort = this.createModelPort(config);
    this.logger.debug('🚀 [VercelAIChatService] Initialized with AI Vercel ModelPort', {
      provider: config.provider,
      model: config.model,
      providerId: config.providerId,
    });
  }

  private shouldUseModelPort(config: ChatConfig): boolean {
    return config.provider === 'openai-compatible' && config.providerId !== 'deepseek';
  }

  private getModelPort(): ModelPort {
    if (!this.modelPort) {
      throw new Error('Model port is not initialized for this provider');
    }
    return this.modelPort;
  }

  private createModelPort(config: ChatConfig): ModelPort {
    return createVercelModelPort({
      provider: config.provider,
      providerId: config.providerId,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      headers: config.customHeaders,
      apiVersion: config.apiVersion,
      providerOptions: config.providerOptions as JsonObject | undefined,
      supportsThinking: config.supportsThinking,
    });
  }

  private isDeepSeekProvider(): boolean {
    return this.config.provider === 'deepseek' || this.config.providerId === 'deepseek';
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
    messages: readonly Message[],
  ) {
    const optimizedMessages = this.isDeepSeekProvider()
      ? optimizeDeepSeekCachePrefix(messages, this.config.providerOptions?.deepseek?.cacheOptimization)
      : messages;
    const filteredMessages = this.isDeepSeekProvider()
      ? filterDeepSeekToolContext(optimizedMessages)
      : filterOrphanToolMessages(optimizedMessages);
    return { filteredMessages };
  }

  private buildModelPortRequest(
    messages: readonly Message[],
    tools?: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal?: AbortSignal,
    overrides: {
      maxOutputTokens?: number;
      temperature?: number;
    } = {},
  ): ModelRequest {
    const filteredMessages = filterOrphanToolMessages(messages);
    return {
      provider: this.config.provider,
      model: this.config.model,
      messages: filteredMessages.map((message) => ({
        role: message.role,
        content: getTextContent(message.content),
        ...(
          message.reasoningContent && (!this.isDeepSeekProvider() || message.tool_calls?.length)
            ? { reasoningContent: message.reasoningContent }
            : {}
        ),
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
        ...(message.tool_calls && message.tool_calls.length > 0
          ? { toolCalls: message.tool_calls.map((toolCall) => this.chatToolCallToModelToolCall(toolCall)) }
          : {}),
        ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
      })),
      tools: tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as JsonObject,
      })),
      maxOutputTokens: overrides.maxOutputTokens ?? this.config.maxOutputTokens,
      temperature: this.getTemperatureOverride(overrides.temperature ?? this.config.temperature),
      maxContextTokens: this.config.maxContextTokens,
      outputFormat: this.config.outputFormat
        ? {
            ...this.config.outputFormat,
            json_schema: {
              ...this.config.outputFormat.json_schema,
              schema: this.config.outputFormat.json_schema.schema as unknown as JsonObject,
            },
          }
        : undefined,
      providerOptions: this.config.providerOptions as JsonObject | undefined,
      signal,
    };
  }

  private chatToolCallToModelToolCall(toolCall: ToolCall): ModelToolCall {
    return {
      id: toolCall.id,
      name: toolCall.function.name,
      input: this.toJsonObject(safeJsonParse(toolCall.function.arguments || '{}', this.logger, {})),
    };
  }

  private toJsonObject(value: JsonValue): JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as JsonObject;
  }

  private modelResponseToChatResponse(response: ModelResponse): ChatResponse {
    return {
      content: response.content,
      reasoningContent: response.reasoningContent,
      toolCalls: this.modelToolCallsToChatToolCalls(response.toolCalls),
      usage: response.usage,
    };
  }

  private modelToolCallsToChatToolCalls(toolCalls: ModelToolCall[] | undefined): ToolCall[] | undefined {
    if (!toolCalls || toolCalls.length === 0) return undefined;
    return toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.input ?? {}),
      },
    }));
  }

  private modelStreamEventToChunk(
    event: ModelStreamEvent,
    toolCallIndex: number,
  ): { chunk?: StreamChunk; nextToolCallIndex: number } {
    switch (event.type) {
      case 'content_delta':
        return { chunk: { content: event.delta }, nextToolCallIndex: toolCallIndex };
      case 'reasoning_delta':
        return { chunk: { reasoningContent: event.delta }, nextToolCallIndex: toolCallIndex };
      case 'tool_call': {
        const chatToolCall = this.modelToolCallsToChatToolCalls([event.toolCall])?.[0];
        if (!chatToolCall) return { nextToolCallIndex: toolCallIndex };
        return {
          chunk: {
            toolCalls: [
              {
                index: toolCallIndex,
                ...chatToolCall,
              },
            ],
          },
          nextToolCallIndex: toolCallIndex + 1,
        };
      }
      case 'usage':
        return { chunk: { usage: event.usage }, nextToolCallIndex: toolCallIndex };
      case 'done':
        return { chunk: { finishReason: event.finishReason }, nextToolCallIndex: toolCallIndex };
      case 'error':
        throw event.error;
    }
    return { nextToolCallIndex: toolCallIndex };
  }

  async chat(
    messages: readonly Message[],
    tools?: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    await this.initialized;
    const startTime = Date.now();
    this.logger.debug('🚀 [VercelAIChatService] Starting chat request');

    const { filteredMessages } = this.prepareRequest(messages);

    try {
      const gen = withRetry(
        (ctx: RetryContext) =>
          this.getModelPort().generate(this.buildModelPortRequest(filteredMessages, tools, signal, {
            maxOutputTokens: ctx.maxTokensOverride ?? this.config.maxOutputTokens,
            temperature: this.config.temperature ?? 0,
          })),
        this.retryConfig,
        signal,
      );

      const result = await consumeRetryGenerator(gen, this.logger);

      const duration = Date.now() - startTime;
      this.logger.debug('📥 [VercelAIChatService] Response received in', duration, 'ms');

      return this.modelResponseToChatResponse(result);
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('❌ [VercelAIChatService] Chat failed after', duration, 'ms');
      throw error;
    }
  }

  async sideQuery(
    messages: readonly Message[],
    signal?: AbortSignal,
    options?: SideQueryOptions,
  ): Promise<ChatResponse> {
    await this.initialized;
    const startTime = Date.now();
    this.logger.debug('🚀 [VercelAIChatService] Starting side query request');

    const { filteredMessages } = this.prepareRequest(messages);
    const retryConfig = {
      ...this.retryConfig,
      querySource: options?.querySource ?? 'side_question',
    };

    try {
      const gen = withRetry(
        (ctx: RetryContext) =>
          this.getModelPort().generate(this.buildModelPortRequest(filteredMessages, undefined, signal, {
            maxOutputTokens: ctx.maxTokensOverride
              ?? options?.maxOutputTokens
              ?? this.config.maxOutputTokens,
            temperature: options?.temperature ?? this.config.temperature ?? 0,
          })),
        retryConfig,
        signal,
      );

      const result = await consumeRetryGenerator(gen, this.logger);

      const duration = Date.now() - startTime;
      this.logger.debug('📥 [VercelAIChatService] Side query response received in', duration, 'ms');
      return this.modelResponseToChatResponse(result);
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('❌ [VercelAIChatService] Side query failed after', duration, 'ms');
      throw error;
    }
  }

  /**
   * chat 的 AsyncGenerator 版本 — 暴露 retry 事件
   *
   * yield: RetryEvent（重试过程中的事件）
   * return: ChatResponse
   */
  async *chatWithRetryEvents(
    messages: readonly Message[],
    tools?: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal?: AbortSignal
  ): AsyncGenerator<RetryEvent, ChatResponse> {
    await this.initialized;
    const startTime = Date.now();
    this.logger.debug('🚀 [VercelAIChatService] Starting chat request (with retry events)');

    const { filteredMessages } = this.prepareRequest(messages);

    try {
      const gen = withRetry(
        (ctx: RetryContext) =>
          this.getModelPort().generate(this.buildModelPortRequest(filteredMessages, tools, signal, {
            maxOutputTokens: ctx.maxTokensOverride ?? this.config.maxOutputTokens,
            temperature: this.config.temperature ?? 0,
          })),
        this.retryConfig,
        signal,
      );

      // Forward all retry events to caller, then return the result
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          const duration = Date.now() - startTime;
          this.logger.debug('📥 [VercelAIChatService] Response received in', duration, 'ms');
          return this.modelResponseToChatResponse(value);
        }
        yield value;
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('❌ [VercelAIChatService] Chat failed after', duration, 'ms');
      throw error;
    }
  }

  async *streamChat(
    messages: readonly Message[],
    tools?: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    await this.initialized;
    const startTime = Date.now();
    this.logger.debug('🚀 [VercelAIChatService] Starting stream request');

    const { filteredMessages } = this.prepareRequest(messages);

    try {
      const gen = withRetry(
        (ctx: RetryContext) =>
          Promise.resolve(this.getModelPort().stream(this.buildModelPortRequest(filteredMessages, tools, signal, {
            maxOutputTokens: ctx.maxTokensOverride ?? this.config.maxOutputTokens,
            temperature: this.config.temperature ?? 0,
          }))),
        this.retryConfig,
        signal,
      );

      const result = await consumeRetryGenerator(gen, this.logger);

      this.logger.debug('📥 [VercelAIChatService] Stream started');

      let toolCallIndex = 0;
      for await (const event of result) {
        const { chunk, nextToolCallIndex } = this.modelStreamEventToChunk(event, toolCallIndex);
        toolCallIndex = nextToolCallIndex;
        if (chunk) yield chunk;
      }

      const duration = Date.now() - startTime;
      this.logger.debug('✅ [VercelAIChatService] Stream completed in', duration, 'ms');
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('❌ [VercelAIChatService] Stream failed after', duration, 'ms');
      throw error;
    }
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    this.logger.debug('🔄 [VercelAIChatService] Updating configuration');
    this.config = { ...this.config, ...newConfig };
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    this.initialized = this.initModel(this.config);
    this.logger.debug('✅ [VercelAIChatService] Configuration updated');
  }
}
