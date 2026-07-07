export interface ToolInjectedMessageLike {
  role: string;
  metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function markToolInjectedSystemMessages<TMessage extends ToolInjectedMessageLike>(
  messages: readonly TMessage[],
): TMessage[] {
  return messages.map((message) => {
    if (message.role !== 'system') {
      return { ...message };
    }

    return {
      ...message,
      metadata: {
        ...(isRecord(message.metadata) ? message.metadata : {}),
        _systemSource: 'tool_injection',
      },
    };
  });
}
