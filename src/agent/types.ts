/**
 * Agent核心类型定义
 */

import type { ContextSnapshot } from '../runtime/index.js';
import type { ContentPart, Message } from '@blade-ai/ai/chat';
import type { ToolCatalogSourcePolicy } from '../tools/catalog/index.js';
import type { ConfirmationHandler } from '../tools/types/ExecutionTypes.js';
import type { AgentId, SessionId } from '../types/branded.js';
import type { OutputFormat, PermissionMode, PermissionsConfig, SandboxSettings } from '../types/common.js';
import type { CanUseTool, PermissionHandler } from '../types/permissions.js';
import type { AgentSession } from './subagents/AgentSessionStore.js';
import type { StartBackgroundAgentOptions } from './subagents/BackgroundAgentManager.js';
import type { TokenBudgetConfig, TokenBudgetSnapshot } from '@blade-ai/agent/budget';
import type { AgentProgress, ChatContext, IBackgroundAgentController, IBackgroundAgentManager, IBackgroundAgentReader, TurnLimitResponse, UserMessageContent } from '@blade-ai/agent-sdk/local';

/**
 * 用户消息内容类型
 * 支持纯文本或多模态内容（文本 + 图片）
 */
export type { UserMessageContent };

/**
 * 后台 Agent 管理器的最小接口
 *
 * 解耦 state/types 层对 subagents 具体实现的依赖。
 * BackgroundAgentManager 通过 structural typing 隐式满足此接口。
 *
 * 分层设计：
 * - IBackgroundAgentReader: 读取/查询能力（TaskOutput 使用）
 * - IBackgroundAgentController: 启动/停止/恢复能力（Task 使用）
 * - IBackgroundAgentManager: 完整接口（SessionRuntime 注入）
 */

export type { AgentProgress };

export type { IBackgroundAgentReader };

export type { IBackgroundAgentController };<｜end▁of▁thinking｜>export type { IBackgroundAgentReader };

export type { IBackgroundAgentController };

export type { IBackgroundAgentManager };

/**
 * 子代理信息（用于 JSONL 写入）
 */
interface SubagentInfoForContext {
  parentSessionId: string;
  subagentType: string;
  isSidechain: boolean;
}

/**
 * 聊天上下文接口
 *
export type { ChatContext };

/**
 * Agent 创建选项 - 仅包含运行时参数
 * Agent 的配置来自 Store (通过 getConfig() 获取 BladeConfig)
 */
export type { AgentOptions } from '@blade-ai/agent-sdk/local';

export type { LoopOptions } from '@blade-ai/agent-sdk/local';

export type { LoopResult } from '@blade-ai/agent-sdk/local';

/** Plan 审批通过后的 LoopResult 子类型 */
export type { PlanApprovalResult } from '@blade-ai/agent-sdk/local';

export { isPlanApprovalResult } from '@blade-ai/agent-sdk/local';
