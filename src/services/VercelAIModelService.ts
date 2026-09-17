import { generateText, type LanguageModel, streamText } from 'ai';
import { ModelStreamError } from '../errors/ModelStreamError.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { ModelServiceConfig } from '../model/config.js';
import type { ModelMessage } from '../model/message.js';
import type { ModelRetryConfig, ModelRetryEvent } from '../model/retry.js';
import type {
  ModelResponse,
  ModelService,
  ModelSideQueryOptions,
  ModelStreamChunk,
  ModelToolDefinition,
} from '../model/service.js';
import {
  buildModelResponse,
  convertUsage,
  normalizeToolCall,
  type PreparedModelRequest,
  prepareModelRequest,
  providerOptions,
  type RawModelResult,
  samplingTemperature,
} from './modelAdapter.js';
import { createBuiltinModel } from './modelProvider.js';
import { DEFAULT_RETRY_CONFIG, type RetryContext, withRetry } from './RetryPolicy.js';

type StreamPart = Record<string, unknown> & { type?: string };
interface StreamAttempt {
  first: IteratorResult<StreamPart>;
  parts: AsyncIterator<StreamPart>;
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

  async chat(
    messages: readonly ModelMessage[],
    tools?: readonly ModelToolDefinition[],
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    return consumeRetryEvents(this.chatWithRetryEvents(messages, tools, signal), this.logger);
  }

  async sideQuery(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
    options?: ModelSideQueryOptions,
  ): Promise<ModelResponse> {
    await this.initialized;
    const request = prepareModelRequest(this.config, this.logger, messages);
    const retry = withRetry(
      (context) =>
        this.generate(request, context, signal, {
          maxOutputTokens: options?.maxOutputTokens,
          temperature: options?.temperature ?? 0,
        }),
      { ...this.retryConfig, querySource: options?.querySource ?? 'side_question' },
      signal,
    );
    return buildModelResponse(this.config, await consumeRetryEvents(retry, this.logger));
  }

  async *chatWithRetryEvents(
    messages: readonly ModelMessage[],
    tools?: readonly ModelToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<ModelRetryEvent, ModelResponse> {
    await this.initialized;
    const request = prepareModelRequest(this.config, this.logger, messages, tools);
    const retry = withRetry(
      (context) => this.generate(request, context, signal),
      this.retryConfig,
      signal,
    );
    while (true) {
      const step = await retry.next();
      if (step.done) return buildModelResponse(this.config, step.value);
      yield step.value;
    }
  }

  async *streamChat(
    messages: readonly ModelMessage[],
    tools?: readonly ModelToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<ModelStreamChunk, void, unknown> {
    await this.initialized;
    const request = prepareModelRequest(this.config, this.logger, messages, tools);
    const attempt = await consumeRetryEvents(
      withRetry(
        (context) => this.openStreamAttempt(request, context, signal),
        this.retryConfig,
        signal,
      ),
      this.logger,
    );

    let index = 0;
    let part = attempt.first;
    try {
      while (!part.done) {
        const value = part.value;
        if (value.type === 'text-delta') {
          const content = textDelta(value);
          if (content !== undefined) yield { content };
        } else if (value.type === 'reasoning-delta') {
          const reasoningContent = textDelta(value);
          if (reasoningContent !== undefined) yield { reasoningContent };
        } else if (value.type === 'tool-call') {
          yield { toolCalls: [{ index, ...normalizeToolCall(value, index++) }] };
        } else if (value.type === 'finish') {
          const finish = value as {
            finishReason?: string;
            totalUsage?: Parameters<typeof convertUsage>[1];
            providerMetadata?: Parameters<typeof convertUsage>[2];
          };
          yield {
            finishReason: finish.finishReason,
            usage: convertUsage(this.config, finish.totalUsage, finish.providerMetadata),
          };
        } else if (value.type === 'error') {
          throw streamError(value);
        }
        part = await attempt.parts.next();
      }
    } finally {
      await attempt.parts.return?.().catch(() => undefined);
    }
  }

  getConfig(): ModelServiceConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ModelServiceConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    this.initialized = this.initModel(this.config);
  }

  private async initModel(config: ModelServiceConfig): Promise<void> {
    this.model = await createBuiltinModel(config);
    this.logger.debug('Vercel AI model initialized', {
      provider: config.provider,
      model: config.model,
      providerId: config.providerId,
    });
  }

  private generate(
    request: PreparedModelRequest,
    context: RetryContext,
    signal?: AbortSignal,
    overrides: { maxOutputTokens?: number; temperature?: number } = {},
  ): Promise<RawModelResult> {
    return generateText({
      ...this.requestOptions(request, context, signal, overrides),
      tools: request.coreTools as never,
    }) as Promise<RawModelResult>;
  }

  private requestOptions(
    request: PreparedModelRequest,
    context: RetryContext,
    signal?: AbortSignal,
    overrides: { maxOutputTokens?: number; temperature?: number } = {},
  ) {
    return {
      model: this.model,
      messages: request.coreMessages as never,
      maxOutputTokens:
        context.maxTokensOverride ?? overrides.maxOutputTokens ?? this.config.maxOutputTokens,
      temperature: samplingTemperature(
        this.config,
        overrides.temperature ?? this.config.temperature ?? 0,
      ),
      abortSignal: signal,
      experimental_output: request.experimentalOutput,
      providerOptions: providerOptions(this.config),
      maxRetries: 0,
    };
  }

  private async openStreamAttempt(
    request: PreparedModelRequest,
    context: RetryContext,
    signal?: AbortSignal,
  ): Promise<StreamAttempt> {
    const result = streamText({
      ...this.requestOptions(request, context, signal),
      tools: request.coreTools as never,
    });
    const parts = result.fullStream[Symbol.asyncIterator]() as AsyncIterator<StreamPart>;
    try {
      while (true) {
        const first = await parts.next();
        if (first.done || isOutputPart(first.value.type)) return { first, parts };
        if (first.value.type === 'error') throw streamError(first.value);
      }
    } catch (error) {
      await closeStream(parts, this.logger);
      throw error;
    }
  }
}

async function consumeRetryEvents<T>(
  retries: AsyncGenerator<ModelRetryEvent, T>,
  logger: InternalLogger,
): Promise<T> {
  while (true) {
    const step = await retries.next();
    if (step.done) return step.value;
    logger.warn(
      `Model retry ${step.value.attempt}/${step.value.maxRetries} in ${step.value.delayMs}ms: ${step.value.error.message}`,
    );
  }
}

function isOutputPart(type: string | undefined): boolean {
  return ['text-delta', 'reasoning-delta', 'tool-call', 'finish'].includes(type ?? '');
}

function textDelta(part: StreamPart): string | undefined {
  const value = part as { text?: string; textDelta?: string; delta?: string };
  return value.text ?? value.textDelta ?? value.delta;
}

function streamError(part: StreamPart): Error {
  const cause = part.error;
  const message =
    (typeof part.errorText === 'string' ? part.errorText : errorMessage(cause)) ??
    'The model stream reported an error';
  const error = new ModelStreamError(message, cause === undefined ? undefined : { cause }) as
    | ModelStreamError
    | (ModelStreamError & { statusCode?: number });
  const statusCode = errorStatusCode(cause);
  if (statusCode !== undefined) Object.assign(error, { statusCode });
  return error;
}

async function closeStream(
  parts: AsyncIterator<StreamPart>,
  logger: InternalLogger,
): Promise<void> {
  if (!parts.return) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(parts.return(undefined)).catch((error) => {
        logger.debug('Failed to close a failed model stream attempt:', error);
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorStatusCode(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { status, statusCode } = value as { status?: unknown; statusCode?: unknown };
  const code = status ?? statusCode;
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (!value || typeof value !== 'object') return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}
