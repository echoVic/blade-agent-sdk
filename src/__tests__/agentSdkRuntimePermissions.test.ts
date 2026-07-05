import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PackageLocalRuntimePermissionHookPort } from '../../packages/agent-sdk/src/session/runtimePermissions.js';
import type { JsonObject } from '../../packages/agent-sdk/src/types/common.js';
import type { PermissionHandlerRequest } from '../../packages/agent-sdk/src/types/permissions.js';
import { ToolKind } from '../../packages/agent-sdk/src/tools/types/ToolKind.js';

const permissionsModulePath = '../../packages/agent-sdk/src/session/runtimePermissions.js';
const permissionsSourcePath = 'packages/agent-sdk/src/session/runtimePermissions.ts';

function permissionRequest(input: JsonObject): PermissionHandlerRequest {
  return {
    toolName: 'CustomTool',
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

describe('agent-sdk package-local runtime permission helpers', () => {
  it('returns no handler when no permission callbacks or base handler are configured', async () => {
    expect(existsSync(permissionsSourcePath)).toBe(true);

    const { createPackageLocalRuntimePermissionHandler } = await import(permissionsModulePath);

    expect(
      createPackageLocalRuntimePermissionHandler({
        hasPermissionCallbacks: false,
        permissionHooks: {
          async applyPermissionRequestHooks() {
            throw new Error('should not run');
          },
        },
      }),
    ).toBeUndefined();
  });

  it('runs permission hooks before base handlers and applies updated input', async () => {
    const { createPackageLocalRuntimePermissionHandler } = await import(permissionsModulePath);
    const baseHandler = vi.fn(async () => ({ behavior: 'allow' as const }));
    const hookCalls: unknown[] = [];
    const abortController = new AbortController();
    const permissionHooks: PackageLocalRuntimePermissionHookPort = {
      async applyPermissionRequestHooks(toolName, input, options) {
        hookCalls.push([toolName, { ...input }, options]);
        return {
          updatedInput: {
            ...input,
            value: 'from-hook',
          },
        };
      },
    };
    const handler = createPackageLocalRuntimePermissionHandler({
      hasPermissionCallbacks: true,
      permissionHandler: baseHandler,
      permissionHooks,
    });

    const request = {
      ...permissionRequest({ value: 'original' }),
      signal: abortController.signal,
    };
    const result = await handler?.(request);

    expect(hookCalls).toEqual([
      [
        'CustomTool',
        { value: 'original' },
        {
          affectedPaths: ['/workspace/file.ts'],
          toolKind: ToolKind.Write,
          abortSignal: abortController.signal,
        },
      ],
    ]);
    expect(request.input).toEqual({ value: 'from-hook' });
    expect(baseHandler).toHaveBeenCalledWith(request);
    expect(result).toEqual({ behavior: 'ask' });
  });

  it('lets permission hook decisions bypass the base handler', async () => {
    const { createPackageLocalRuntimePermissionHandler } = await import(permissionsModulePath);
    const baseHandler = vi.fn(async () => ({ behavior: 'allow' as const }));
    const permissionHooks: PackageLocalRuntimePermissionHookPort = {
      async applyPermissionRequestHooks(_toolName, input) {
        return {
          updatedInput: input,
          decision: { behavior: 'deny', message: 'blocked by hook' },
        };
      },
    };
    const handler = createPackageLocalRuntimePermissionHandler({
      hasPermissionCallbacks: true,
      permissionHandler: baseHandler,
      permissionHooks,
    });

    const result = await handler?.(permissionRequest({ value: 'original' }));

    expect(baseHandler).not.toHaveBeenCalled();
    expect(result).toEqual({ behavior: 'deny', message: 'blocked by hook' });
  });
});
