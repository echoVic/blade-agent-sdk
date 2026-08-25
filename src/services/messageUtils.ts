/**
 * Shared utilities for cloning and transforming ModelMessage / ModelContent values.
 *
 * Extracted from Session.ts and SessionStore.ts to avoid duplication.
 */

import type { ModelContent, ModelMessage, ModelToolCall } from '../model/message.js';
import type { JsonValue } from '../types/json.js';

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
 * Deep-clone a single ModelContent.
 */
export function cloneContentPart(part: ModelContent): ModelContent {
  if (part.type === 'text') {
    return {
      type: 'text',
      text: part.text,
      providerOptions: part.providerOptions
        ? (cloneJsonValue(part.providerOptions as JsonValue) as typeof part.providerOptions)
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
 * Deep-clone a ModelToolCall.
 */
export function cloneToolCall(toolCall: ModelToolCall): ModelToolCall {
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
 * Deep-clone `ModelMessage['content']` (string passthrough, array cloned).
 */
function cloneContent(content: ModelMessage['content']): ModelMessage['content'] {
  if (typeof content === 'string') {
    return content;
  }

  return content.map(cloneContentPart);
}

/**
 * Deep-clone a full ModelMessage.
 */
export function cloneMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    content: cloneContent(message.content),
    tool_calls: message.tool_calls?.map(cloneToolCall),
    metadata: cloneJsonValue(message.metadata),
  };
}
