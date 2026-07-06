import type { SubagentConfig } from '../subagents/types.js';
import type { SessionOptions } from './types.js';

type PackageLocalRuntimeAgentDefinition = NonNullable<SessionOptions['agents']>[string];

export interface PackageLocalRuntimeSubagentRegistryPort {
  setLogger(logger: unknown): void;
  setProjectDir(projectDir?: string): void;
  loadFromStandardLocations(projectDir?: string, storageRoot?: string): number | undefined;
  register(config: SubagentConfig, options?: { override?: boolean }): void;
}

export interface PackageLocalRuntimeSubagentInitializationOptions {
  subagentRegistry: PackageLocalRuntimeSubagentRegistryPort;
  logger: unknown;
  projectPath?: string;
  storageRoot?: string;
  agents?: SessionOptions['agents'];
}

export interface PackageLocalRuntimeSubagentOperations {
  initialize(): void;
}

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

export function initializePackageLocalRuntimeSubagents(
  options: PackageLocalRuntimeSubagentInitializationOptions,
): void {
  options.subagentRegistry.setLogger(options.logger);
  options.subagentRegistry.setProjectDir(options.projectPath);
  options.subagentRegistry.loadFromStandardLocations(options.projectPath, options.storageRoot);

  for (const [name, definition] of Object.entries(options.agents ?? {})) {
    options.subagentRegistry.register(packageLocalSubagentConfigFromDefinition(name, definition), {
      override: true,
    });
  }
}

export function createPackageLocalRuntimeSubagentOperations(
  options: PackageLocalRuntimeSubagentInitializationOptions,
): PackageLocalRuntimeSubagentOperations {
  return {
    initialize() {
      initializePackageLocalRuntimeSubagents(options);
    },
  };
}
