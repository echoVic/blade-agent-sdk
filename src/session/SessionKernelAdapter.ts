import type { AgentToolCall, AgentToolPort, AgentToolResult } from '@blade-ai/agent';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { ExecutionContext } from '../tools/types/index.js';
import type { JsonObject, JsonValue } from '../types/common.js';

export interface KernelToolPortOptions {
  registry: ToolRegistry;
  pipeline: ExecutionPipeline;
  createExecutionContext: (toolCall: AgentToolCall, signal?: AbortSignal) => ExecutionContext;
}

export function createKernelToolPort(options: KernelToolPortOptions): AgentToolPort {
  return {
    async list() {
      return options.registry.getAll().map((tool) => ({
        id: tool.name,
        name: tool.name,
        input: {},
      }));
    },
    async execute(toolCall, signal) {
      const result = await options.pipeline.execute(
        toolCall.name,
        toolCall.input as JsonObject,
        {
          ...options.createExecutionContext(toolCall, signal),
          signal,
        },
      );

      return {
        id: toolCall.id,
        name: toolCall.name,
        output: normalizeKernelToolOutput(result.llmContent),
        ...(!result.success ? { isError: true } : {}),
      } satisfies AgentToolResult;
    },
  };
}

function normalizeKernelToolOutput(output: string | object): string | JsonObject {
  if (typeof output === 'string') {
    return output;
  }

  return isJsonObject(output) ? output : JSON.stringify(output);
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonObject(value);
}
