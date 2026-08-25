export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
  billableInputTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
  billableInputTokens?: number;
  reasoningTokens?: number;
}

export function normalizeModelUsage(
  usage: ModelUsage,
  maxContextTokens: number,
  totalTokens = usage.totalTokens,
): TokenUsage {
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    totalTokens,
    maxContextTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheMissInputTokens: usage.cacheMissInputTokens,
    billableInputTokens: usage.billableInputTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}
