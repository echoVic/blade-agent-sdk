import type { ConversationMessage } from '../model/conversation.js';
import type { ModelIdentity } from '../model/identity.js';
import type { ModelMessage } from '../model/message.js';
import type { MessageRole } from '../types/constants.js';
import type {
  EventId,
  InputId,
  MessageId,
  PartId,
  RequestId,
  SessionId,
} from '../types/identifiers.js';
import type { JsonObject, JsonValue } from '../types/json.js';

export type TranscriptEventType =
  | 'session_created'
  | 'session_updated'
  | 'message_created'
  | 'part_created'
  | 'part_updated'
  | 'input_enqueued'
  | 'input_applied'
  | 'input_cancelled';

export type TranscriptPartType =
  | 'text'
  | 'reasoning'
  | 'image'
  | 'tool_call'
  | 'tool_result'
  | 'diff'
  | 'patch'
  | 'summary'
  | 'subtask_ref';

export interface TranscriptSession {
  sessionId: SessionId;
  rootId: SessionId;
  parentId?: SessionId;
  relationType?: 'subagent';
  title?: string;
  status?: 'running' | 'completed' | 'failed';
  agentType?: string;
  model?: string;
  permission?: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptMessage {
  messageId: MessageId;
  role: MessageRole;
  parentMessageId?: MessageId;
  createdAt: string;
  model?: string;
  modelIdentity?: ModelIdentity;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  providerOptions?: ModelMessage['providerOptions'];
  provenance?: ConversationMessage['provenance'];
  correlation?: ConversationMessage['correlation'];
  extensions?: JsonObject;
  /** Legacy pre-v7 flattened message metadata. */
  customMetadata?: JsonObject;
}

export interface TranscriptPart {
  partId: PartId;
  messageId: MessageId;
  partType: TranscriptPartType;
  payload: JsonValue;
  createdAt: string;
}

export interface PersistedPendingInput {
  inputId: InputId;
  content: JsonValue;
  priority: 'now' | 'next' | 'later';
  targetRequestId?: RequestId;
  acceptedAt: number;
}

export interface PersistedAppliedInput {
  inputId: InputId;
  requestId: RequestId;
  messageId: MessageId;
  appliedAt: number;
}

export interface PersistedCancelledInput {
  inputId: InputId;
  reason: string;
  cancelledAt: number;
}

export interface TranscriptEventBase {
  id: EventId;
  sessionId: SessionId;
  timestamp: string;
  type: TranscriptEventType;
  cwd?: string;
  gitBranch?: string;
  version: string;
}

export type TranscriptEvent =
  | (TranscriptEventBase & { type: 'session_created'; data: TranscriptSession })
  | (TranscriptEventBase & { type: 'session_updated'; data: Partial<TranscriptSession> })
  | (TranscriptEventBase & { type: 'message_created'; data: TranscriptMessage })
  | (TranscriptEventBase & { type: 'part_created'; data: TranscriptPart })
  | (TranscriptEventBase & { type: 'part_updated'; data: TranscriptPart })
  | (TranscriptEventBase & { type: 'input_enqueued'; data: PersistedPendingInput })
  | (TranscriptEventBase & { type: 'input_applied'; data: PersistedAppliedInput })
  | (TranscriptEventBase & { type: 'input_cancelled'; data: PersistedCancelledInput });
