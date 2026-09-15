import type { ExecutionContext } from '../../types/execution.js';
import type { Tool } from '../../types/tool.js';

export function getToolContext(tool: Tool, context: ExecutionContext): ExecutionContext {
  if (tool.requiresRuntime) {
    return context;
  }
  const { runtime: _runtime, ...base } = context;
  return Object.freeze(base);
}
