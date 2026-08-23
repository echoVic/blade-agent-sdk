import type { ExecutionContext, ToolExecution } from '../tools/types/index.js';
import type { JsonObject } from '../types/common.js';
import type { Middleware } from './composeMiddleware.js';

export interface ToolMiddlewareRequest {
  readonly toolName: string;
  readonly input: JsonObject;
  readonly context: ExecutionContext;
}

/**
 * Wraps one complete tool execution, including streamed progress and effects.
 *
 * Middleware may replace input by passing a new request to next(), short-circuit
 * by returning its own ToolExecution, or transform the final ToolResult while
 * unwinding. The tool name is immutable so durable lifecycle records remain
 * bound to the model-selected tool.
 */
export type ToolMiddleware = Middleware<ToolMiddlewareRequest, ToolExecution>;
