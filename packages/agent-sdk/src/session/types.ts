import type { RuntimeContext, RuntimeContextPatch, RuntimePatch } from '../runtime/types.js';
import type { JsonValue, TokenUsage } from '../types/common.js';
import type { PermissionUpdate } from '../types/permissions.js';

export type SessionId = string;
export type SessionMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface SessionToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface SessionTextContentPart {
  type: 'text';
  text: string;
}

export interface SessionImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type SessionContentPart = SessionTextContentPart | SessionImageContentPart;

export interface SessionMessage {
  id?: string;
  role: SessionMessageRole;
  content: string | SessionContentPart[];
  reasoningContent?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: SessionToolCall[];
  metadata?: JsonValue;
}

export type StreamMessage =
  | { type: 'turn_start'; turn: number; sessionId: SessionId }
  | { type: 'turn_end'; turn: number; sessionId: SessionId }
  | { type: 'content'; delta: string; sessionId: SessionId }
  | { type: 'thinking'; delta: string; sessionId: SessionId }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue; sessionId: SessionId }
  | { type: 'tool_progress'; id: string; name: string; message: string; sessionId: SessionId }
  | { type: 'tool_message'; id: string; name: string; message: string; sessionId: SessionId }
  | {
      type: 'tool_runtime_patch';
      id: string;
      name: string;
      patch: RuntimePatch;
      sessionId: SessionId;
    }
  | {
      type: 'tool_context_patch';
      id: string;
      name: string;
      patch: RuntimeContextPatch;
      sessionId: SessionId;
    }
  | {
      type: 'tool_new_messages';
      id: string;
      name: string;
      messages: SessionMessage[];
      sessionId: SessionId;
    }
  | {
      type: 'tool_permission_updates';
      id: string;
      name: string;
      updates: PermissionUpdate[];
      sessionId: SessionId;
    }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      output: string | object;
      isError?: boolean;
      sessionId: SessionId;
    }
  | { type: 'usage'; usage: TokenUsage; sessionId: SessionId }
  | {
      type: 'result';
      subtype: 'success' | 'error';
      content?: string;
      error?: string;
      sessionId: SessionId;
    }
  | { type: 'error'; message: string; code?: string; sessionId: SessionId };

export interface SendOptions {
  signal?: AbortSignal;
  maxTurns?: number;
  context?: RuntimeContext;
}

export interface StreamOptions {
  includeThinking?: boolean;
  runtime?: 'kernel' | 'legacy';
  /**
   * @deprecated Kernel runtime is now the default. Use `runtime: 'legacy'`
   * only when explicitly exercising the old session loop.
   */
  experimentalKernel?: boolean;
}
