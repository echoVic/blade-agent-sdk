/**
 * ModelManager — 模型配置解析、切换、ChatService 创建
 *
 * 从 Agent.ts 拆分，职责单一：管理模型生命周期
 */

import { createLogger, LogCategory } from '../logging/Logger.js';
import {
  createChatServiceAsync,
  type IChatService,
} from '../services/ChatServiceInterface.js';
import type {
  BladeConfig,
  ModelConfig,
  OutputFormat,
} from '../types/common.js';
import { isThinkingModel } from '../utils/modelDetection.js';
import { ExecutionEngine } from './ExecutionEngine.js';

const logger = createLogger(LogCategory.AGENT);

export class ModelManager {
  private chatService!: IChatService;
  private executionEngine!: ExecutionEngine;
  private currentModelId?: string;
  private currentModelMaxContextTokens!: number;

  constructor(
    private config: BladeConfig,
    private outputFormat?: OutputFormat,
  ) {}

  // ===== Getters =====

  getChatService(): IChatService {
    return this.chatService;
  }

  getExecutionEngine(): ExecutionEngine {
    return this.executionEngine;
  }

  getCurrentModelId(): string | undefined {
    return this.currentModelId;
  }

  getMaxContextTokens(): number {
    return this.currentModelMaxContextTokens;
  }

  // ===== 模型解析 =====

  resolveModelConfig(requestedModelId?: string): ModelConfig {
    const modelId = requestedModelId && requestedModelId !== 'inherit' ? requestedModelId : undefined;
    const models = this.config.models || [];
    const currentModelId = this.config.currentModelId;
    const modelConfig = modelId
      ? models.find(m => m.id === modelId)
      : models.find(m => m.id === currentModelId) || models[0];
    if (!modelConfig) {
      throw new Error(`❌ 模型配置未找到: ${modelId ?? 'current'}`);
    }
    return modelConfig;
  }

  // ===== 模型应用 =====

  async applyModelConfig(modelConfig: ModelConfig, label: string): Promise<void> {
    logger.debug(`[ModelManager] ${label} ${modelConfig.name} (${modelConfig.model})`);

    const modelSupportsThinking = isThinkingModel(modelConfig);
    const thinkingModeEnabled = modelConfig.thinkingEnabled ?? false;
    const supportsThinking = modelSupportsThinking && thinkingModeEnabled;
    if (modelSupportsThinking && !thinkingModeEnabled) {
      logger.debug(`[ModelManager] 🧠 模型支持 Thinking，但用户未开启（按 Tab 开启）`);
    } else if (supportsThinking) {
      logger.debug(`[ModelManager] 🧠 Thinking 模式已启用，启用 reasoning_content 支持`);
    }

    const maxContextTokens = modelConfig.maxContextTokens ?? 128000;
    this.currentModelMaxContextTokens = maxContextTokens;

    this.chatService = await createChatServiceAsync({
      provider: modelConfig.provider,
      apiKey: modelConfig.apiKey || '',
      model: modelConfig.model,
      baseUrl: modelConfig.baseUrl || '',
      temperature: modelConfig.temperature ?? this.config.temperature,
      maxContextTokens: this.currentModelMaxContextTokens,
      supportsThinking,
      outputFormat: this.outputFormat,
    });

    const contextManager = this.executionEngine?.getContextManager();
    this.executionEngine = new ExecutionEngine(this.chatService, contextManager);
    this.currentModelId = modelConfig.id;
  }

  // ===== 模型切换 =====

  async switchModelIfNeeded(modelId: string): Promise<void> {
    if (!modelId || modelId === this.currentModelId) return;
    const models = this.config.models || [];
    const modelConfig = models.find(m => m.id === modelId);
    if (!modelConfig) {
      logger.warn(`[ModelManager] ⚠️ 模型配置未找到: ${modelId}`);
      return;
    }
    await this.applyModelConfig(modelConfig, '🔁 切换模型');
  }
}
