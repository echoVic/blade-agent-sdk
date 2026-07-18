/**
 * Agent 核心类型定义
 *
 * ⚠️ MIGRATED: This file is a re-export shim.
 * All canonical types now live in @blade-ai/agent-sdk/local or @blade-ai/agent-sdk.
 */

export type {
  UserMessageContent,
  AgentProgress,
  IBackgroundAgentReader,
  IBackgroundAgentController,
  IBackgroundAgentManager,
  ChatContext,
  TurnLimitResponse,
  AgentOptions,
  LoopOptions,
  LoopResult,
  PlanApprovalResult,
  StartBackgroundAgentOptions,
} from '@blade-ai/agent-sdk/local';

export { isPlanApprovalResult } from '@blade-ai/agent-sdk/local';
