import type { Message } from '../../services/ChatServiceInterface.js';

export interface MicrocompactOptions {
  preserveRecentToolMessages?: number;
  minToolContentLength?: number;
  previewLength?: number;
}

export interface MicrocompactResult {
  messages: Message[];
  replacedCount: number;
  savedChars: number;
  skippedNonStringToolMessages: number;
}

const DEFAULT_PRESERVE_RECENT_TOOL_MESSAGES = 2;
const DEFAULT_MIN_TOOL_CONTENT_LENGTH = 1500;
const DEFAULT_PREVIEW_LENGTH = 160;

export function microcompact(
  messages: Message[],
  options: MicrocompactOptions = {},
): MicrocompactResult {
  const preserveRecentToolMessages =
    options.preserveRecentToolMessages ?? DEFAULT_PRESERVE_RECENT_TOOL_MESSAGES;
  const minToolContentLength =
    options.minToolContentLength ?? DEFAULT_MIN_TOOL_CONTENT_LENGTH;
  const previewLength = options.previewLength ?? DEFAULT_PREVIEW_LENGTH;

  const toolIndexes = messages.flatMap((message, index) =>
    message.role === 'tool' && typeof message.content === 'string'
      ? [index]
      : [],
  );
  const preservedTailCount = Math.max(0, preserveRecentToolMessages);
  const preservedToolIndexes = new Set(
    preservedTailCount === 0
      ? []
      : toolIndexes.slice(-preservedTailCount),
  );
  const skippedNonStringToolMessages = messages.filter(
    (message) => message.role === 'tool' && typeof message.content !== 'string',
  ).length;

  let replacedCount = 0;
  let savedChars = 0;

  const compactedMessages = messages.map((message, index) => {
    if (
      message.role !== 'tool' ||
      typeof message.content !== 'string' ||
      preservedToolIndexes.has(index) ||
      message.content.includes('[Microcompact]') ||
      message.content.length < minToolContentLength
    ) {
      return message;
    }

    const originalLength = message.content.length;
    const preview = message.content.slice(0, previewLength).trim();

    const replacement =
      '[Microcompact] Older large tool output omitted to preserve context.\n'
      + `tool_call_id: ${message.tool_call_id ?? 'unknown'}\n`
      + `original_length: ${originalLength} chars\n`
      + (preview.length > 0 ? `preview: ${preview}` : 'preview: (empty)');

    replacedCount += 1;
    savedChars += Math.max(0, originalLength - replacement.length);

    return {
      ...message,
      content: replacement,
    };
  });

  return {
    messages: compactedMessages,
    replacedCount,
    savedChars,
    skippedNonStringToolMessages,
  };
}
