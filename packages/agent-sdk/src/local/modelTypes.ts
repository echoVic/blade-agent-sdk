import type { ModelConfig } from '../types/common.js';

/**
 * ModelManagerLike — 模型管理器契约接口
 *
 * 解耦 Agent 与具体的 ModelManager 实现。
 * ModelManager (root src/agent/ModelManager.ts, 138L) 负责模型检测、切换、配置。
 * 此接口定义了 Agent 依赖的最小契约。
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
}
