import Type from 'typebox';
import { describe, expect, it } from 'vitest';
import { ToolKind } from '../behavior.js';
import { createTool } from '../core/createTool.js';
import { completeToolExecution } from '../types/result.js';

describe('runtime Tool shape', () => {
  it('exposes precomputed data and prepares an immutable invocation snapshot', () => {
    const tool = createTool({
      name: 'SnapshotTool',
      displayName: 'Snapshot Tool',
      kind: ToolKind.Write,
      sideEffect: 'idempotent',
      strict: true,
      description: { short: 'Writes one file' },
      schema: Type.Object({
        file_path: Type.String(),
      }),
      preparePermissionMatcher: ({ file_path }) => ({
        signatureContent: file_path,
      }),
      execute: ({ file_path }) =>
        completeToolExecution({
          status: 'success',
          model: file_path,
        }),
    });

    expect(tool).toMatchObject({
      name: 'SnapshotTool',
      title: 'Snapshot Tool',
      staticBehavior: {
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
      },
      declaration: {
        name: 'SnapshotTool',
        description: 'Writes one file',
        strict: true,
      },
    });
    expect('build' in tool).toBe(false);
    expect('describe' in tool).toBe(false);
    expect('getMetadata' in tool).toBe(false);
    expect('getFunctionDeclaration' in tool).toBe(false);

    const invocation = tool.prepare({
      file_path: '/tmp/example.txt',
    });

    expect(invocation).toEqual({
      params: {
        file_path: '/tmp/example.txt',
      },
      behavior: {
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
        isReadOnly: false,
        isConcurrencySafe: false,
        isDestructive: false,
        interruptBehavior: 'block',
      },
      affectedPaths: ['/tmp/example.txt'],
      permissionSignature: 'SnapshotTool:/tmp/example.txt',
      description: 'Writes one file',
    });
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.params)).toBe(true);
    expect(Object.isFrozen(invocation.behavior)).toBe(true);
    expect(Object.isFrozen(invocation.affectedPaths)).toBe(true);
  });
});
