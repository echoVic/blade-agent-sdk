import type { ContextSnapshot } from '../runtime/types.js';

export interface PackageLocalRuntimeWorkspaceUpdate {
  projectPath: string | undefined;
  environment: Record<string, string>;
}

export interface PackageLocalRuntimeWorkspacePort {
  updateWorkspace(update: PackageLocalRuntimeWorkspaceUpdate): void;
}

export interface PackageLocalRuntimeWorkspaceTurnOptions {
  workspace: PackageLocalRuntimeWorkspacePort;
  snapshot: ContextSnapshot;
}

export function preparePackageLocalRuntimeWorkspaceTurn(
  options: PackageLocalRuntimeWorkspaceTurnOptions,
): void {
  options.workspace.updateWorkspace({
    projectPath: options.snapshot.cwd,
    environment: {
      ...options.snapshot.environment,
      ...(options.snapshot.cwd ? { cwd: options.snapshot.cwd } : {}),
    },
  });
}
