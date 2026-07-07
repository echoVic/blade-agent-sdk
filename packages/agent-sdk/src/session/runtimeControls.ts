import type { RuntimeContext } from '../runtime/types.js';
import type { BladeConfig } from '../types/common.js';
import type { ISession, SessionOptions } from './types.js';
import { buildSessionModelConfig } from './config.js';
import { getPackageLocalRuntimeContextCwd } from './runtimeContext.js';

export interface PackageLocalRuntimeControlOperations {
  setDefaultContext(context: RuntimeContext): void;
  setPermissionMode(mode: Parameters<ISession['setPermissionMode']>[0]): void;
  setModel(model: Parameters<ISession['setModel']>[0]): Promise<void>;
  setMaxTurns(maxTurns: Parameters<ISession['setMaxTurns']>[0]): void;
}

export interface PackageLocalRuntimeControlOperationsOptions {
  options: SessionOptions;
  bladeConfig: BladeConfig;
  setDefaultContext(context: RuntimeContext): void;
  setProjectPath(projectPath?: string): void;
  resetExecutionPipeline(): void;
  markSubagentLocationsDirty(): void;
}

export function createPackageLocalRuntimeControlOperations(
  options: PackageLocalRuntimeControlOperationsOptions,
): PackageLocalRuntimeControlOperations {
  return {
    setDefaultContext(context) {
      options.setDefaultContext(context);
      options.setProjectPath(getPackageLocalRuntimeContextCwd(context));
      options.markSubagentLocationsDirty();
    },
    setPermissionMode(mode) {
      options.options.permissionMode = mode;
      options.resetExecutionPipeline();
    },
    async setModel(model) {
      options.options.model = model;
      const modelConfig = buildSessionModelConfig(options.options);
      options.bladeConfig.models = [modelConfig];
      options.bladeConfig.currentModelId = modelConfig.id;
    },
    setMaxTurns(maxTurns) {
      options.options.maxTurns = maxTurns;
    },
  };
}
