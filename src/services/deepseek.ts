import type { JSONSchema7 } from 'json-schema';
import type { JsonObject, JsonValue, ModelConfig } from '../types/common.js';
import type { ProviderOptions, UsageInfo } from './ChatServiceInterface.js';

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
};

const DEEPSEEK_MODEL_ALIASES: Record<string, string> = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
};

export interface DeepSeekProviderOptions {
  thinking?: {
    type?: 'enabled' | 'disabled';
  };
  strictTools?: boolean;
}

export interface DeepSeekPricing {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
  reasoningOutput?: number;
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

function toOptionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
