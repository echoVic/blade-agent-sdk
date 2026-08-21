import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import { SessionId } from '../../../types/branded.js';
import { PermissionMode } from '../../../types/common.js';
import type { Tool, ToolResult } from '../../types/index.js';
import { ToolKind } from '../../types/ToolKind.js';
import { ExecutionPipeline } from '../ExecutionPipeline.js';

function registerTool<TParams>(registry: ToolRegistry, tool: Tool<TParams>): void {
  registry.register(tool as unknown as Tool);
}

describe('ExecutionPipeline', () => {
  it('does not expose stage-pipeline management on the default execution path', () => {
    const registry = new ToolRegistry();
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    expect('on' in (pipeline as unknown as Record<string, unknown>)).toBe(false);
    expect('getStages' in (pipeline as unknown as Record<string, unknown>)).toBe(false);
    expect('addStage' in (pipeline as unknown as Record<string, unknown>)).toBe(false);
    expect('removeStage' in (pipeline as unknown as Record<string, unknown>)).toBe(false);
  });

  it('uses resolved readonly behavior for plan-mode execution', async () => {
    const registry = new ToolRegistry();

    registerTool(
      registry,
      createTool({
        name: 'DynamicTool',
        displayName: 'Dynamic Tool',
        kind: ToolKind.Execute,
        description: { short: 'Dynamic behavior tool' },
        schema: z.object({
          mode: z.enum(['read', 'write']),
        }),
        resolveBehavior: ({ mode }) => ({
          kind: mode === 'read' ? ToolKind.ReadOnly : ToolKind.Write,
          isReadOnly: mode === 'read',
          isConcurrencySafe: mode === 'read',
          isDestructive: mode === 'write',
        }),
        execute: async ({ mode }) => ({
          success: true,
          llmContent: `ok:${mode}`,
        }),
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.PLAN,
    });

    const readResult = await pipeline.execute(
      'DynamicTool',
      { mode: 'read' },
      { permissionMode: PermissionMode.PLAN }
    );
    const writeResult = await pipeline.execute(
      'DynamicTool',
      { mode: 'write' },
      { permissionMode: PermissionMode.PLAN }
    );

    expect(readResult.success).toBe(true);
    expect(readResult.llmContent).toBe('ok:read');
    expect(writeResult.success).toBe(false);
    expect(writeResult.error?.message).toContain('Plan mode');
  });

  it('applies plan-mode policy after custom permission handlers run', async () => {
    const registry = new ToolRegistry();
    const permissionHandler = vi.fn(async () => ({ behavior: 'allow' as const }));

    registerTool(
      registry,
      createTool({
        name: 'WriteTool',
        displayName: 'Write Tool',
        kind: ToolKind.Write,
        description: { short: 'Write tool' },
        schema: z.object({
          value: z.string(),
        }),
        execute: async ({ value }) => ({
          success: true,
          llmContent: value,
        }),
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.PLAN,
      permissionHandler,
    });

    const result = await pipeline.execute(
      'WriteTool',
      { value: 'blocked' },
      { permissionMode: PermissionMode.PLAN }
    );

    expect(permissionHandler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Plan mode');
  });

  it('stops before execute when validateInput fails', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(async ({ value }: { value: string }): Promise<ToolResult> => ({
      success: true,
      llmContent: value,
    }));

    registerTool(
      registry,
      createTool({
        name: 'ValidatedTool',
        displayName: 'Validated Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Validated tool' },
        schema: z.object({
          value: z.string(),
        }),
        validateInput: ({ value }) =>
          value === 'bad'
            ? {
                message: 'Semantic validation failed',
              }
            : undefined,
        execute: executeSpy,
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const result = await pipeline.execute(
      'ValidatedTool',
      { value: 'bad' },
      { permissionMode: PermissionMode.YOLO }
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Semantic validation failed');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('lets tool-level checkPermissions deny before the external permission handler runs', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(async ({ value }: { value: string }): Promise<ToolResult> => ({
      success: true,
      llmContent: value,
    }));
    const permissionHandler = vi.fn(async () => ({ behavior: 'allow' as const }));

    registerTool(
      registry,
      createTool({
        name: 'GuardedTool',
        displayName: 'Guarded Tool',
        kind: ToolKind.Execute,
        description: { short: 'Guarded tool' },
        schema: z.object({
          value: z.string(),
        }),
        checkPermissions: ({ value }) =>
          value === 'blocked'
            ? {
                behavior: 'deny',
                message: 'Denied by tool checkPermissions',
              }
            : undefined,
        execute: executeSpy,
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler,
    });

    const result = await pipeline.execute(
      'GuardedTool',
      { value: 'blocked' },
      { permissionMode: PermissionMode.YOLO }
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Denied by tool checkPermissions');
    expect(permissionHandler).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('passes resolved tool metadata into permissionHandler and applies updated input', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(async ({ value }: { value: string }): Promise<ToolResult> => ({
      success: true,
      llmContent: value,
    }));
    const permissionHandler = vi.fn(async () => {
      return {
        behavior: 'allow' as const,
        updatedInput: { value: 'patched' },
      };
    });

    registerTool(
      registry,
      createTool({
        name: 'DynamicPermissionTool',
        displayName: 'Dynamic Permission Tool',
        kind: ToolKind.Execute,
        description: { short: 'Dynamic permission tool' },
        schema: z.object({
          mode: z.enum(['read', 'write']),
          value: z.string(),
        }),
        resolveBehavior: ({ mode }) => ({
          kind: mode === 'read' ? ToolKind.ReadOnly : ToolKind.Execute,
          isReadOnly: mode === 'read',
          isConcurrencySafe: mode === 'read',
          isDestructive: mode === 'write',
        }),
        execute: executeSpy,
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler,
    });

    const result = await pipeline.execute(
      'DynamicPermissionTool',
      { mode: 'write', value: 'original' },
      { permissionMode: PermissionMode.YOLO }
    );

    expect(result.success).toBe(true);
    expect(permissionHandler).toHaveBeenCalledTimes(1);
    expect(permissionHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { mode: 'write', value: 'patched' },
        toolMeta: {
          isReadOnly: false,
          isConcurrencySafe: false,
          isDestructive: true,
          signature: 'DynamicPermissionTool',
          description: 'Dynamic permission tool',
        },
      })
    );
    expect(executeSpy).toHaveBeenCalledWith(
      { mode: 'write', value: 'patched' },
      expect.anything(),
    );
  });

  it('uses preparePermissionMatcher to derive permission signatures after input updates', async () => {
    const registry = new ToolRegistry();
    const permissionHandler = vi.fn(async () => ({
      behavior: 'allow' as const,
      updatedInput: { value: 'patched' },
    }));

    registerTool(
      registry,
      createTool({
        name: 'PermissionMatcherTool',
        displayName: 'Permission Matcher Tool',
        kind: ToolKind.Execute,
        description: { short: 'Permission matcher tool' },
        schema: z.object({
          value: z.string(),
        }),
        preparePermissionMatcher: ({ value }) => ({
          signatureContent: `sig:${value}`,
          abstractRule: `rule:${value}`,
        }),
        execute: async ({ value }) => ({
          success: true,
          llmContent: value,
        }),
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler,
    });

    const result = await pipeline.execute(
      'PermissionMatcherTool',
      { value: 'original' },
      { permissionMode: PermissionMode.YOLO }
    );

    expect(result.success).toBe(true);
    expect(permissionHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { value: 'patched' },
        toolMeta: expect.objectContaining({
          signature: 'PermissionMatcherTool:sig:patched',
        }),
      }),
    );
  });

  it('persists permission update effects for subsequent matching invocations', async () => {
    const registry = new ToolRegistry();
    const permissionHandler = vi.fn(async () => ({
      behavior: 'allow' as const,
      effects: [
        {
          type: 'permissionUpdates' as const,
          updates: [
            {
              type: 'addRules' as const,
              behavior: 'allow' as const,
              rules: [{ toolName: 'PermissionEffectTool', ruleContent: 'sig:patched' }],
            },
          ],
        },
      ],
      updatedInput: { value: 'patched' },
    }));
    const firstConfirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: true,
      })),
    };
    const secondConfirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: true,
      })),
    };

    registerTool(
      registry,
      createTool({
        name: 'PermissionEffectTool',
        displayName: 'Permission Effect Tool',
        kind: ToolKind.Execute,
        description: { short: 'Permission effect tool' },
        schema: z.object({
          value: z.string(),
        }),
        preparePermissionMatcher: ({ value }) => ({
          signatureContent: `sig:${value}`,
        }),
        execute: async ({ value }) => ({
          success: true,
          llmContent: value,
        }),
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.DEFAULT,
      permissionHandler,
    });

    const firstResult = await pipeline.execute(
      'PermissionEffectTool',
      { value: 'original' },
      {
        permissionMode: PermissionMode.DEFAULT,
        confirmationHandler: firstConfirmationHandler,
      }
    );

    const secondResult = await pipeline.execute(
      'PermissionEffectTool',
      { value: 'patched' },
      {
        permissionMode: PermissionMode.DEFAULT,
        confirmationHandler: secondConfirmationHandler,
      }
    );

    expect(firstResult.success).toBe(true);
    expect(firstConfirmationHandler.requestConfirmation).not.toHaveBeenCalled();
    expect(secondResult.success).toBe(true);
    expect(secondConfirmationHandler.requestConfirmation).not.toHaveBeenCalled();
  });

  it('preserves tool-level ask requirements even when permissionHandler allows', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(async ({ value }: { value: string }): Promise<ToolResult> => ({
      success: true,
      llmContent: value,
    }));
    const confirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: false,
        reason: 'User rejected',
      })),
    };

    registerTool(
      registry,
      createTool({
        name: 'AskTool',
        displayName: 'Ask Tool',
        kind: ToolKind.Execute,
        description: { short: 'Tool-level ask tool' },
        schema: z.object({
          value: z.string(),
        }),
        checkPermissions: () => ({
          behavior: 'ask',
          message: 'Tool requires confirmation',
        }),
        execute: executeSpy,
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler: async () => ({ behavior: 'allow' }),
    });

    const result = await pipeline.execute(
      'AskTool',
      { value: 'pending' },
      {
        permissionMode: PermissionMode.YOLO,
        confirmationHandler,
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('User rejected');
    expect(confirmationHandler.requestConfirmation).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('externalizes oversized string results using tool maxResultSizeChars', async () => {
    const registry = new ToolRegistry();
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-result-store-'));

    registerTool(
      registry,
      createTool({
        name: 'LimitedOutputTool',
        displayName: 'Limited Output Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Limited output tool' },
        schema: z.object({}),
        maxResultSizeChars: 32,
        execute: async () => ({
          success: true,
          llmContent: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
        }),
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const result = await pipeline.execute(
      'LimitedOutputTool',
      {},
      {
        permissionMode: PermissionMode.YOLO,
        contextSnapshot: {
          sessionId: SessionId('session-1'),
          turnId: 'turn-1',
          cwd: workspaceRoot,
          environment: {},
          filesystemRoots: [workspaceRoot],
          context: {
            capabilities: {
              filesystem: {
                roots: [workspaceRoot],
                cwd: workspaceRoot,
              },
            },
          },
        },
      }
    );

    expect(result.success).toBe(true);
    expect(typeof result.llmContent).toBe('string');
    expect(result.llmContent).not.toBe('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(String(result.llmContent)).toContain('[externalized result');
    expect(result.metadata).toMatchObject({
      resultExternalized: true,
      resultSizeLimit: 32,
      llmContentOriginalLength: 52,
    });
    const artifactPath = String(result.metadata?.resultArtifactPath);
    expect(artifactPath).toContain('.blade-tool-results');
    const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8')) as {
      llmContent: string;
    };
    expect(artifact.llmContent).toBe('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it('normalizes legacy runtime result fields into effects before returning', async () => {
    const registry = new ToolRegistry();

    registerTool(
      registry,
      createTool({
        name: 'LegacyEffectTool',
        displayName: 'Legacy Effect Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Legacy runtime effect tool' },
        schema: z.object({}),
        execute: async () => ({
          success: true,
          llmContent: 'ok',
          runtimePatch: {
            scope: 'turn',
            source: 'tool',
            toolDiscovery: {
              discover: ['HeavyInspect'],
            },
          },
          contextPatch: {
            scope: 'turn',
            context: {
              metadata: {
                mode: 'debug',
              },
            },
          },
          newMessages: [
            {
              role: 'assistant',
              content: 'injected',
            },
          ],
        }),
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const result = await pipeline.execute(
      'LegacyEffectTool',
      {},
      { permissionMode: PermissionMode.YOLO }
    );

    expect(result.success).toBe(true);
    expect(result.effects).toEqual([
      {
        type: 'runtimePatch',
        patch: {
          scope: 'turn',
          source: 'tool',
          toolDiscovery: {
            discover: ['HeavyInspect'],
          },
        },
      },
      {
        type: 'contextPatch',
        patch: {
          scope: 'turn',
          context: {
            metadata: {
              mode: 'debug',
            },
          },
        },
      },
      {
        type: 'newMessages',
        messages: [
          {
            role: 'assistant',
            content: 'injected',
          },
        ],
      },
    ]);
  });

  it('uses dynamic invocation descriptions in confirmation titles', async () => {
    const registry = new ToolRegistry();
    const confirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: false,
        reason: 'User rejected',
      })),
    };

    registerTool(
      registry,
      createTool({
        name: 'DangerousTool',
        displayName: 'Dangerous Tool',
        kind: ToolKind.Execute,
        description: { short: 'Dangerous tool' },
        describe: (params) => ({
          short: params?.target
            ? `Delete file: ${params.target}`
            : 'Dangerous tool',
        }),
        schema: z.object({
          target: z.string(),
        }),
        checkPermissions: () => ({
          behavior: 'ask',
          message: 'Needs confirmation',
        }),
        execute: async ({ target }) => ({
          success: true,
          llmContent: target,
        }),
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler: async () => ({ behavior: 'allow' }),
    });

    const result = await pipeline.execute(
      'DangerousTool',
      { target: '/tmp/secret.txt' },
      {
        permissionMode: PermissionMode.YOLO,
        confirmationHandler,
      }
    );

    expect(result.success).toBe(false);
    expect(confirmationHandler.requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '权限确认: Delete file: /tmp/secret.txt',
      })
    );
  });

  it('denies dangerous paths before tool execution', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(async ({ file_path }: { file_path: string }): Promise<ToolResult> => ({
      success: true,
      llmContent: file_path,
    }));

    registerTool(
      registry,
      createTool({
        name: 'DangerousPathTool',
        displayName: 'Dangerous Path Tool',
        kind: ToolKind.Write,
        description: { short: 'Writes to a file' },
        schema: z.object({
          file_path: z.string(),
        }),
        execute: executeSpy,
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const result = await pipeline.execute(
      'DangerousPathTool',
      { file_path: '/etc/passwd' },
      { permissionMode: PermissionMode.YOLO }
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Access to dangerous system paths denied');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('keeps explicit sensitive-path confirmation even after downstream permission allows', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(async ({ file_path }: { file_path: string }): Promise<ToolResult> => ({
      success: true,
      llmContent: file_path,
    }));
    const confirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: false,
        reason: 'User rejected sensitive file access',
      })),
    };

    registerTool(
      registry,
      createTool({
        name: 'SensitiveReadTool',
        displayName: 'Sensitive Read Tool',
        kind: ToolKind.ReadOnly,
        preparePermissionMatcher: ({ file_path }) => ({
          signatureContent: file_path,
        }),
        description: { short: 'Reads a sensitive file' },
        schema: z.object({
          file_path: z.string(),
        }),
        execute: executeSpy,
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionConfig: {
        allow: ['SensitiveReadTool:/tmp/id_rsa'],
      },
      permissionHandler: async () => ({ behavior: 'allow' }),
    });

    const result = await pipeline.execute(
      'SensitiveReadTool',
      { file_path: '/tmp/id_rsa' },
      {
        permissionMode: PermissionMode.YOLO,
        confirmationHandler,
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('User rejected sensitive file access');
    expect(confirmationHandler.requestConfirmation).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
