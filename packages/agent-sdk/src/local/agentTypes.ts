/**
 * Agent type definitions extracted from root agent/types.ts.
 * Zero root dependencies. May import from @blade-ai/ai and @blade-ai/agent.
 */

import type { ContentPart } from '@blade-ai/ai/chat';

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

/**
 * Minimal interface for background agent control.
 * Uses unknown for root-specific type parameters to avoid depending
 * on root classes. Original uses StartBackgroundAgentOptions and AgentId.
 */
export interface IBackgroundAgentController {
  killAgent(agentId: string): boolean;
  cancelCurrentWork(agentId: string): boolean;
  startBackgroundAgent(options: unknown): string;
  resumeAgent(agentId: string, newPrompt: string, ...args: unknown[]): string | undefined;
  sendMessage(agentId: string, message: string): boolean;
}

/**
 * Minimal interface for background agent reading.
 * Uses string for AgentId and unknown for AgentSession.
 */
export interface IBackgroundAgentReader {
  getAgent(agentId: string): unknown;
  isRunning(agentId: string): boolean;
  waitForCompletion(agentId: string, timeout?: number): Promise<unknown>;
}
