import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const runtimeWorkspaceModulePath = '../../packages/agent-sdk/src/session/runtimeWorkspace.js';
const runtimeWorkspaceSourcePath = 'packages/agent-sdk/src/session/runtimeWorkspace.ts';

describe('agent-sdk package-local runtime workspace helpers', () => {
  it('prepares turn-scoped workspace updates without session runtime state', async () => {
    expect(existsSync(runtimeWorkspaceSourcePath)).toBe(true);

    const { preparePackageLocalRuntimeWorkspaceTurn } = await import(runtimeWorkspaceModulePath);
    const workspace = {
      updateWorkspace: vi.fn(),
    };

    preparePackageLocalRuntimeWorkspaceTurn({
      workspace,
      snapshot: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        context: {},
        filesystemRoots: ['/workspace'],
        cwd: '/workspace/project',
        environment: {
          NODE_ENV: 'test',
          cwd: '/stale',
        },
      },
    });

    preparePackageLocalRuntimeWorkspaceTurn({
      workspace,
      snapshot: {
        sessionId: 'session-1',
        turnId: 'turn-2',
        context: {},
        filesystemRoots: [],
        cwd: undefined,
        environment: {
          NODE_ENV: 'production',
        },
      },
    });

    expect(workspace.updateWorkspace).toHaveBeenNthCalledWith(1, {
      projectPath: '/workspace/project',
      environment: {
        NODE_ENV: 'test',
        cwd: '/workspace/project',
      },
    });
    expect(workspace.updateWorkspace).toHaveBeenNthCalledWith(2, {
      projectPath: undefined,
      environment: {
        NODE_ENV: 'production',
      },
    });
  });
});
