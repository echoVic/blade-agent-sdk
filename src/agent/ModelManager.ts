import { createLogger, LogCategory } from '../logging/Logger.js';
import {
  createChatServiceAsync,
  type IChatService,
} from '../services/ChatServiceInterface.js';
import type { BladeConfig, ModelConfig } from '../types/common.js';
import { isThinkingModel } from '../utils/modelDetection.js';

const logger = createLogger(LogCategory.AGENT);

export class ModelManager {
  private chatService!: IChatService;
  private currentModelId?: string;
  private currentModelMaxContextTokens!: number;

  constructor(private config: BladeConfig) {}

  async initialize(modelId?: string): Promise<IChatService> {
    const modelConfig = this.resolveModelConfig(modelId);
    await this.applyModelConfig(modelConfig, '🚀 使用模型:');
    return this.chatService;
  }

  getChatService(): IChatService {
    return this.chatService;
  }

  getCurrentModelId(): string | undefined {
    return this.currentModelId;
  }

  getMaxContextTokens(): number {
    return this.currentModelMaxContextTokens;
  }

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

  async applyModelConfig(modelConfig: ModelConfig, label: string): Promise<void> {
    logger.debug(`${label} ${modelConfig.name} (${modelConfig.model})`);

    const modelSupportsThinking = isThinkingModel(modelConfig);
    const thinkingModeEnabled = modelConfig.thinkingEnabled ?? false;
    const supportsThinking = modelSupportsThinking && thinkingModeEnabled;

    if (modelSupportsThinking && !thinkingModeEnabled) {
      logger.debug(`🧠 模型支持 Thinking，但用户未开启（按 Tab 开启）`);
    } else if (supportsThinking) {
      logger.debug(`🧠 Thinking 模式已启用，启用 reasoning_content 支持`);
    }

    const maxContextTokens = modelConfig.maxTokens ?? 128000;
    this.currentModelMaxContextTokens = maxContextTokens;

    this.chatService = await createChatServiceAsync({
      provider: modelConfig.provider,
      apiKey: modelConfig.apiKey || '',
      model: modelConfig.model,
      baseUrl: modelConfig.baseUrl || '',
      temperature: modelConfig.temperature ?? this.config.temperature,
      maxContextTokens: this.currentModelMaxContextTokens,
      supportsThinking,
    });

    this.currentModelId = modelConfig.id;
  }

  async switchModelIfNeeded(modelId: string): Promise<boolean> {
    if (!modelId || modelId === this.currentModelId) {
      return false;
    }

    const models = this.config.models || [];
    const modelConfig = models.find((m) => m.id === modelId);
    if (!modelConfig) {
      logger.warn(`⚠️ 模型配置未找到: ${modelId}`);
      return false;
    }

    await this.applyModelConfig(modelConfig, '🔁 切换模型');
    return true;
  }

  static validateConfig(config: BladeConfig): void {
    const models = config.models || [];
    if (models.length === 0) {
      throw new Error(
        '❌ 没有可用的模型配置\n\n' +
          '请先使用以下命令添加模型：\n' +
          '  /model add\n\n' +
          '或运行初始化向导：\n' +
          '  /init'
      );
    }
  }
}
