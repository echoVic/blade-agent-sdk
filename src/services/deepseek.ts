import type { JSONSchema7 } from 'json-schema';
import type { JsonObject, JsonValue, ModelConfig } from '../types/common.js';
import type { Message, ProviderOptions, UsageInfo } from './ChatServiceInterface.js';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_BETA_BASE_URL = 'https://api.deepseek.com/beta';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro';

/**
 * Published DeepSeek chat pricing as per-token USD rates.
 *
 * Values are expressed per token rather than per 1M tokens so they can be
 * passed directly to TokenBudget. Keep this table configurable at call sites:
 * provider prices can change independently of SDK releases.
 */
export const DEEPSEEK_DEFAULT_PRICING: Record<string, DeepSeekPricing> = {
  'deepseek-v4-flash': {
    inputCacheHit: 0.0028 / 1_000_000,
    inputCacheMiss: 0.14 / 1_000_000,
    output: 0.28 / 1_000_000,
  },
  'deepseek-v4-pro': {
    inputCacheHit: 0.003625 / 1_000_000,
    inputCacheMiss: 0.435 / 1_000_000,
    output: 0.87 / 1_000_000,
  },
  'deepseek-r1': {
    inputCacheHit: 0.14 / 1_000_000,
    inputCacheMiss: 0.55 / 1_000_000,
    output: 2.19 / 1_000_000,
  },
};

const DEEPSEEK_MODEL_ALIASES: Record<string, string> = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
  'deepseek-r1-0528': 'deepseek-r1',
};

export interface DeepSeekProviderOptions {
  thinking?: {
    type?: 'enabled' | 'disabled';
  };
  strictTools?: boolean;
  cacheOptimization?: DeepSeekCacheOptimizationOptions;
}

export interface DeepSeekPricing {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
  reasoningOutput?: number;
}

export interface DeepSeekCostBreakdown {
  model: string;
  inputCacheHitTokens: number;
  inputCacheMissTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  inputCacheHitCost: number;
  inputCacheMissCost: number;
  outputCost: number;
  reasoningOutputCost: number;
  totalCost: number;
  currency: 'USD';
}

export interface DeepSeekCacheOptimizationOptions {
  enabled?: boolean;
  stableMetadataKey?: string;
  stableMetadataValue?: JsonValue;
}

export interface DeepSeekLongContextChunk {
  id: string;
  index: number;
  content: string;
  estimatedTokens: number;
  contentHash: string;
  cacheKey: string;
}

export interface DeepSeekLongContextOptions {
  chunkTokenLimit?: number;
  reserveOutputTokens?: number;
  charsPerToken?: number;
  chunkPrefix?: string;
  maxContextTokens?: number;
  maxChunks?: number;
}

export interface DeepSeekLongContextPlan {
  chunks: DeepSeekLongContextChunk[];
  messages: DeepSeekChatMessage[];
  totalEstimatedTokens: number;
  includedEstimatedTokens: number;
  omittedEstimatedTokens: number;
  includedChunkCount: number;
  omittedChunkCount: number;
  maxContextTokens?: number;
  reserveOutputTokens: number;
}

export interface DeepSeekChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  metadata?: JsonValue;
}

export interface DeepSeekChatCompletionOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  messages: DeepSeekChatMessage[];
  cacheOptimization?: DeepSeekCacheOptimizationOptions;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream?: false;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface DeepSeekChatCompletionResponse {
  id?: string;
  model?: string;
  choices: Array<{
    message?: JsonObject;
    finish_reason?: string | null;
    index?: number;
  }>;
  usage?: UsageInfo;
  cost?: DeepSeekCostBreakdown;
  raw: JsonValue;
}

export interface DeepSeekBatchChatCompletionItem extends Omit<DeepSeekChatCompletionOptions, 'apiKey' | 'baseUrl' | 'headers' | 'signal'> {
  id: string;
}

export interface DeepSeekBatchChatCompletionOptions {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  concurrency?: number;
  cacheOptimization?: DeepSeekCacheOptimizationOptions;
  signal?: AbortSignal;
  requests: DeepSeekBatchChatCompletionItem[];
}

export interface DeepSeekBatchChatCompletionResult {
  id: string;
  response?: DeepSeekChatCompletionResponse;
  error?: Error;
}

export interface DeepSeekCostSnapshot {
  model: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  inputCacheHitTokens: number;
  inputCacheMissTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  cacheHitRate: number;
  inputCacheHitCost: number;
  inputCacheMissCost: number;
  outputCost: number;
  reasoningOutputCost: number;
  totalCost: number;
  currency: 'USD';
}

export interface DeepSeekBatchChatCompletionSummary extends DeepSeekCostSnapshot {
  successCount: number;
  errorCount: number;
}

export interface DeepSeekToolDefinition {
  name: string;
  description?: string;
  parameters: JSONSchema7;
  strict?: boolean;
}

export interface DeepSeekSerializedTool {
  type: 'function';
  function: DeepSeekToolDefinition;
}

export interface DeepSeekFimCompletionOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  prompt: string;
  suffix?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  stream?: false;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface DeepSeekFimCompletionResponse {
  id?: string;
  model?: string;
  choices: Array<{
    text?: string;
    finish_reason?: string | null;
    index?: number;
  }>;
  usage?: UsageInfo;
  raw: JsonValue;
}

type DeepSeekProviderMetadata = {
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
};

type AIUsage = {
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
  raw?: JsonObject;
};

const DEEPSEEK_SUPPORTED_STRING_FORMATS = new Set([
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);

const DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS = [
  'additionalItems',
  'contains',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'examples',
  'maxContains',
  'maxLength',
  'maxItems',
  'maxProperties',
  'minContains',
  'minLength',
  'minItems',
  'minProperties',
  'patternProperties',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
] as const;

export function normalizeDeepSeekModel(model?: string): string {
  if (!model) return DEEPSEEK_DEFAULT_MODEL;
  return DEEPSEEK_MODEL_ALIASES[model] ?? model;
}

export function getDeepSeekPricing(model?: string): DeepSeekPricing | undefined {
  return DEEPSEEK_DEFAULT_PRICING[normalizeDeepSeekModel(model)];
}

export function createDeepSeekTokenBudgetCostConfig(
  model?: string,
  pricing: DeepSeekPricing | undefined = getDeepSeekPricing(model),
): {
  costPerInputToken: number;
  costPerOutputToken: number;
  costPerCacheReadToken: number;
} | undefined {
  if (!pricing) return undefined;
  return {
    costPerInputToken: pricing.inputCacheMiss,
    costPerOutputToken: pricing.reasoningOutput ?? pricing.output,
    costPerCacheReadToken: pricing.inputCacheHit,
  };
}

export function calculateDeepSeekCost(
  usage: UsageInfo,
  model?: string,
  pricing: DeepSeekPricing | undefined = getDeepSeekPricing(model),
): DeepSeekCostBreakdown | undefined {
  if (!pricing) return undefined;

  const inputCacheHitTokens = usage.cacheReadInputTokens ?? 0;
  const inputCacheMissTokens = usage.cacheMissInputTokens
    ?? usage.billableInputTokens
    ?? Math.max((usage.promptTokens ?? 0) - inputCacheHitTokens, 0);
  const reasoningOutputTokens = usage.reasoningTokens ?? 0;
  const outputTokens = Math.max((usage.completionTokens ?? 0) - reasoningOutputTokens, 0);
  const inputCacheHitCost = inputCacheHitTokens * pricing.inputCacheHit;
  const inputCacheMissCost = inputCacheMissTokens * pricing.inputCacheMiss;
  const outputCost = outputTokens * pricing.output;
  const reasoningOutputCost = reasoningOutputTokens * (pricing.reasoningOutput ?? pricing.output);
  return {
    model: normalizeDeepSeekModel(model),
    inputCacheHitTokens,
    inputCacheMissTokens,
    outputTokens,
    reasoningOutputTokens,
    inputCacheHitCost,
    inputCacheMissCost,
    outputCost,
    reasoningOutputCost,
    totalCost: inputCacheHitCost + inputCacheMissCost + outputCost + reasoningOutputCost,
    currency: 'USD',
  };
}

export class DeepSeekCostTracker {
  private requestCount = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private inputCacheHitTokens = 0;
  private inputCacheMissTokens = 0;
  private outputTokens = 0;
  private reasoningOutputTokens = 0;
  private inputCacheHitCost = 0;
  private inputCacheMissCost = 0;
  private outputCost = 0;
  private reasoningOutputCost = 0;

  constructor(
    private readonly model: string = DEEPSEEK_DEFAULT_MODEL,
    private readonly pricing: DeepSeekPricing | undefined = getDeepSeekPricing(model),
  ) {}

  recordUsage(usage: UsageInfo): DeepSeekCostBreakdown | undefined {
    this.requestCount += 1;
    this.promptTokens += usage.promptTokens ?? 0;
    this.completionTokens += usage.completionTokens ?? 0;
    this.totalTokens += usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);

    const breakdown = calculateDeepSeekCost(usage, this.model, this.pricing);
    if (!breakdown) {
      const cacheHitTokens = usage.cacheReadInputTokens ?? 0;
      const cacheMissTokens = usage.cacheMissInputTokens
        ?? usage.billableInputTokens
        ?? Math.max((usage.promptTokens ?? 0) - cacheHitTokens, 0);
      const reasoningTokens = usage.reasoningTokens ?? 0;
      this.inputCacheHitTokens += cacheHitTokens;
      this.inputCacheMissTokens += cacheMissTokens;
      this.reasoningOutputTokens += reasoningTokens;
      this.outputTokens += Math.max((usage.completionTokens ?? 0) - reasoningTokens, 0);
      return undefined;
    }

    this.inputCacheHitTokens += breakdown.inputCacheHitTokens;
    this.inputCacheMissTokens += breakdown.inputCacheMissTokens;
    this.outputTokens += breakdown.outputTokens;
    this.reasoningOutputTokens += breakdown.reasoningOutputTokens;
    this.inputCacheHitCost += breakdown.inputCacheHitCost;
    this.inputCacheMissCost += breakdown.inputCacheMissCost;
    this.outputCost += breakdown.outputCost;
    this.reasoningOutputCost += breakdown.reasoningOutputCost;
    return breakdown;
  }

  recordResponse(response: Pick<DeepSeekChatCompletionResponse, 'usage'>): DeepSeekCostBreakdown | undefined {
    return response.usage ? this.recordUsage(response.usage) : undefined;
  }

  getSnapshot(): DeepSeekCostSnapshot {
    const cacheInputTokens = this.inputCacheHitTokens + this.inputCacheMissTokens;
    return {
      model: normalizeDeepSeekModel(this.model),
      requestCount: this.requestCount,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      inputCacheHitTokens: this.inputCacheHitTokens,
      inputCacheMissTokens: this.inputCacheMissTokens,
      outputTokens: this.outputTokens,
      reasoningOutputTokens: this.reasoningOutputTokens,
      cacheHitRate: cacheInputTokens === 0 ? 0 : this.inputCacheHitTokens / cacheInputTokens,
      inputCacheHitCost: this.inputCacheHitCost,
      inputCacheMissCost: this.inputCacheMissCost,
      outputCost: this.outputCost,
      reasoningOutputCost: this.reasoningOutputCost,
      totalCost: this.inputCacheHitCost
        + this.inputCacheMissCost
        + this.outputCost
        + this.reasoningOutputCost,
      currency: 'USD',
    };
  }

  reset(): void {
    this.requestCount = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.totalTokens = 0;
    this.inputCacheHitTokens = 0;
    this.inputCacheMissTokens = 0;
    this.outputTokens = 0;
    this.reasoningOutputTokens = 0;
    this.inputCacheHitCost = 0;
    this.inputCacheMissCost = 0;
    this.outputCost = 0;
    this.reasoningOutputCost = 0;
  }
}

export function resolveDeepSeekBaseUrl(baseUrl?: string, beta = false): string {
  if (baseUrl?.trim()) return baseUrl.replace(/\/$/, '');
  return beta ? DEEPSEEK_BETA_BASE_URL : DEEPSEEK_DEFAULT_BASE_URL;
}

export function shouldUseDeepSeekBetaBaseUrl(config: {
  provider: string;
  providerId?: string;
  deepseek?: DeepSeekProviderOptions;
}): boolean {
  if (config.provider !== 'deepseek' && config.providerId !== 'deepseek') return false;
  return Boolean(config.deepseek?.strictTools);
}

export function isDeepSeekReasoningModel(model: string): boolean {
  return /(^|[-_])reasoner($|[-_])|(^|[-_])r1($|[-_])/i.test(model);
}

export function buildDeepSeekProviderOptions(config: {
  model: string;
  supportsThinking?: boolean;
  deepseek?: DeepSeekProviderOptions;
}): ProviderOptions | undefined {
  const explicit = config.deepseek;
  const thinking = explicit?.thinking
    ?? (config.supportsThinking || isDeepSeekReasoningModel(config.model)
      ? { type: 'enabled' as const }
      : undefined);

  if (!thinking) return undefined;

  return {
    deepseek: {
      thinking,
    },
  };
}

export function shouldOmitDeepSeekSamplingOptions(config: {
  provider: string;
  providerId?: string;
  model: string;
  supportsThinking?: boolean;
  deepseek?: DeepSeekProviderOptions;
}): boolean {
  if (config.provider !== 'deepseek' && config.providerId !== 'deepseek') return false;
  const thinkingType = config.deepseek?.thinking?.type;
  if (thinkingType === 'disabled') return false;
  return thinkingType === 'enabled'
    || Boolean(config.supportsThinking)
    || isDeepSeekReasoningModel(config.model);
}

export function mergeDeepSeekUsage(
  usage?: AIUsage,
  providerMetadata?: { deepseek?: DeepSeekProviderMetadata },
): UsageInfo | undefined {
  if (!usage) return undefined;

  const prompt = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completion = usage.completionTokens ?? usage.outputTokens ?? 0;
  const result: UsageInfo = {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: usage.totalTokens ?? prompt + completion,
  };

  const cacheRead = usage.inputTokenDetails?.cacheReadTokens
    ?? usage.cachedInputTokens
    ?? providerMetadata?.deepseek?.promptCacheHitTokens;
  if (cacheRead !== undefined) {
    result.cacheReadInputTokens = cacheRead;
  }

  const cacheMiss = usage.inputTokenDetails?.noCacheTokens
    ?? providerMetadata?.deepseek?.promptCacheMissTokens;
  if (cacheMiss !== undefined) {
    result.cacheMissInputTokens = cacheMiss;
    result.billableInputTokens = cacheMiss;
  } else if (cacheRead !== undefined) {
    result.billableInputTokens = Math.max(prompt - cacheRead, 0);
  }

  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens;
  if (cacheWrite !== undefined) {
    result.cacheCreationInputTokens = cacheWrite;
  }

  const reasoning = usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens;
  if (reasoning !== undefined) {
    result.reasoningTokens = reasoning;
  }

  return result;
}

export function optimizeDeepSeekCachePrefix<T extends Message>(
  messages: readonly T[],
  options: DeepSeekCacheOptimizationOptions = {},
): T[] {
  if (options.enabled === false || messages.length < 2) return [...messages];

  const firstConversationIndex = messages.findIndex(
    (message) => message.role === 'assistant' || message.role === 'tool',
  );
  const prefixEnd = firstConversationIndex === -1 ? messages.length : firstConversationIndex;
  const prefix = messages.slice(0, prefixEnd);
  const tail = messages.slice(prefixEnd);
  const leadingSystems: T[] = [];
  let cursor = 0;
  while (cursor < prefix.length && prefix[cursor]?.role === 'system') {
    leadingSystems.push(prefix[cursor] as T);
    cursor += 1;
  }

  const remainingPrefix = prefix.slice(cursor);
  const stablePrefix = remainingPrefix.filter((message) => isDeepSeekStableCacheMessage(message, options));
  if (stablePrefix.length === 0) return [...messages];

  const volatilePrefix = remainingPrefix.filter((message) => !isDeepSeekStableCacheMessage(message, options));
  return [...leadingSystems, ...stablePrefix, ...volatilePrefix, ...tail];
}

function isDeepSeekStableCacheMessage(
  message: Message,
  options: DeepSeekCacheOptimizationOptions,
): boolean {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const key = options.stableMetadataKey ?? 'deepseekCache';
  const expectedValue = options.stableMetadataValue ?? 'stable';
  if ((metadata as JsonObject)[key] === expectedValue) return true;
  const deepseek = (metadata as JsonObject).deepseek;
  return Boolean(
    deepseek
    && typeof deepseek === 'object'
    && !Array.isArray(deepseek)
    && (deepseek as JsonObject).cache === 'stable',
  );
}

export function estimateDeepSeekTokens(text: string, charsPerToken = 4): number {
  return Math.ceil(text.length / Math.max(charsPerToken, 1));
}

export function createDeepSeekLongContextChunks(
  text: string,
  options: DeepSeekLongContextOptions = {},
): DeepSeekLongContextChunk[] {
  const charsPerToken = options.charsPerToken ?? 4;
  const chunkTokenLimit = Math.max(
    (options.chunkTokenLimit ?? 64_000) - (options.reserveOutputTokens ?? 0),
    1,
  );
  const chunkCharLimit = Math.max(chunkTokenLimit * charsPerToken, 1);
  const prefix = options.chunkPrefix ?? 'ctx';
  const chunks: DeepSeekLongContextChunk[] = [];

  for (let offset = 0; offset < text.length; offset += chunkCharLimit) {
    const content = text.slice(offset, offset + chunkCharLimit);
    chunks.push({
      id: `${prefix}_${chunks.length + 1}`,
      index: chunks.length,
      content,
      estimatedTokens: estimateDeepSeekTokens(content, charsPerToken),
      contentHash: hashDeepSeekChunkContent(content),
      cacheKey: `${prefix}:${chunks.length + 1}:${content.length}`,
    });
  }

  return chunks;
}

export function createDeepSeekLongContextPlan(
  text: string,
  options: DeepSeekLongContextOptions = {},
): DeepSeekLongContextPlan {
  const chunks = createDeepSeekLongContextChunks(text, {
    ...options,
    reserveOutputTokens: undefined,
  });
  const reserveOutputTokens = options.reserveOutputTokens ?? 0;
  const maxInputTokens = options.maxContextTokens === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(options.maxContextTokens - reserveOutputTokens, 1);
  const maxChunks = options.maxChunks ?? Number.POSITIVE_INFINITY;
  const includedChunks: DeepSeekLongContextChunk[] = [];
  let includedEstimatedTokens = 0;

  for (const chunk of chunks) {
    if (includedChunks.length >= maxChunks) break;
    if (includedEstimatedTokens + chunk.estimatedTokens > maxInputTokens) break;
    includedChunks.push(chunk);
    includedEstimatedTokens += chunk.estimatedTokens;
  }

  const totalEstimatedTokens = chunks.reduce((sum, chunk) => sum + chunk.estimatedTokens, 0);
  return {
    chunks,
    messages: includedChunks.map(deepSeekChunkToMessage),
    totalEstimatedTokens,
    includedEstimatedTokens,
    omittedEstimatedTokens: totalEstimatedTokens - includedEstimatedTokens,
    includedChunkCount: includedChunks.length,
    omittedChunkCount: chunks.length - includedChunks.length,
    maxContextTokens: options.maxContextTokens,
    reserveOutputTokens,
  };
}

export function createDeepSeekLongContextMessages(
  text: string,
  options: DeepSeekLongContextOptions = {},
): DeepSeekChatMessage[] {
  return createDeepSeekLongContextPlan(text, options).messages;
}

function deepSeekChunkToMessage(chunk: DeepSeekLongContextChunk): DeepSeekChatMessage {
  return {
    role: 'user',
    content: `<deepseek_context_chunk id="${chunk.id}" index="${chunk.index}">\n${chunk.content}\n</deepseek_context_chunk>`,
    metadata: {
      deepseekCache: 'stable',
      deepseek: {
        cache: 'stable',
        chunkId: chunk.id,
        cacheKey: chunk.cacheKey,
        contentHash: chunk.contentHash,
        estimatedTokens: chunk.estimatedTokens,
      },
    },
  };
}

function hashDeepSeekChunkContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function withDeepSeekDefaults(modelConfig: ModelConfig): ModelConfig {
  if (modelConfig.provider !== 'deepseek') return modelConfig;

  const isReasonerAlias = modelConfig.model === 'deepseek-reasoner';
  const strictTools = modelConfig.providerOptions?.deepseek
    && typeof modelConfig.providerOptions.deepseek === 'object'
    && !Array.isArray(modelConfig.providerOptions.deepseek)
    && 'strictTools' in modelConfig.providerOptions.deepseek
    ? Boolean(modelConfig.providerOptions.deepseek.strictTools)
    : false;
  return {
    ...modelConfig,
    model: normalizeDeepSeekModel(modelConfig.model),
    baseUrl: resolveDeepSeekBaseUrl(modelConfig.baseUrl, strictTools),
    maxContextTokens: modelConfig.maxContextTokens ?? 1_000_000,
    maxOutputTokens: modelConfig.maxOutputTokens ?? 384_000,
    temperature: modelConfig.temperature ?? 0.3,
    supportsThinking: modelConfig.supportsThinking ?? isReasonerAlias,
    thinkingEnabled: modelConfig.thinkingEnabled ?? isReasonerAlias,
  };
}

export function sanitizeDeepSeekStrictSchema(schema: JSONSchema7): JSONSchema7 {
  const rootSchema: JSONSchema7 = hasSchemaShape(schema)
    ? schema
    : { type: 'object' as const, properties: {} };
  return sanitizeDeepSeekSchemaNode(rootSchema) as JSONSchema7;
}

function hasSchemaShape(schema: JSONSchema7): boolean {
  return Boolean(
    schema.type
    || schema.properties
    || schema.items
    || schema.anyOf
    || schema.oneOf
    || schema.$ref
    || (schema as Record<string, unknown>).$def
    || schema.$defs
    || schema.definitions,
  );
}

function sanitizeDeepSeekSchemaNode(schema: JSONSchema7): JSONSchema7 {
  const result: JSONSchema7 = { ...schema };

  for (const keyword of DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS) {
    delete (result as Record<string, unknown>)[keyword];
  }

  if (
    typeof result.format === 'string'
    && !DEEPSEEK_SUPPORTED_STRING_FORMATS.has(result.format)
  ) {
    delete result.format;
  }

  if (Array.isArray(result.type)) {
    const supportedTypes = result.type.filter((typeName) => typeName !== 'null');
    if (supportedTypes.length === 1) {
      result.type = supportedTypes[0];
    } else if (supportedTypes.length > 1) {
      result.type = supportedTypes;
    } else {
      delete result.type;
    }
  }

  if (typeof result.additionalProperties === 'object' && result.additionalProperties !== null) {
    result.additionalProperties = sanitizeDeepSeekSchemaNode(result.additionalProperties as JSONSchema7);
  }

  if (result.items && !Array.isArray(result.items)) {
    result.items = sanitizeDeepSeekSchemaNode(result.items as JSONSchema7);
  }

  if (Array.isArray(result.anyOf)) {
    result.anyOf = result.anyOf.map((item) => sanitizeDeepSeekSchemaNode(item as JSONSchema7));
  }

  if (Array.isArray(result.oneOf)) {
    result.anyOf = result.anyOf ?? result.oneOf.map((item) => sanitizeDeepSeekSchemaNode(item as JSONSchema7));
    delete result.oneOf;
  }

  delete result.allOf;
  delete result.not;

  if (result.definitions) {
    result.definitions = Object.fromEntries(
      Object.entries(result.definitions).map(([key, value]) => [
        key,
        typeof value === 'boolean' ? value : sanitizeDeepSeekSchemaNode(value as JSONSchema7),
      ]),
    );
  }

  if (result.$defs) {
    result.$defs = Object.fromEntries(
      Object.entries(result.$defs).map(([key, value]) => [
        key,
        typeof value === 'boolean' ? value : sanitizeDeepSeekSchemaNode(value as JSONSchema7),
      ]),
    );
  }

  const legacyDefs = (result as Record<string, unknown>).$def;
  if (legacyDefs && typeof legacyDefs === 'object' && !Array.isArray(legacyDefs)) {
    (result as Record<string, unknown>).$def = Object.fromEntries(
      Object.entries(legacyDefs).map(([key, value]) => [
        key,
        typeof value === 'boolean' ? value : sanitizeDeepSeekSchemaNode(value as JSONSchema7),
      ]),
    );
  }

  const types = Array.isArray(result.type) ? result.type : result.type ? [result.type] : [];
  const isObject = types.includes('object') || Boolean(result.properties);
  if (!isObject || !result.properties) return result;

  const properties = Object.fromEntries(
    Object.entries(result.properties).map(([key, value]) => [
      key,
      typeof value === 'boolean' ? value : sanitizeDeepSeekSchemaNode(value as JSONSchema7),
    ]),
  );
  const required = Object.keys(properties);
  return {
    ...result,
    properties,
    required,
    additionalProperties: false,
  };
}

export function prepareDeepSeekTools(
  tools: Array<{ name: string; description: string; parameters: JSONSchema7 }> | undefined,
  options?: DeepSeekProviderOptions,
): DeepSeekToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((tool) => {
    const strict = Boolean(options?.strictTools);
    return {
      name: tool.name,
      description: tool.description,
      parameters: strict ? sanitizeDeepSeekStrictSchema(tool.parameters) : tool.parameters,
      ...(strict ? { strict: true } : {}),
    };
  });
}

export function serializeDeepSeekTools(
  tools: Array<{ name: string; description: string; parameters: JSONSchema7 }> | undefined,
  options?: DeepSeekProviderOptions,
): DeepSeekSerializedTool[] | undefined {
  const preparedTools = prepareDeepSeekTools(tools, options);
  if (!preparedTools) return undefined;

  return preparedTools.map((tool) => ({
    type: 'function',
    function: tool,
  }));
}

export async function createDeepSeekFimCompletion(
  options: DeepSeekFimCompletionOptions,
): Promise<DeepSeekFimCompletionResponse> {
  const url = `${resolveDeepSeekBaseUrl(options.baseUrl, true)}/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify({
      model: normalizeDeepSeekModel(options.model),
      prompt: options.prompt,
      suffix: options.suffix,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      stop: options.stop,
      stream: false,
    }),
    signal: options.signal,
  });

  const raw = await response.json().catch(() => ({})) as JsonObject;
  if (!response.ok) {
    const message = typeof raw.error === 'object' && raw.error !== null && 'message' in raw.error
      ? String((raw.error as JsonObject).message)
      : `DeepSeek FIM request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  const usage = raw.usage && typeof raw.usage === 'object'
    ? mergeDeepSeekUsage({
      promptTokens: Number((raw.usage as JsonObject).prompt_tokens ?? 0),
      completionTokens: Number((raw.usage as JsonObject).completion_tokens ?? 0),
      totalTokens: Number((raw.usage as JsonObject).total_tokens ?? 0),
      inputTokenDetails: {
        cacheReadTokens: toOptionalNumber((raw.usage as JsonObject).prompt_cache_hit_tokens),
        noCacheTokens: toOptionalNumber((raw.usage as JsonObject).prompt_cache_miss_tokens),
      },
      outputTokenDetails: {
        reasoningTokens: toOptionalNumber(
          ((raw.usage as JsonObject).completion_tokens_details as JsonObject | undefined)?.reasoning_tokens,
        ),
      },
    })
    : undefined;

  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    choices: Array.isArray(raw.choices)
      ? raw.choices.map((choice) => {
        const item = choice as JsonObject;
        return {
          text: typeof item.text === 'string' ? item.text : undefined,
          finish_reason: typeof item.finish_reason === 'string' ? item.finish_reason : null,
          index: typeof item.index === 'number' ? item.index : undefined,
        };
      })
      : [],
    usage,
    raw,
  };
}

export async function createDeepSeekChatCompletion(
  options: DeepSeekChatCompletionOptions,
): Promise<DeepSeekChatCompletionResponse> {
  const url = `${resolveDeepSeekBaseUrl(options.baseUrl)}/chat/completions`;
  const messages = optimizeDeepSeekCachePrefix(options.messages, options.cacheOptimization);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify({
      model: normalizeDeepSeekModel(options.model),
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      })),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      stream: false,
    }),
    signal: options.signal,
  });

  const raw = await response.json().catch(() => ({})) as JsonObject;
  if (!response.ok) {
    const message = typeof raw.error === 'object' && raw.error !== null && 'message' in raw.error
      ? String((raw.error as JsonObject).message)
      : `DeepSeek chat completion request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  const usage = parseDeepSeekRawUsage(raw.usage);
  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    choices: Array.isArray(raw.choices)
      ? raw.choices.map((choice) => {
        const item = choice as JsonObject;
        return {
          message: typeof item.message === 'object' && item.message !== null && !Array.isArray(item.message)
            ? item.message as JsonObject
            : undefined,
          finish_reason: typeof item.finish_reason === 'string' ? item.finish_reason : null,
          index: typeof item.index === 'number' ? item.index : undefined,
        };
      })
      : [],
    usage,
    cost: usage ? calculateDeepSeekCost(usage, options.model) : undefined,
    raw,
  };
}

export async function createDeepSeekBatchChatCompletions(
  options: DeepSeekBatchChatCompletionOptions,
): Promise<DeepSeekBatchChatCompletionResult[]> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const results = new Array<DeepSeekBatchChatCompletionResult>(options.requests.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < options.requests.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const request = options.requests[currentIndex];
      if (!request) continue;

      try {
        results[currentIndex] = {
          id: request.id,
          response: await createDeepSeekChatCompletion({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            cacheOptimization: options.cacheOptimization,
            headers: options.headers,
            signal: options.signal,
            ...request,
          }),
        };
      } catch (error) {
        results[currentIndex] = {
          id: request.id,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, options.requests.length) },
    () => worker(),
  ));
  return results;
}

export function summarizeDeepSeekBatchChatCompletions(
  results: readonly DeepSeekBatchChatCompletionResult[],
  model: string = DEEPSEEK_DEFAULT_MODEL,
  pricing: DeepSeekPricing | undefined = getDeepSeekPricing(model),
): DeepSeekBatchChatCompletionSummary {
  const tracker = new DeepSeekCostTracker(model, pricing);
  let successCount = 0;
  let errorCount = 0;

  for (const result of results) {
    if (result.response) {
      successCount += 1;
      tracker.recordResponse(result.response);
    } else if (result.error) {
      errorCount += 1;
    }
  }

  return {
    ...tracker.getSnapshot(),
    successCount,
    errorCount,
  };
}

function parseDeepSeekRawUsage(rawUsage: JsonValue | undefined): UsageInfo | undefined {
  if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) return undefined;
  const usage = rawUsage as JsonObject;
  return mergeDeepSeekUsage({
    promptTokens: Number(usage.prompt_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
    inputTokenDetails: {
      cacheReadTokens: toOptionalNumber(usage.prompt_cache_hit_tokens),
      noCacheTokens: toOptionalNumber(usage.prompt_cache_miss_tokens),
    },
    outputTokenDetails: {
      reasoningTokens: toOptionalNumber(
        (usage.completion_tokens_details as JsonObject | undefined)?.reasoning_tokens,
      ),
    },
  });
}

function toOptionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
