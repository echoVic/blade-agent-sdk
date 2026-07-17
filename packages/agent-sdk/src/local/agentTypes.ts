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
