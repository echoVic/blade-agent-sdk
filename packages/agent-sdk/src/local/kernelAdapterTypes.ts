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
 * Mirrors the `get(name)` lookup used by both root and package ToolRegistry.
 */
export interface ToolRegistryLike {
  get(name: string): unknown;
}
