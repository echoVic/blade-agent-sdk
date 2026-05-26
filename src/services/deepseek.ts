import type { JSONSchema7 } from 'json-schema';
import type { JsonObject, JsonValue, ModelConfig } from '../types/common.js';
import type { ProviderOptions, UsageInfo } from './ChatServiceInterface.js';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_BETA_BASE_URL = 'https://api.deepseek.com/beta';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro';

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

export function normalizeDeepSeekModel(model?: string): string {
  if (!model) return DEEPSEEK_DEFAULT_MODEL;
  return DEEPSEEK_MODEL_ALIASES[model] ?? model;
}

export function resolveDeepSeekBaseUrl(baseUrl?: string, beta = false): string {
  if (baseUrl?.trim()) return baseUrl.replace(/\/$/, '');
  return beta ? DEEPSEEK_BETA_BASE_URL : DEEPSEEK_DEFAULT_BASE_URL;
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

  if (!thinking && !explicit?.strictTools) return undefined;

  return {
    deepseek: {
      ...(thinking ? { thinking } : {}),
      ...(explicit?.strictTools ? { strictTools: true } : {}),
    },
  };
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
  return {
    ...modelConfig,
    model: normalizeDeepSeekModel(modelConfig.model),
    baseUrl: resolveDeepSeekBaseUrl(modelConfig.baseUrl),
    maxContextTokens: modelConfig.maxContextTokens ?? 1_000_000,
    maxOutputTokens: modelConfig.maxOutputTokens ?? 384_000,
    temperature: modelConfig.temperature ?? 0.3,
    supportsThinking: modelConfig.supportsThinking ?? isReasonerAlias,
    thinkingEnabled: modelConfig.thinkingEnabled ?? isReasonerAlias,
  };
}

export function sanitizeDeepSeekStrictSchema(schema: JSONSchema7): JSONSchema7 {
  if (schema.type !== 'object' || !schema.properties) return schema;

  const properties = schema.properties;
  const required = Object.keys(properties);
  return {
    ...schema,
    required,
    additionalProperties: false,
  };
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
