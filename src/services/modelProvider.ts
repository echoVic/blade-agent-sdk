import type { LanguageModel } from 'ai';
import { ProviderRegistryError } from '../errors/ProviderRegistryError.js';
import type { BuiltinProviderType, ModelServiceConfig } from '../model/config.js';
import {
  normalizeDeepSeekModel,
  resolveDeepSeekBaseUrl,
  shouldUseDeepSeekBetaBaseUrl,
} from './deepseek.js';

type ProviderFactory = (config: ModelServiceConfig) => Promise<LanguageModel>;

async function loadOptional<T>(
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

const openai: ProviderFactory = async ({ apiKey, baseUrl, customHeaders, model }) => {
  const { createOpenAI } = await import('@ai-sdk/openai');
  return createOpenAI({ apiKey, baseURL: baseUrl || undefined, headers: customHeaders })(model);
};

const anthropic: ProviderFactory = async ({ apiKey, baseUrl, customHeaders, model, provider }) => {
  const { createAnthropic } = await loadOptional(
    provider,
    '@ai-sdk/anthropic',
    () => import('@ai-sdk/anthropic'),
  );
  return createAnthropic({ apiKey, baseURL: baseUrl || undefined, headers: customHeaders })(model);
};

const compatible = async (
  config: ModelServiceConfig,
  name = config.providerId || 'custom',
  baseURL = config.baseUrl,
): Promise<LanguageModel> => {
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  return createOpenAICompatible({
    name,
    apiKey: config.apiKey,
    baseURL,
    headers: config.customHeaders,
  })(config.model);
};

const gemini: ProviderFactory = async (config) => {
  if (
    config.baseUrl &&
    !['generativelanguage.googleapis.com', 'aiplatform.googleapis.com'].some((host) =>
      config.baseUrl.includes(host),
    )
  ) {
    return compatible(config, 'gemini');
  }
  const { createGoogleGenerativeAI } = await loadOptional(
    config.provider,
    '@ai-sdk/google',
    () => import('@ai-sdk/google'),
  );
  return createGoogleGenerativeAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
  })(config.model);
};

const azure: ProviderFactory = async (config) => {
  const resourceName = config.baseUrl?.match(
    /https:\/\/([^.]+)\.openai\.azure(?:\.com|\.us|\.cn|\.de)/,
  )?.[1];
  if (resourceName) {
    const { createAzure } = await loadOptional(
      config.provider,
      '@ai-sdk/azure',
      () => import('@ai-sdk/azure'),
    );
    return createAzure({
      apiKey: config.apiKey,
      resourceName,
      apiVersion: config.apiVersion || '2024-08-01-preview',
    })(config.model);
  }
  const base = config.baseUrl?.replace(/\/$/, '').replace(/\?.*$/, '') ?? '';
  const baseURL = base.includes('/openai/deployments/')
    ? base
    : `${base}/openai/deployments/${config.model}`;
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  return createOpenAICompatible({
    name: 'azure-openai',
    apiKey: config.apiKey,
    baseURL,
    headers: { ...config.customHeaders, 'api-key': config.apiKey },
    queryParams: { 'api-version': config.apiVersion || '2024-08-01-preview' },
  })(config.model);
};

const deepseek: ProviderFactory = async (config) => {
  const { createDeepSeek } = await loadOptional(
    config.provider,
    '@ai-sdk/deepseek',
    () => import('@ai-sdk/deepseek'),
  );
  return createDeepSeek({
    apiKey: config.apiKey,
    baseURL: resolveDeepSeekBaseUrl(
      config.baseUrl,
      shouldUseDeepSeekBetaBaseUrl({
        provider: config.provider,
        providerId: config.providerId,
        deepseek: config.providerOptions?.deepseek,
      }),
    ),
    headers: config.customHeaders,
  })(normalizeDeepSeekModel(config.model));
};

export const PROVIDER_FACTORIES: Readonly<Record<BuiltinProviderType, ProviderFactory>> = {
  openai,
  anthropic,
  gemini,
  'azure-openai': azure,
  deepseek,
  'openai-compatible': compatible,
};

export async function createBuiltinModel(config: ModelServiceConfig): Promise<LanguageModel> {
  const factory = PROVIDER_FACTORIES[config.provider as BuiltinProviderType];
  if (!factory) {
    throw new ProviderRegistryError(
      'PROVIDER_ADAPTER_NOT_FOUND',
      `No built-in provider adapter is registered for "${config.provider}"`,
      { providerType: config.provider },
    );
  }
  return factory(config);
}
