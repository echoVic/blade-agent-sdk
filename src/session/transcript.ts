import type { InputId, RequestId, SessionId } from '../types/identifiers.js';
import type { JsonValue } from '../types/json.js';

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

export interface PersistedPendingInput {
  inputId: InputId;
  content: JsonValue;
  priority: 'now' | 'next' | 'later';
  targetRequestId?: RequestId;
  acceptedAt: number;
}
