import type { AgentPermissionUpdate, AgentStreamEvent } from '@blade-ai/agent';
import type { TokenUsage } from '../types/common.js';
import type { PermissionUpdate } from '../types/permissions.js';
import type { SessionId, StreamMessage } from './types.js';

export interface PackageLocalRuntimeKernelStreamProjectionOptions {
  sessionId: SessionId;
  maxContextTokens: number;
  includeThinking: boolean;
}

export function projectPackageLocalKernelEventToStreamMessages(
  event: AgentStreamEvent,
  options: PackageLocalRuntimeKernelStreamProjectionOptions,
): StreamMessage[] {
  switch (event.type) {
    case 'content':
      return [{ type: 'content', delta: event.delta, sessionId: options.sessionId }];
    case 'thinking':
      return options.includeThinking
        ? [{ type: 'thinking', delta: event.delta, sessionId: options.sessionId }]
        : [];
    case 'tool_use':
      return [
        {
          type: 'tool_use',
          id: event.toolCall.id,
          name: event.toolCall.name,
          input: event.toolCall.input,
          sessionId: options.sessionId,
        },
      ];
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          id: event.result.id,
          name: event.result.name,
          output: event.result.output,
          ...(event.result.isError ? { isError: true } : {}),
          sessionId: options.sessionId,
        },
      ];
    case 'tool_permission_updates':
      return [
        {
          type: 'tool_permission_updates',
          id: event.toolCall.id,
          name: event.toolCall.name,
          updates: toPackageLocalSessionPermissionUpdates(event.updates),
          sessionId: options.sessionId,
        },
      ];
    case 'usage':
      return [
        {
          type: 'usage',
          usage: toPackageLocalSessionUsage(event.usage, options.maxContextTokens),
          sessionId: options.sessionId,
        },
      ];
    case 'budget_warning':
      return [
        {
          type: 'budget_warning',
          snapshot: event.snapshot,
          sessionId: options.sessionId,
        },
      ];
    case 'budget_exhausted':
      return [
        {
          type: 'budget_exhausted',
          snapshot: event.snapshot,
          sessionId: options.sessionId,
        },
      ];
    case 'result':
      return [
        { type: 'turn_end', turn: 1, sessionId: options.sessionId },
        {
          type: 'result',
          subtype: 'success',
          content: event.content,
          sessionId: options.sessionId,
        },
      ];
    case 'error':
      return [
        {
          type: 'error',
          message: event.message,
          ...(event.code ? { code: event.code } : {}),
          sessionId: options.sessionId,
        },
      ];
    default:
      return [];
  }
}

function toPackageLocalSessionUsage(
  usage: Extract<AgentStreamEvent, { type: 'usage' }>['usage'],
  maxContextTokens: number,
): TokenUsage {
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    maxContextTokens,
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheMissInputTokens !== undefined
      ? { cacheMissInputTokens: usage.cacheMissInputTokens }
      : {}),
    ...(usage.billableInputTokens !== undefined
      ? { billableInputTokens: usage.billableInputTokens }
      : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
}

function toPackageLocalSessionPermissionUpdates(
  updates: readonly AgentPermissionUpdate[],
): PermissionUpdate[] {
  return updates.map((update) => {
    const rules = update.rules.map((rule) => ({
      toolName: rule.toolName,
      ...(rule.ruleContent !== undefined ? { ruleContent: rule.ruleContent } : {}),
    }));

    return update.type === 'addRules'
      ? {
          type: 'addRules' as const,
          behavior: update.behavior,
          rules,
        }
      : {
          type: 'removeRules' as const,
          rules,
        };
  });
}
