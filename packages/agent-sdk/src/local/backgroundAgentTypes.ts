import type { SubagentConfig } from '@blade-ai/agent-sdk';
import type { BladeConfig, PermissionMode } from '../types/common.js';
import type { SubagentRegistry } from './subagentRegistry.js';
import type { AgentId } from './branded.js';
import type { Message } from '@blade-ai/ai/chat';
import type { ContextSnapshot } from './ContextSnapshot.js';

/**
 * StartBackgroundAgentOptions — 后台 Agent 启动选项
 *
 * 用于 BackgroundAgentManager.startBackgroundAgent() 的参数。
 * 包含子代理配置、BladeConfig、权限模式等完整启动信息。
 */
export interface StartBackgroundAgentOptions {
  /** Subagent 配置 */
  config: SubagentConfig;

  /** BladeConfig 配置 */
  bladeConfig: BladeConfig;

  /** 当前会话生效的 subagent 注册表 */
  subagentRegistry?: SubagentRegistry;

  /** 任务描述 */
  description: string;

  /** 任务 prompt */
  prompt: string;

  /** 父会话 ID */
  parentSessionId?: string;

  /** 权限模式 */
  permissionMode?: PermissionMode;

  /** 已有的 agent ID（用于 resume） */
  agentId?: AgentId;

  /** 恢复时的初始消息（用于 resume） */
  existingMessages?: Message[];

  /** 父 turn 的 context snapshot（如果存在则继承） */
  snapshot?: ContextSnapshot;
}
