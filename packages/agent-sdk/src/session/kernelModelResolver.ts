import { createVercelModelPort, type VercelLanguageModelOptions } from '@blade-ai/ai/providers/vercel';
import type { AgentModelRequestDefaults } from '@blade-ai/agent';
import type { ModelPort } from '@blade-ai/ai';
import type { BladeConfig, ModelConfig } from '../types/common.js';
import type {
  PackageLocalRuntimeKernelModelResolverPort,
  PackageLocalRuntimeResolvedKernelModel,
} from './runtimeInstance.js';

export interface PackageLocalKernelModelResolverOptions {
  createModelPort?: (options: VercelLanguageModelOptions) => ModelPort;
}

export function createPackageLocalKernelModelResolver(
  options: PackageLocalKernelModelResolverOptions = {},
): PackageLocalRuntimeKernelModelResolverPort {
  const createModelPort = options.createModelPort ?? createVercelModelPort;

  return {
    resolve({ bladeConfig, modelId }) {
      const modelConfig = resolveKernelModelConfig(bladeConfig, modelId);
      return {
        model: createModelPort(toVercelLanguageModelOptions(modelConfig)),
        modelRequestDefaults: toAgentModelRequestDefaults(modelConfig, bladeConfig),
      } satisfies PackageLocalRuntimeResolvedKernelModel;
    },
  };
}

export function resolveKernelModelConfig(
  bladeConfig: BladeConfig,
  modelId?: string,
): ModelConfig {
  const requestedModelId =
    modelId && modelId !== 'inherit' ? modelId : bladeConfig.currentModelId;
  const models = bladeConfig.models ?? [];
  const modelConfig = requestedModelId
    ? models.find(
        (model) =>
          model.id === requestedModelId ||
          model.model === requestedModelId ||
          model.name === requestedModelId,
      )
    : models[0];

  if (!modelConfig) {
    throw new Error(`Model configuration not found: ${requestedModelId ?? 'current'}`);
  }

  return modelConfig;
}

function toVercelLanguageModelOptions(modelConfig: ModelConfig): VercelLanguageModelOptions {
  return {
    provider: modelConfig.provider,
    apiKey: modelConfig.apiKey ?? '',
    baseUrl: modelConfig.baseUrl,
    model: modelConfig.model,
    headers: modelConfig.headers,
    providerOptions: modelConfig.providerOptions,
    supportsThinking: modelConfig.supportsThinking,
  };
}

function toAgentModelRequestDefaults(
  modelConfig: ModelConfig,
  bladeConfig: BladeConfig,
): AgentModelRequestDefaults {
  return {
    model: modelConfig.model,
    temperature: modelConfig.temperature ?? bladeConfig.temperature,
    maxOutputTokens: modelConfig.maxOutputTokens,
    maxContextTokens: modelConfig.maxContextTokens,
    providerOptions: modelConfig.providerOptions,
  };
}
