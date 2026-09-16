import type { JSONSchema7 } from 'json-schema';
import type { ModelConfig, ModelProviderOptions } from '../model/config.js';
import type { ModelMessage } from '../model/message.js';
import type { ModelToolDefinition } from '../model/service.js';
import type { ModelUsage } from '../model/usage.js';
import type { JsonObject } from '../types/json.js';

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

export interface DeepSeekCacheOptimizationOptions {
  enabled?: boolean;
}

export type DeepSeekToolDefinition = Omit<ModelToolDefinition, 'description'> & {
  description?: string;
  strict?: boolean;
};

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

const DEEPSEEK_SUPPORTED_STRING_FORMATS = new Set(['email', 'hostname', 'ipv4', 'ipv6', 'uuid']);

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

/**
 * Whether the model has server-side thinking/reasoning enabled by default.
 * DeepSeek V4 Pro enables thinking output at the API level even without
 * an explicit `thinking: { type: 'enabled' }` request. SDK must account
 * for this when managing token budgets.
 */
export function isDeepSeekThinkingDefaultModel(model: string): boolean {
  // Check original name first (e.g. 'deepseek-reasoner' matches reasoning pattern
  // even though it normalizes to 'deepseek-v4-flash' via alias table)
  if (isDeepSeekReasoningModel(model)) return true;
  const normalized = normalizeDeepSeekModel(model);
  return normalized === 'deepseek-v4-pro' || isDeepSeekReasoningModel(normalized);
}

export function buildDeepSeekProviderOptions(config: {
  model: string;
  supportsThinking?: boolean;
  deepseek?: DeepSeekProviderOptions;
}): ModelProviderOptions | undefined {
  const explicit = config.deepseek;
  const thinking =
    explicit?.thinking ??
    (config.supportsThinking || isDeepSeekThinkingDefaultModel(config.model)
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
  return (
    thinkingType === 'enabled' ||
    Boolean(config.supportsThinking) ||
    isDeepSeekThinkingDefaultModel(config.model)
  );
}

export function mergeDeepSeekUsage(
  usage?: AIUsage,
  providerMetadata?: { deepseek?: DeepSeekProviderMetadata },
): ModelUsage | undefined {
  if (!usage) return undefined;

  const prompt = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completion = usage.completionTokens ?? usage.outputTokens ?? 0;
  const result: ModelUsage = {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: usage.totalTokens ?? prompt + completion,
  };

  const cacheRead =
    usage.inputTokenDetails?.cacheReadTokens ??
    usage.cachedInputTokens ??
    providerMetadata?.deepseek?.promptCacheHitTokens;
  if (cacheRead !== undefined) {
    result.cacheReadInputTokens = cacheRead;
  }

  const cacheMiss =
    usage.inputTokenDetails?.noCacheTokens ?? providerMetadata?.deepseek?.promptCacheMissTokens;
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

export function optimizeDeepSeekCachePrefix<T extends ModelMessage>(
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
  const stablePrefix = remainingPrefix.filter((message) => isDeepSeekStableCacheMessage(message));
  if (stablePrefix.length === 0) return [...messages];

  const volatilePrefix = remainingPrefix.filter(
    (message) => !isDeepSeekStableCacheMessage(message),
  );
  return [...leadingSystems, ...stablePrefix, ...volatilePrefix, ...tail];
}

function isDeepSeekStableCacheMessage(message: ModelMessage): boolean {
  return message.providerOptions?.deepseek?.cache === 'stable';
}

export function withDeepSeekDefaults(modelConfig: ModelConfig): ModelConfig {
  if (modelConfig.provider !== 'deepseek') return modelConfig;

  const isReasonerAlias = modelConfig.model === 'deepseek-reasoner';
  const normalizedModel = normalizeDeepSeekModel(modelConfig.model);
  const isThinkingDefault = isDeepSeekThinkingDefaultModel(normalizedModel);
  const strictTools =
    modelConfig.providerOptions?.deepseek &&
    typeof modelConfig.providerOptions.deepseek === 'object' &&
    !Array.isArray(modelConfig.providerOptions.deepseek) &&
    'strictTools' in modelConfig.providerOptions.deepseek
      ? Boolean(modelConfig.providerOptions.deepseek.strictTools)
      : false;
  return {
    ...modelConfig,
    model: normalizedModel,
    baseUrl: resolveDeepSeekBaseUrl(modelConfig.baseUrl, strictTools),
    maxContextTokens: modelConfig.maxContextTokens ?? 1_000_000,
    maxOutputTokens: modelConfig.maxOutputTokens ?? 384_000,
    temperature: modelConfig.temperature ?? 0.3,
    supportsThinking: modelConfig.supportsThinking ?? (isReasonerAlias || isThinkingDefault),
    thinkingEnabled: modelConfig.thinkingEnabled ?? (isReasonerAlias || isThinkingDefault),
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
    schema.type ||
      schema.properties ||
      schema.items ||
      schema.anyOf ||
      schema.oneOf ||
      schema.$ref ||
      (schema as Record<string, unknown>).$def ||
      schema.$defs ||
      schema.definitions,
  );
}

function sanitizeDeepSeekSchemaNode(schema: JSONSchema7): JSONSchema7 {
  const result: JSONSchema7 = { ...schema };

  for (const keyword of DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS) {
    delete (result as Record<string, unknown>)[keyword];
  }

  if (typeof result.format === 'string' && !DEEPSEEK_SUPPORTED_STRING_FORMATS.has(result.format)) {
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
    result.additionalProperties = sanitizeDeepSeekSchemaNode(
      result.additionalProperties as JSONSchema7,
    );
  }

  if (result.items && !Array.isArray(result.items)) {
    result.items = sanitizeDeepSeekSchemaNode(result.items as JSONSchema7);
  }

  if (Array.isArray(result.anyOf)) {
    result.anyOf = result.anyOf.map((item) => sanitizeDeepSeekSchemaNode(item as JSONSchema7));
  }

  if (Array.isArray(result.oneOf)) {
    result.anyOf =
      result.anyOf ?? result.oneOf.map((item) => sanitizeDeepSeekSchemaNode(item as JSONSchema7));
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
  tools: readonly ModelToolDefinition[] | undefined,
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
