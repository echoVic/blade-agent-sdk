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
