export interface AgentToolResultTracker<TToolResult = unknown> {
  readonly toolCallsCount: number;
  readonly recentToolResults: readonly TToolResult[];
  record(result: TToolResult): void;
}

export interface CreateAgentToolResultTrackerOptions {
  maxRecentResults?: number;
}

export interface RecordAgentToolResultInput<TToolResult = unknown> {
  tracker: AgentToolResultTracker<TToolResult>;
  result: TToolResult;
}

export function createAgentToolResultTracker<TToolResult = unknown>(
  options: CreateAgentToolResultTrackerOptions = {},
): AgentToolResultTracker<TToolResult> {
  const maxRecentResults = options.maxRecentResults ?? 50;
  const recentToolResults: TToolResult[] = [];
  let toolCallsCount = 0;

  return {
    get toolCallsCount() {
      return toolCallsCount;
    },
    get recentToolResults() {
      return [...recentToolResults];
    },
    record(result: TToolResult): void {
      toolCallsCount += 1;

      if (maxRecentResults <= 0) {
        return;
      }

      recentToolResults.push(result);
      if (recentToolResults.length > maxRecentResults) {
        recentToolResults.shift();
      }
    },
  };
}

export function recordAgentToolResult<TToolResult>(
  input: RecordAgentToolResultInput<TToolResult>,
): void {
  input.tracker.record(input.result);
}
