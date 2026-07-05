import type { SubagentConfig } from '../subagents/types.js';
import type { SessionOptions } from './types.js';

type PackageLocalRuntimeAgentDefinition = NonNullable<SessionOptions['agents']>[string];

export function packageLocalSubagentConfigFromDefinition(
  name: string,
  definition: PackageLocalRuntimeAgentDefinition,
): SubagentConfig {
  return {
    name: definition.name || name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    tools: definition.allowedTools,
    model: definition.model ?? 'inherit',
    source: 'session',
  };
}
