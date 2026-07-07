export interface AgentToolResultContentInput {
  success: boolean;
  llmContent?: string | object;
  error?: {
    message?: string;
  };
}

export function buildAgentToolResultContent(result: AgentToolResultContentInput): string {
  const content = result.success
    ? result.llmContent || ''
    : result.error?.message || '执行失败';

  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content, null, 2);
  }

  return content;
}
