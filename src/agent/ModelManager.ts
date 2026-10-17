import { ContextManager } from '../context/ContextManager.js';
import { resolveVisionCapability } from '../images/visionDefaults.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import { type ModelMiddleware, wrapModelService } from '../middleware/ModelMiddleware.js';
import type { ModelConfig, OutputFormat } from '../model/config.js';
import type { ModelService } from '../model/service.js';
import type {
  VisionCapability,
  VisionCapabilityOverride,
  VisionResolver,
} from '../model/vision.js';
import { createModelService } from '../services/createModelService.js';
import { withDeepSeekDefaults } from '../services/deepseek.js';
import { wrapModelServiceWithTimeouts } from '../services/ModelServiceTimeout.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import { isThinkingModel } from '../utils/modelDetection.js';
import type { BladeConfig } from './config.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export class ModelManager {
  private modelService!: ModelService;
  private currentModelId?: string;
  private currentModelMaxContextTokens!: number;
  private currentMaxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  private currentVision?: VisionCapability;
  private currentVisionKey?: string;
  private readonly imagelessModels = new Set<string>();
  private readonly contextManager: ContextManager;
  private readonly logger: InternalLogger;

  constructor(
    private config: BladeConfig,
    private outputFormat?: OutputFormat,
    contextManager?: ContextManager,
    _projectPath?: string,
    logger?: InternalLogger,
    private readonly modelMiddleware: readonly ModelMiddleware[] = [],
    private readonly providerRegistry?: ProviderRegistry,
    private readonly visionOverride?: VisionCapabilityOverride | VisionResolver,
  ) {
    this.contextManager = contextManager || new ContextManager();
    this.logger = (logger ?? NOOP_LOGGER).child(LogCategory.AGENT);
  }

  getModelService(): ModelService {
    return this.modelService;
  }

  getContextManager(): ContextManager {
    return this.contextManager;
  }

  getMaxContextTokens(): number {
    return this.currentModelMaxContextTokens;
  }

  getProviderRegistry(): ProviderRegistry | undefined {
    return this.providerRegistry;
  }

  /** Image capability of the active model; undefined until a model is applied. */
  getVision(): VisionCapability | undefined {
    return this.currentVision;
  }

  /** Input tokens one request may use: the context window minus the output allowance. */
  getInputWindowTokens(): number | undefined {
    return this.currentVision === undefined
      ? undefined
      : Math.max(0, this.currentModelMaxContextTokens - this.currentMaxOutputTokens);
  }

  /** Stop sending images to the active model for as long as this manager lives. */
  markImagesUnsupported(): void {
    if (!this.currentVisionKey || !this.currentVision) return;
    this.imagelessModels.add(this.currentVisionKey);
    this.currentVision = { ...this.currentVision, images: false };
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
    const visionKey = `${modelConfig.provider}\u0000${modelConfig.model}`;
    const vision = resolveVisionCapability({
      provider: modelConfig.provider,
      model: modelConfig.model,
      modelOverride: modelConfig.vision,
      sessionOverride: this.visionOverride,
      imagesUnsupported: this.imagelessModels.has(visionKey),
    });

    const modelService = await createModelService(
      {
        provider: modelConfig.provider,
        providerId: modelConfig.providerId?.trim() || modelConfig.provider,
        apiKey: modelConfig.apiKey || '',
        model: modelConfig.model,
        baseUrl: modelConfig.baseUrl || '',
        customHeaders: modelConfig.headers,
        temperature: modelConfig.temperature ?? this.config.temperature,
        maxContextTokens,
        maxOutputTokens: modelConfig.maxOutputTokens,
        requestTimeoutMs: modelConfig.requestTimeoutMs,
        streamIdleTimeoutMs: modelConfig.streamIdleTimeoutMs,
        supportsThinking,
        providerOptions: modelConfig.providerOptions as never,
        outputFormat: this.outputFormat,
        vision,
      },
      this.logger,
      this.providerRegistry,
    );
    this.modelService = wrapModelServiceWithTimeouts(
      wrapModelService(modelService, this.modelMiddleware),
    );

    this.currentModelMaxContextTokens = maxContextTokens;
    this.currentModelId = modelConfig.id;
    this.config.currentModelId = modelConfig.id;
    this.currentMaxOutputTokens = modelConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.currentVision = vision;
    this.currentVisionKey = visionKey;
  }

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
    await this.applyModelConfig(
      { ...activeModel, model: normalized, name: normalized },
      '🔁 更新模型',
    );
    activeModel.model = normalized;
    activeModel.name = normalized;
  }
}
