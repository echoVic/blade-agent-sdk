import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import {
  normalizeDeepSeekModel,
  resolveDeepSeekBaseUrl,
  shouldUseDeepSeekBetaBaseUrl,
  type DeepSeekProviderOptions,
} from '../../deepseek/index.js';
import type { JsonObject, ModelProvider } from '../../model/index.js';

export interface VercelLanguageModelOptions {
  provider: ModelProvider | string;
  providerId?: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  headers?: Record<string, string>;
  apiVersion?: string;
  providerOptions?: JsonObject;
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
