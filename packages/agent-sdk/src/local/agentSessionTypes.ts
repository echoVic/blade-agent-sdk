/**
 * Agent session type definitions
 */
import type { AgentId } from './branded.js';
import type { Message } from '@blade-ai/ai/chat';
import type { AgentProgress } from './agentTypes.js';

export type AgentSessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Agent 会话数据
 */
export interface AgentSession {
  /** 会话 ID (agent_{uuid}) */
  id: AgentId;

  /** Subagent 类型 */
  subagentType: string;

  /** 任务描述 */
  description: string;

  /** 原始 prompt */
  prompt: string;

  /** 会话消息历史 */
  messages: Message[];

  /** 会话状态 */
  status: AgentSessionStatus;

  /** 最终结果（如果已完成） */
  result?: {
    success: boolean;
    message: string;
    error?: string;
  };

  /** 执行统计 */
  stats?: {
    tokens?: number;
    toolCalls?: number;
    duration?: number;
  };

  /** 创建时间 */
  createdAt: number;

  /** 最后活跃时间 */
  lastActiveAt: number;

  /** 完成时间（如果已完成） */
  completedAt?: number;

  /** 父会话 ID（可选） */
  parentSessionId?: string;

  /** 输出文件路径（后台 agent 完成后写入结果） */
  outputFile?: string;

  /** 运行时进度（仅在 status === 'running' 时持续更新） */
  progress?: AgentProgress;
}
