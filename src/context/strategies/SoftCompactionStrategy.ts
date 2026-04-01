import type { Message } from '../../services/ChatServiceInterface.js';

export interface SoftCompactionOptions {
  maxToolResultLength?: number;
  maxToolResultsToKeep?: number;
}

export interface SoftCompactionResult {
  messages: Message[];
  truncatedCount: number;
  savedChars: number;
}

const DEFAULT_MAX_TOOL_RESULT_LENGTH = 2000;
const DEFAULT_MAX_TOOL_RESULTS_TO_KEEP = 50;

export function softCompact(
  messages: Message[],
  options: SoftCompactionOptions = {},
): SoftCompactionResult {
  const maxToolResultLength =
    options.maxToolResultLength ?? DEFAULT_MAX_TOOL_RESULT_LENGTH;
  const maxToolResultsToKeep =
    options.maxToolResultsToKeep ?? DEFAULT_MAX_TOOL_RESULTS_TO_KEEP;

  // Reserved for future count-based trimming; this tier only truncates payload size.
  void maxToolResultsToKeep;

  let truncatedCount = 0;
  let savedChars = 0;

  const compactedMessages = messages.map((message) => {
    if (message.role !== 'tool' || typeof message.content !== 'string') {
      return message;
    }

    const originalContent = message.content;
    const originalLength = originalContent.length;

    if (originalLength <= maxToolResultLength) {
      return message;
    }

    truncatedCount += 1;
    savedChars += originalLength - maxToolResultLength;

    return {
      ...message,
      content:
        `${originalContent.slice(0, maxToolResultLength)}\n\n` +
        `[...truncated, original length: ${originalLength} chars]`,
    };
  });

  return {
    messages: compactedMessages,
    truncatedCount,
    savedChars,
  };
}
