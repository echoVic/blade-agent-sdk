import type { InputId, RequestId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { ModelMessage } from './message.js';

export const CONVERSATION_MESSAGE_SOURCES = [
  'catalog',
  'tool_injection',
  'compaction_summary',
] as const;

export type ConversationMessageSource = (typeof CONVERSATION_MESSAGE_SOURCES)[number];

export function isConversationMessageSource(value: unknown): value is ConversationMessageSource {
  return CONVERSATION_MESSAGE_SOURCES.some((source) => source === value);
}

export interface ConversationMessage extends ModelMessage {
  provenance?: {
    source: ConversationMessageSource;
  };
  correlation?: {
    inputId: InputId;
    requestId: RequestId;
  };
  telemetry?: {
    model?: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
    };
  };
  /** Opaque application data. SDK control flow must not inspect this field. */
  extensions?: JsonObject;
}
