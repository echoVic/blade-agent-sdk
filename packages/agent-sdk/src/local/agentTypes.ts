/**
 * Agent type definitions extracted from root agent/types.ts.
 * Zero root dependencies. May import from @blade-ai/ai and @blade-ai/agent.
 */

import type { ContentPart, Message } from '@blade-ai/ai/chat';
import type { ConfirmationHandler } from '../tools/types/index.js';

export type UserMessageContent = string | ContentPart[];

export interface TurnLimitResponse {
  continue: boolean;
  reason?: string;
}

export interface AgentProgress {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: string;
  summary?: string;
  updatedAt: number;
}

export interface IBackgroundAgentController {
  killAgent(agentId: string): boolean;
  cancelCurrentWork(agentId: string): boolean;
  startBackgroundAgent(options: unknown): string;
  resumeAgent(agentId: string, newPrompt: string, ...args: unknown[]): string | undefined;
  sendMessage(agentId: string, message: string): boolean;
}

export interface IBackgroundAgentReader {
  getAgent(agentId: string): unknown;
  isRunning(agentId: string): boolean;
  waitForCompletion(agentId: string, timeout?: number): Promise<unknown>;
}

export interface IBackgroundAgentManager extends IBackgroundAgentReader, IBackgroundAgentController {}

export interface ChatContext {
  messages: Message[];
  userId: string;
  sessionId: string;
  snapshot?: unknown;
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: string;
  systemPrompt?: string;
  subagentInfo?: unknown;
  omitEnvironment?: boolean;
  backgroundAgentManager?: unknown;
}
