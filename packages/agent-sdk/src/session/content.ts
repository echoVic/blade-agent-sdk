import type { JsonValue } from '../types/common.js';
import type { SessionTextContentPart, UserMessageContent } from './types.js';

export function getUserMessageText(message: UserMessageContent): string {
  if (typeof message === 'string') {
    return message;
  }

  return message
    .filter((part): part is SessionTextContentPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export function countUserMessageImages(message: UserMessageContent): number {
  if (typeof message === 'string') {
    return 0;
  }

  return message.filter((part) => part.type === 'image_url').length;
}

export function parseJsonOrString(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}
