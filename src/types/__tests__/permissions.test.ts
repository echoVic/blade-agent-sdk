import { describe, expect, it } from 'vitest';
import { ToolKind } from '../../tools/types/ToolTypes.js';
import { PermissionMode } from '../common.js';
import {
  createCompositePermissionHandler,
  createModePermissionHandler,
  createPathSafetyPermissionHandler,
  createRuleBasedPermissionHandler,
} from '../permissions.js';

function createRequest(overrides: Partial<Parameters<ReturnType<typeof createModePermissionHandler>>[0]> = {}) {
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

describe('createModePermissionHandler', () => {
  it('denies non-readonly tools in plan mode', async () => {
    const handler = createModePermissionHandler(PermissionMode.DEFAULT);

    const result = await handler(createRequest({
      permissionMode: PermissionMode.PLAN,
      toolKind: ToolKind.Write,
      toolMeta: {
        isReadOnly: false,
        isConcurrencySafe: false,
        isDestructive: false,
      },
    }));

    expect(result).toEqual({
      behavior: 'deny',
      message:
        'Plan mode: modification tools are blocked; only read-only tools are allowed (Read/Glob/Grep/WebFetch/WebSearch/Task)',
    });
  });

  it('auto-allows readonly tools even when the default mode is ask-oriented', async () => {
    const handler = createModePermissionHandler(PermissionMode.DEFAULT);

    const result = await handler(createRequest({
      toolKind: ToolKind.ReadOnly,
      toolMeta: {
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
      },
    }));

    expect(result).toEqual({
      behavior: 'allow',
    });
  });

  it('uses the factory default mode when the request does not override it', async () => {
    const handler = createModePermissionHandler(PermissionMode.YOLO);

    const result = await handler(createRequest({
      permissionMode: undefined,
    }));

    expect(result).toEqual({
      behavior: 'allow',
    });
  });
});

describe('createRuleBasedPermissionHandler', () => {
  it('matches signature-scoped allow rules', async () => {
    const handler = createRuleBasedPermissionHandler({
      allow: ['Read:/tmp/example.ts'],
    });

    const result = await handler(createRequest({
      toolName: 'Read',
      toolKind: ToolKind.ReadOnly,
      toolMeta: {
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
        signature: 'Read:/tmp/example.ts',
      },
    }));

    expect(result).toEqual({
      behavior: 'allow',
    });
  });

  it('falls back to ask when no rule matches', async () => {
    const handler = createRuleBasedPermissionHandler({
      allow: ['Read:/tmp/allowed.ts'],
    });

    const result = await handler(createRequest({
      toolName: 'Read',
      toolKind: ToolKind.ReadOnly,
      toolMeta: {
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
        signature: 'Read:/tmp/other.ts',
      },
    }));

    expect(result).toEqual({
      behavior: 'ask',
      message: 'Default: requires user confirmation',
    });
  });
});

describe('createPathSafetyPermissionHandler', () => {
  it('denies dangerous system paths', async () => {
    const handler = createPathSafetyPermissionHandler();

    const result = await handler(createRequest({
      affectedPaths: ['/etc/passwd'],
    }));

    expect(result).toEqual({
      behavior: 'deny',
      message: 'Access to dangerous system paths denied: /etc/passwd',
    });
  });

  it('denies highly sensitive files without an explicit allow rule', async () => {
    const handler = createPathSafetyPermissionHandler();

    const result = await handler(createRequest({
      toolName: 'Read',
      toolKind: ToolKind.ReadOnly,
      affectedPaths: ['/tmp/id_rsa'],
      toolMeta: {
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
        signature: 'Read:/tmp/id_rsa',
      },
    }));

    expect(result.behavior).toBe('deny');
    if (result.behavior !== 'deny') {
      throw new Error('Expected deny result');
    }
    expect(result.message).toContain('Access to highly sensitive files denied');
    expect(result.message).toContain('/tmp/id_rsa');
  });

  it('requires confirmation for explicitly allowed sensitive files', async () => {
    const handler = createPathSafetyPermissionHandler({
      explicitAllowRules: ['Read:/tmp/id_rsa'],
    });

    const result = await handler(createRequest({
      toolName: 'Read',
      toolKind: ToolKind.ReadOnly,
      affectedPaths: ['/tmp/id_rsa'],
      toolMeta: {
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
        signature: 'Read:/tmp/id_rsa',
      },
    }));

    expect(result.behavior).toBe('ask');
    if (result.behavior !== 'ask') {
      throw new Error('Expected ask result');
    }
    expect(result.message).toContain('Sensitive file access detected');
    expect(result.message).toContain('/tmp/id_rsa');
  });
});

describe('createCompositePermissionHandler', () => {
  it('threads updated input and merged allow effects through the handler chain', async () => {
    const handler = createCompositePermissionHandler([
      async () => ({
        behavior: 'allow',
        updatedInput: { value: 'patched' },
        effects: [{ type: 'permissionUpdates', updates: [] }],
      }),
      async (request) => ({
        behavior: 'allow',
        updatedInput: {
          value: String(request.input.value ?? ''),
          verified: true,
        },
      }),
    ]);

    const result = await handler(createRequest({
      input: { value: 'original' },
    }));

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { value: 'patched', verified: true },
      effects: [{ type: 'permissionUpdates', updates: [] }],
    });
  });

  it('returns the first ask result while preserving earlier allow updates', async () => {
    const handler = createCompositePermissionHandler([
      async () => ({
        behavior: 'allow',
        updatedInput: { value: 'patched' },
      }),
      async () => ({
        behavior: 'ask',
        message: 'Need confirmation',
      }),
    ]);

    const result = await handler(createRequest({
      input: { value: 'original' },
    }));

    expect(result).toEqual({
      behavior: 'ask',
      message: 'Need confirmation',
    });
  });
});
