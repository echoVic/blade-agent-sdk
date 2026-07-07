import {
  createPackageLocalRuntimeSessionLifecycleOperations,
  type PackageLocalRuntimeSessionLifecycleOperations,
  type PackageLocalRuntimeSessionLifecycleOperationsOptions,
} from './runtimeSessionLifecycle.js';
import {
  createPackageLocalRuntimeWorkspaceOperations,
  type PackageLocalRuntimeWorkspaceOperations,
  type PackageLocalRuntimeWorkspacePort,
} from './runtimeWorkspace.js';

export interface PackageLocalRuntimeSessionOperationsOptions<TMessage>
  extends PackageLocalRuntimeSessionLifecycleOperationsOptions<TMessage> {
  workspace: PackageLocalRuntimeWorkspacePort;
}

export interface PackageLocalRuntimeSessionOperations<TMessage> {
  lifecycle: PackageLocalRuntimeSessionLifecycleOperations<TMessage>;
  workspace: PackageLocalRuntimeWorkspaceOperations;
}

export function createPackageLocalRuntimeSessionOperations<TMessage>(
  options: PackageLocalRuntimeSessionOperationsOptions<TMessage>,
): PackageLocalRuntimeSessionOperations<TMessage> {
  return {
    lifecycle: createPackageLocalRuntimeSessionLifecycleOperations({
      sessionId: options.sessionId,
      sessionStore: options.sessionStore,
      hookRuntime: options.hookRuntime,
      model: options.model,
      provider: options.provider,
      closeRuntimeResources: options.closeRuntimeResources,
    }),
    workspace: createPackageLocalRuntimeWorkspaceOperations({
      workspace: options.workspace,
    }),
  };
}
