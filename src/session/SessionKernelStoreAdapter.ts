import type { JsonObject, ModelMessage, ModelToolCall } from '@blade-ai/ai';
import type { AgentStoreAppendContext, AgentStorePort } from '@blade-ai/agent/state';
import type { ContextManager } from '../context/ContextManager.js';
import type { JsonObject as SdkJsonObject } from '../types/common.js';

export interface KernelStorePortOptions {
  contextManager: ContextManager;
}

export function createKernelStorePort(options: KernelStorePortOptions): AgentStorePort {
  return {
    async appendMessage(message, context) {
      await options.contextManager.addMessage(
        message.role,
        message.content,
        buildMessageMetadata(message, context),
      );
    },
  };
}

function buildMessageMetadata(
  message: ModelMessage,
  context: AgentStoreAppendContext,
): SdkJsonObject {
  return {
    kernel: {
      ...(context.turnId ? { turnId: context.turnId } : {}),
      source: context.source,
      step: context.step,
    },
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls && message.toolCalls.length > 0
      ? { toolCalls: message.toolCalls.map(toSessionToolCall) }
      : {}),
    ...(isJsonObject(message.metadata) ? { modelMetadata: message.metadata } : {}),
  };
}

function toSessionToolCall(toolCall: ModelToolCall): SdkJsonObject {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input),
    },
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
