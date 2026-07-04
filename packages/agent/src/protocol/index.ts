import type {
  JsonObject,
  JsonValue,
  ModelUsageInfo,
} from '@blade-ai/ai';

export type AgentMessageContent = string | Array<{ type: 'text'; text: string }>;

export interface AgentUserMessage {
  role: 'user';
  content: AgentMessageContent;
  metadata?: JsonValue;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: JsonObject;
}

export interface AgentPermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export type AgentPermissionUpdate =
  | {
      type: 'addRules';
      rules: readonly AgentPermissionRuleValue[];
      behavior: 'allow' | 'deny';
    }
  | {
      type: 'removeRules';
      rules: readonly AgentPermissionRuleValue[];
    };

export type AgentToolEffect =
  | {
      type: 'permissionUpdates';
      updates: readonly AgentPermissionUpdate[];
    };

export interface AgentToolResult {
  id: string;
  name: string;
  output: string | JsonObject;
  isError?: boolean;
  effects?: readonly AgentToolEffect[];
}

export type AgentStreamEvent =
  | { type: 'content'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; toolCall: AgentToolCall }
  | {
      type: 'tool_permission_updates';
      toolCall: AgentToolCall;
      updates: readonly AgentPermissionUpdate[];
    }
  | { type: 'tool_result'; result: AgentToolResult }
  | { type: 'usage'; usage: ModelUsageInfo }
  | { type: 'result'; content: string; finishReason?: string }
  | { type: 'error'; message: string; code?: string };
