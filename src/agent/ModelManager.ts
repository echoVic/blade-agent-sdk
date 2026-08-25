/**
 * ModelManager — 模型配置解析、切换、ModelService 创建
 *
 * 从 Agent.ts 拆分，职责单一：管理模型生命周期
 */

import { ContextManager } from '../context/ContextManager.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import { type ModelMiddleware, wrapModelService } from '../middleware/ModelMiddleware.js';
import type { ModelConfig, OutputFormat } from '../model/config.js';
import type { ModelService } from '../model/service.js';
import { createModelService } from '../services/createModelService.js';
import { withDeepSeekDefaults } from '../services/deepseek.js';
import { wrapModelServiceWithTimeouts } from '../services/ModelServiceTimeout.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import { isThinkingModel } from '../utils/modelDetection.js';
import type { BladeConfig } from './config.js';

export class ModelManager {
  private modelService!: ModelService;
  private currentModelId?: string;
  private currentModelMaxContextTokens!: number;
  private readonly contextManager: ContextManager;
  private readonly logger: InternalLogger;

  constructor(
    private config: BladeConfig,
    private outputFormat?: OutputFormat,
    contextManager?: ContextManager,
    projectPath?: string,
    logger?: InternalLogger,
    private readonly modelMiddleware: readonly ModelMiddleware[] = [],
    private readonly providerRegistry?: ProviderRegistry,
  ) {
    this.contextManager = contextManager || new ContextManager({ projectPath });
    this.logger = (logger ?? NOOP_LOGGER).child(LogCategory.AGENT);
  }

  // ===== Getters =====

  getModelService(): ModelService {
    return this.modelService;
  }

  getContextManager(): ContextManager {
    return this.contextManager;
  }

  getCurrentModelId(): string | undefined {
    return this.currentModelId;
  }

  getMaxContextTokens(): number {
    return this.currentModelMaxContextTokens;
  }

  getProviderRegistry(): ProviderRegistry | undefined {
    return this.providerRegistry;
  }

  // ===== 模型解析 =====

  resolveModelConfig(requestedModelId?: string): ModelConfig {
    const modelId =
      requestedModelId && requestedModelId !== 'inherit' ? requestedModelId : undefined;
    const models = this.config.models || [];
    const currentModelId = this.config.currentModelId;
    const modelConfig = modelId
      ? models.find((m) => m.id === modelId)
      : models.find((m) => m.id === currentModelId) || models[0];
    if (!modelConfig) {
      throw new Error(`❌ 模型配置未找到: ${modelId ?? 'current'}`);
    }
    return modelConfig;
  }

  // ===== 模型应用 =====

  async applyModelConfig(modelConfig: ModelConfig, label: string): Promise<void> {
    modelConfig = withDeepSeekDefaults(modelConfig);
    this.logger.debug(`[ModelManager] ${label} ${modelConfig.name} (${modelConfig.model})`);

    const modelSupportsThinking = isThinkingModel(modelConfig);
    const thinkingModeEnabled = modelConfig.thinkingEnabled ?? false;
    const supportsThinking = modelSupportsThinking && thinkingModeEnabled;
    if (modelSupportsThinking && !thinkingModeEnabled) {
      this.logger.debug(`[ModelManager] 🧠 模型支持 Thinking，但用户未开启（按 Tab 开启）`);
    } else if (supportsThinking) {
      this.logger.debug(`[ModelManager] 🧠 Thinking 模式已启用，启用 reasoning_content 支持`);
    }

    const maxContextTokens = modelConfig.maxContextTokens ?? 128000;
    this.currentModelMaxContextTokens = maxContextTokens;

    const modelService = await createModelService(
      {
        provider: modelConfig.provider,
        providerId: modelConfig.providerId?.trim() || modelConfig.provider,
        apiKey: modelConfig.apiKey || '',
        model: modelConfig.model,
        baseUrl: modelConfig.baseUrl || '',
        customHeaders: modelConfig.headers,
        temperature: modelConfig.temperature ?? this.config.temperature,
        maxContextTokens: this.currentModelMaxContextTokens,
        maxOutputTokens: modelConfig.maxOutputTokens,
        requestTimeoutMs: modelConfig.requestTimeoutMs,
        streamIdleTimeoutMs: modelConfig.streamIdleTimeoutMs,
        supportsThinking,
        providerOptions: modelConfig.providerOptions as never,
        outputFormat: this.outputFormat,
      },
      this.logger,
      this.providerRegistry,
    );
    this.modelService = wrapModelServiceWithTimeouts(
      wrapModelService(modelService, this.modelMiddleware),
    );

    this.currentModelId = modelConfig.id;
    this.config.currentModelId = modelConfig.id;
  }

  // ===== 模型切换 =====

  async switchModelIfNeeded(modelId: string): Promise<void> {
    if (!modelId || modelId === this.currentModelId) return;
    const models = this.config.models || [];
    const modelConfig = models.find((m) => m.id === modelId);
    if (!modelConfig) {
      this.logger.warn(`[ModelManager] ⚠️ 模型配置未找到: ${modelId}`);
      return;
    }
    await this.applyModelConfig(modelConfig, '🔁 切换模型');
  }

  async setModel(model: string): Promise<void> {
    const normalized = model.trim();
    if (!normalized) return;

    const models = this.config.models || [];
    const matchedModel = models.find(
      (candidate) =>
        candidate.id === normalized ||
        candidate.model === normalized ||
        candidate.name === normalized,
    );

    if (matchedModel) {
      await this.applyModelConfig(matchedModel, '🔁 切换模型');
      return;
    }

    const activeModel = this.resolveModelConfig(this.currentModelId);
    activeModel.model = normalized;
    activeModel.name = normalized;
    await this.applyModelConfig(activeModel, '🔁 更新模型');
  }
}
