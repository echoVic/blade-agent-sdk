import type { JsonObject } from '../types/common.js';
import type { Tool, ToolResult } from '../tools/types/index.js';

/**
 * Minimal structural interface for an execution pipeline (slice #336).
 * Used by SessionKernelAdapter to avoid depending on the root
 * ExecutionPipeline class. Aligned to the REAL pipeline API shape:
 * `execute(toolName, params, context): Promise<ToolResult>` — both the root
 * ExecutionPipeline (src/tools/execution/ExecutionPipeline.ts) and the
 * package session-runtime pipeline satisfy it structurally.
 */
export interface ExecutionPipelineLike {
  execute(toolName: string, params: JsonObject, context: unknown): Promise<ToolResult>;
}

/**
 * Minimal structural interface for a tool registry (slice #336).
 * Used by SessionKernelAdapter to avoid depending on the concrete
 * ToolRegistry class. Aligned to the real package ToolRegistry API:
 * `get(name): Tool | undefined` and `getAll(): Tool[]`.
 */
export interface ToolRegistryLike {
  get(name: string): Tool | undefined;
  getAll(): Tool[];
}
