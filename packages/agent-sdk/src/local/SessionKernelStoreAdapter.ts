import type { JsonObject, ModelMessage, ModelToolCall } from '@blade-ai/ai';
import type { AgentStoreAppendContext, AgentStorePort } from '@blade-ai/agent/state';

/** Minimal interface for a message store — avoids depending on root ContextManager. */
export interface SessionMessageStore {
  addMessage(role: string, content: unknown, metadata: JsonObject): Promise<void>;
}

export interface KernelStorePortOptions {
  contextManager: SessionMessageStore;
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
): JsonObject {
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

function toSessionToolCall(toolCall: ModelToolCall): JsonObject {
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
