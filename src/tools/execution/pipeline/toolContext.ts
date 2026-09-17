import type { ToolServices } from '../../services.js';
import type { ExecutionContext } from '../../types/execution.js';
import type { Tool } from '../../types/tool.js';

export function getToolContext(
  tool: Tool,
  context: ExecutionContext,
  services: ToolServices,
): ExecutionContext & ToolServices {
  const {
    runtime: _runtime,
    backgroundAgentManager: _backgroundAgentManager,
    skillRegistry: _skillRegistry,
    discoverableCatalog: _discoverableCatalog,
    ...base
  } = context;
  const executionServices =
    services.discoverableCatalog && context.discoverableCatalog
      ? { ...services, discoverableCatalog: context.discoverableCatalog }
      : services;
  return Object.freeze({
    ...base,
    ...executionServices,
    ...(tool.requiresRuntime ? { runtime: context.runtime } : {}),
  });
}
