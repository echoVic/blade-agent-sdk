import type { ExecutionContext } from '../tools/types/execution.js';
import type { ToolExecution } from '../tools/types/result.js';
import type { JsonObject } from '../types/json.js';
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
 * bound to the model-selected tool. A short circuit must be side-effect-free;
 * committed effects belong in tools with an explicit sideEffect contract.
 */
export type ToolMiddleware = Middleware<ToolMiddlewareRequest, ToolExecution>;
