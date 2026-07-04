import type { BladeConfig, ModelConfig, ProviderType } from '../types/common.js';
import type { ProviderConfig, SessionOptions } from './types.js';

const defaultProviderBaseUrls: Record<ProviderConfig['type'], string> = {
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  deepseek: 'https://api.deepseek.com',
  'azure-openai': '',
};

const providerTypeMap: Record<ProviderConfig['type'], ProviderType> = {
  openai: 'openai',
  'openai-compatible': 'openai-compatible',
  anthropic: 'anthropic',
  gemini: 'gemini',
  deepseek: 'deepseek',
  'azure-openai': 'azure-openai',
};

export function mapSessionProviderType(type: string): ProviderType {
  return providerTypeMap[type as ProviderConfig['type']] ?? 'openai-compatible';
}

export function getDefaultProviderBaseUrl(type: ProviderConfig['type']): string {
  return defaultProviderBaseUrls[type] ?? '';
}

export function buildSessionModelConfig(options: SessionOptions): ModelConfig {
  const provider = options.provider;
  const openAIHeaders =
    provider.type === 'openai'
      ? {
          ...(provider.organization ? { 'OpenAI-Organization': provider.organization } : {}),
          ...(provider.projectId ? { 'OpenAI-Project': provider.projectId } : {}),
        }
      : {};
  const headers = {
    ...provider.headers,
    ...openAIHeaders,
  };

  return {
    id: 'default',
    name: options.model,
    provider: mapSessionProviderType(provider.type),
    model: options.model,
    apiKey: provider.apiKey || '',
    baseUrl: provider.baseUrl || getDefaultProviderBaseUrl(provider.type),
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    maxContextTokens: options.maxContextTokens ?? 128000,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    providerOptions: options.providerOptions,
    thinkingEnabled: options.thinkingEnabled,
    thinkingBudget: options.thinkingBudget,
  };
}

export function buildBladeConfig(options: SessionOptions): BladeConfig {
  const modelConfig = buildSessionModelConfig(options);

  return {
    models: [modelConfig],
    currentModelId: modelConfig.id,
    temperature: options.temperature ?? 0.7,
    permissions: {
      allow: [],
      deny: [],
    },
  };
}
