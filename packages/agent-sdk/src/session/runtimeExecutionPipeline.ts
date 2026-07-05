import {
  PermissionMode,
  type BladeConfig,
  type PermissionsConfig,
} from '../types/common.js';
import type { PermissionHandler } from '../types/permissions.js';

export interface PackageLocalRuntimeExecutionPipelineCreateOptions {
  permissionConfig: Required<PermissionsConfig>;
  permissionMode: PermissionMode;
  maxHistorySize: number;
  permissionHandler: PermissionHandler | undefined;
  logger: unknown;
  toolCatalog: unknown;
}

export interface PackageLocalRuntimeExecutionPipelineFactoryPort {
  create(options: PackageLocalRuntimeExecutionPipelineCreateOptions): unknown;
}

export interface PackageLocalRuntimeExecutionPipelineOptions {
  bladeConfig: BladeConfig;
  permissionMode?: PermissionMode;
  permissionHandler: PermissionHandler | undefined;
  logger: unknown;
  toolCatalog: unknown;
  executionPipelineFactory: PackageLocalRuntimeExecutionPipelineFactoryPort;
  maxHistorySize?: number;
}

export function createPackageLocalRuntimeExecutionPipeline(
  options: PackageLocalRuntimeExecutionPipelineOptions,
): unknown {
  const permissionConfig: Required<PermissionsConfig> = {
    allow: [],
    ask: [],
    deny: [],
    ...options.bladeConfig.permissions,
  };

  return options.executionPipelineFactory.create({
    permissionConfig,
    permissionMode: options.permissionMode ?? PermissionMode.DEFAULT,
    maxHistorySize: options.maxHistorySize ?? 1000,
    permissionHandler: options.permissionHandler,
    logger: options.logger,
    toolCatalog: options.toolCatalog,
  });
}
