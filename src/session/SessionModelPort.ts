import type { ModelPort } from '@blade-ai/ai';
import { createVercelModelPort } from '@blade-ai/ai/providers/vercel';
import type { AgentModelRequestDefaults } from '@blade-ai/agent/kernel';
import { withDeepSeekDefaults } from '../services/deepseek.js';
import type { BladeConfig, ModelConfig } from '../types/common.js';
import { isThinkingModel } from '../utils/modelDetection.js';

export interface SessionKernelModel {
  model: ModelPort;
  modelRequestDefaults: AgentModelRequestDefaults;
  modelConfig: ModelConfig;
}

export function resolveSessionModelConfig(
  bladeConfig: BladeConfig,
  requestedModelId?: string,
): ModelConfig {
  const modelId =
    requestedModelId && requestedModelId !== 'inherit' ? requestedModelId : undefined;
  const models = bladeConfig.models || [];
  const modelConfig = modelId
    ? models.find((model) => model.id === modelId)
    : models.find((model) => model.id === bladeConfig.currentModelId) || models[0];

  if (!modelConfig) {
    throw new Error(`❌ 模型配置未找到: ${modelId ?? 'current'}`);
  }

  return modelConfig;
}

export function createSessionKernelModel(
  bladeConfig: BladeConfig,
  requestedModelId?: string,
): SessionKernelModel {
  const modelConfig = withDeepSeekDefaults(
    resolveSessionModelConfig(bladeConfig, requestedModelId),
  );
  const supportsThinking = isThinkingModel(modelConfig) && (modelConfig.thinkingEnabled ?? false);
  const temperature = modelConfig.temperature ?? bladeConfig.temperature;

  return {
    model: createVercelModelPort({
      provider: modelConfig.provider,
      apiKey: modelConfig.apiKey || '',
      baseUrl: modelConfig.baseUrl || '',
      model: modelConfig.model,
      headers: modelConfig.headers,
      providerOptions: modelConfig.providerOptions,
      supportsThinking,
    }),
    modelRequestDefaults: {
      model: modelConfig.model,
      maxContextTokens: modelConfig.maxContextTokens ?? 128000,
      ...(modelConfig.maxOutputTokens !== undefined
        ? { maxOutputTokens: modelConfig.maxOutputTokens }
        : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(modelConfig.providerOptions !== undefined
        ? { providerOptions: modelConfig.providerOptions }
        : {}),
    },
    modelConfig,
  };
}
