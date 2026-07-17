/**
 * Agent type definitions extracted from root agent/types.ts.
 * Zero root dependencies.
 */

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
