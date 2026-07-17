import type { AgentToolCall, AgentToolResult } from '@blade-ai/agent/protocol';

/**
 * Minimal interface for an execution pipeline.
 * Used by SessionKernelAdapter to avoid depending on the root ExecutionPipeline class.
 */
export interface ExecutionPipelineLike {
  execute(toolCall: AgentToolCall, context: unknown): Promise<AgentToolResult>;
}

/**
 * Minimal interface for a tool registry.
 * Used by SessionKernelAdapter to avoid depending on the root ToolRegistry class.
 */
export interface ToolRegistryLike {
  getTool(toolName: string): unknown;
}
