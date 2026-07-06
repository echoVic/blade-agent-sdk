import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../packages/agent-sdk/src/types/common.js';
import type { PermissionHandlerRequest } from '../../packages/agent-sdk/src/types/permissions.js';
import { ToolKind } from '../../packages/agent-sdk/src/tools/types/ToolKind.js';

const runtimeGuardsModulePath = '../../packages/agent-sdk/src/session/runtimeGuards.js';
const runtimeGuardsSourcePath = 'packages/agent-sdk/src/session/runtimeGuards.ts';

function permissionRequest(input: JsonObject): PermissionHandlerRequest {
  return {
    toolName: 'Edit',
    input,
    signal: new AbortController().signal,
    affectedPaths: ['/workspace/file.ts'],
    toolKind: ToolKind.Write,
    toolMeta: {
      isReadOnly: false,
      isConcurrencySafe: false,
      isDestructive: false,
    },
  };
}

describe('agent-sdk package-local runtime guard operations', () => {
  it('bundles hook initialization and permission handling behind injected ports', async () => {
    expect(existsSync(runtimeGuardsSourcePath)).toBe(true);

    const { createPackageLocalRuntimeGuardOperations } = await import(runtimeGuardsModulePath);
    const enable = vi.fn();
    const baseHandler = vi.fn(async () => ({ behavior: 'allow' as const }));
    const operations = createPackageLocalRuntimeGuardOperations({
      hooks: {
        UserPromptSubmit: [async () => ({ action: 'continue' })],
        PermissionRequest: [async () => undefined],
      },
      hookManager: {
        enable,
      },
      permissionHooks: {
        async applyPermissionRequestHooks(_toolName: string, input: JsonObject) {
          return {
            updatedInput: {
              ...input,
              approvedBy: 'hook',
            },
          };
        },
      },
      permissionHandler: baseHandler,
    });

    operations.hooks.initialize();
    const request = permissionRequest({ path: 'file.ts' });
    const result = await operations.permissions.createPermissionHandler()?.(request);

    expect(enable).toHaveBeenCalledOnce();
    expect(request.input).toEqual({
      path: 'file.ts',
      approvedBy: 'hook',
    });
    expect(baseHandler).toHaveBeenCalledWith(request);
    expect(result).toEqual({ behavior: 'ask' });
  });
});
