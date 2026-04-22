/**
 * Shared utilities for cloning and transforming Message / ContentPart values.
 *
 * Extracted from Session.ts and SessionStore.ts to avoid duplication.
 */

import type { ContentPart, Message, ToolCall } from './ChatServiceInterface.js';
import type { JsonValue } from '../types/common.js';

/**
 * Deep-clone a JSON-safe value.
 * Returns `undefined` as-is (structuredClone would too, but this keeps
 * the generic signature clean for callers that pass optional fields).
 */
export function cloneJsonValue<T extends JsonValue | undefined>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return structuredClone(value);
}

/**
 * Deep-clone a single ContentPart.
 */
export function cloneContentPart(part: ContentPart): ContentPart {
  if (part.type === 'text') {
    return {
      type: 'text',
      text: part.text,
      providerOptions: part.providerOptions
        ? cloneJsonValue(part.providerOptions as JsonValue) as typeof part.providerOptions
        : undefined,
    };
  }

  return {
    type: 'image_url',
    image_url: {
      url: part.image_url.url,
    },
  };
}

/**
 * Deep-clone a ToolCall.
 */
export function cloneToolCall(toolCall: ToolCall): ToolCall {
  return {
    id: toolCall.id,
    type: toolCall.type,
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  };
}

/**
 * Deep-clone `Message['content']` (string passthrough, array cloned).
 */
function cloneContent(content: Message['content']): Message['content'] {
  if (typeof content === 'string') {
    return content;
  }

  return content.map(cloneContentPart);
}

/**
 * Deep-clone a full Message.
 */
export function cloneMessage(message: Message): Message {
  return {
    ...message,
    content: cloneContent(message.content),
    tool_calls: message.tool_calls?.map(cloneToolCall),
    metadata: cloneJsonValue(message.metadata),
  };
}
