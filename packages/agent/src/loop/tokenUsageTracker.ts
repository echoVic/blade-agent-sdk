export interface AgentLoopTokenUsageRecord {
  promptTokens?: number;
  totalTokens?: number;
}

export interface AgentLoopTokenUsageTracker {
  readonly totalTokens: number;
  readonly lastPromptTokens: number | undefined;
  record(usage: AgentLoopTokenUsageRecord): void;
}

export interface RecordAgentLoopTokenUsageInput {
  tracker: AgentLoopTokenUsageTracker;
  usage: AgentLoopTokenUsageRecord;
}

export function shouldRecordAgentLoopTokenUsage(
  usage?: AgentLoopTokenUsageRecord,
): usage is AgentLoopTokenUsageRecord {
  return usage !== undefined;
}

export function createAgentLoopTokenUsageTracker(): AgentLoopTokenUsageTracker {
  let totalTokens = 0;
  let lastPromptTokens: number | undefined;

  return {
    get totalTokens() {
      return totalTokens;
    },
    get lastPromptTokens() {
      return lastPromptTokens;
    },
    record(usage: AgentLoopTokenUsageRecord): void {
      if (usage.totalTokens) {
        totalTokens += usage.totalTokens;
      }
      lastPromptTokens = usage.promptTokens;
    },
  };
}

export function recordAgentLoopTokenUsage(input: RecordAgentLoopTokenUsageInput): void {
  input.tracker.record(input.usage);
}
