import type { ModelUsageInfo } from '@blade-ai/ai';

export interface AgentLoopTokenUsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
  billableInputTokens?: number;
  reasoningTokens?: number;
}

export interface AgentLoopTokenUsageEvent {
  type: 'token_usage';
  usage: AgentLoopTokenUsageInfo;
}

export interface AgentLoopTokenUsageEventInput {
  usage: AgentLoopTokenUsageInfo;
}

export interface AgentLoopBudgetWarningEvent<TSnapshot = unknown> {
  type: 'budget_warning';
  snapshot: TSnapshot;
}

export interface AgentLoopBudgetWarningEventInput<TSnapshot = unknown> {
  snapshot: TSnapshot;
}

export interface BuildAgentLoopTokenUsageInfoInput {
  modelUsage: ModelUsageInfo;
  totalTokens: number;
  maxContextTokens: number;
}

export function buildAgentLoopTokenUsageInfo(
  input: BuildAgentLoopTokenUsageInfoInput,
): AgentLoopTokenUsageInfo {
  return {
    inputTokens: input.modelUsage.promptTokens ?? 0,
    outputTokens: input.modelUsage.completionTokens ?? 0,
    totalTokens: input.totalTokens,
    maxContextTokens: input.maxContextTokens,
    cacheReadInputTokens: input.modelUsage.cacheReadInputTokens,
    cacheMissInputTokens: input.modelUsage.cacheMissInputTokens,
    billableInputTokens: input.modelUsage.billableInputTokens,
    reasoningTokens: input.modelUsage.reasoningTokens,
  };
}

export function buildAgentLoopTokenUsageEvent(
  input: AgentLoopTokenUsageEventInput,
): AgentLoopTokenUsageEvent {
  return {
    type: 'token_usage',
    usage: input.usage,
  };
}

export function buildAgentLoopBudgetWarningEvent<TSnapshot>(
  input: AgentLoopBudgetWarningEventInput<TSnapshot>,
): AgentLoopBudgetWarningEvent<TSnapshot> {
  return {
    type: 'budget_warning',
    snapshot: input.snapshot,
  };
}
