import { describe, expect, it } from 'vitest';
import {
  PermissionMode,
  ToolKind,
  createCompositePermissionHandler,
  createModePermissionHandler,
  createPathSafetyPermissionHandler,
  createRuleBasedPermissionHandler,
} from '../../packages/agent-sdk/src/index.js';

function createRequest(
  overrides: Partial<Parameters<ReturnType<typeof createModePermissionHandler>>[0]> = {},
) {
  return {
    toolName: 'ExampleTool',
    input: {},
    signal: new AbortController().signal,
    permissionMode: PermissionMode.DEFAULT,
    affectedPaths: [],
    toolKind: ToolKind.Execute,
    toolMeta: {
      isReadOnly: false,
      isConcurrencySafe: true,
      isDestructive: false,
    },
    ...overrides,
  };
}

describe('agent-sdk root permission exports', () => {
  it('uses package-local permission factories through the root entry', async () => {
    const modeHandler = createModePermissionHandler(PermissionMode.DEFAULT);
    const ruleHandler = createRuleBasedPermissionHandler({
      allow: ['Read:/tmp/example.ts'],
    });
    const pathHandler = createPathSafetyPermissionHandler();
    const compositeHandler = createCompositePermissionHandler([
      async () => ({
        behavior: 'allow',
        updatedInput: { normalized: true },
      }),
      async (request) => ({
        behavior: 'allow',
        updatedInput: { normalized: request.input.normalized === true },
      }),
    ]);

    await expect(
      modeHandler(createRequest({
        permissionMode: PermissionMode.PLAN,
        toolKind: ToolKind.Write,
      })),
    ).resolves.toMatchObject({
      behavior: 'deny',
    });

    await expect(
      ruleHandler(createRequest({
        toolName: 'Read',
        toolKind: ToolKind.ReadOnly,
        toolMeta: {
          isReadOnly: true,
          isConcurrencySafe: true,
          isDestructive: false,
          signature: 'Read:/tmp/example.ts',
        },
      })),
    ).resolves.toEqual({
      behavior: 'allow',
    });

    await expect(
      pathHandler(createRequest({
        affectedPaths: ['/etc/passwd'],
      })),
    ).resolves.toEqual({
      behavior: 'deny',
      message: 'Access to dangerous system paths denied: /etc/passwd',
    });

    await expect(
      compositeHandler(createRequest({
        input: {},
      })),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { normalized: true },
    });
  });
});
