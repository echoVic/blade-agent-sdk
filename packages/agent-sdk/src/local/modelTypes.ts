import type { ModelConfig } from '../types/common.js';
import type { IChatService } from '@blade-ai/ai/chat';

/**
 * ModelManagerLike — 模型管理器契约接口
 *
 * 解耦 Agent 与具体的 ModelManager 实现。
 * ModelManager (root src/agent/ModelManager.ts, 138L) 负责模型检测、切换、配置。
 * 此接口定义了 Agent 依赖的最小契约（不含 ContextManager 相关方法）。
 */
export interface ModelManagerLike {
  /** 应用模型配置 */
  applyModelConfig(
    modelConfig: ModelConfig,
    label: string,
  ): Promise<void>;

  /** 按需切换模型 */
  switchModelIfNeeded(modelId: string): Promise<void>;

  /** 设置或更新活跃模型 */
  setModel(model: string): Promise<void>;

  /** 解析模型配置（无参时使用活跃模型） */
  resolveModelConfig(requestedModelId?: string): ModelConfig;

  /** 获取当前聊天服务实例 */
  getChatService(): IChatService;
}
