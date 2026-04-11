import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createTool, toolFromDefinition } from '../core/createTool.js';
import type { ReadMetadata, ToolResult } from '../types/ToolTypes.js';
import { ToolKind } from '../types/ToolTypes.js';
import { lazySchema } from '../validation/lazySchema.js';

describe('createTool', () => {
  it('exposes ToolResult as a success-discriminated generic union', () => {
    type EchoResult = ToolResult<{ echoed: string }, ReadMetadata>;

    expectTypeOf<EchoResult>().toMatchTypeOf<
      | {
          success: true;
          data?: { echoed: string };
          metadata?: ReadMetadata;
        }
      | {
          success: false;
          error: {
            message: string;
          };
        }
    >();
  });

  const testSchema = z.object({
    message: z.string().describe('The message to echo'),
    count: z.number().optional().describe('Number of times to repeat'),
  });

  const echoTool = createTool({
    name: 'Echo',
    displayName: 'Echo Tool',
    kind: ToolKind.ReadOnly,
    description: {
      short: 'Echoes a message',
      long: 'A simple tool that echoes back the provided message',
      usageNotes: ['Use for testing', 'Supports repetition'],
      important: ['Do not use in production'],
    },
    schema: testSchema,
    execute: async (params) => {
      const count = params.count || 1;
      const result = Array(count).fill(params.message).join(' ');
      return { success: true, llmContent: result };
    },
  });

  describe('tool properties', () => {
    it('should have correct name', () => {
      expect(echoTool.name).toBe('Echo');
    });

    it('should have correct displayName', () => {
      expect(echoTool.displayName).toBe('Echo Tool');
    });

    it('should have correct kind', () => {
      expect(echoTool.kind).toBe(ToolKind.ReadOnly);
    });

    it('should be readonly for readonly kind', () => {
      expect(echoTool.isReadOnly).toBe(true);
    });

    it('should be concurrency safe by default', () => {
      expect(echoTool.isConcurrencySafe).toBe(true);
    });

    it('should not be strict by default', () => {
      expect(echoTool.strict).toBe(false);
    });

    it('should default maxResultSizeChars to infinity', () => {
      expect(echoTool.maxResultSizeChars).toBe(Number.POSITIVE_INFINITY);
    });

    it('should default interruptBehavior to cancel', () => {
      expect(echoTool.interruptBehavior).toBe('cancel');
    });

    it('should resolve default behavior from static config', () => {
      expect(echoTool.resolveBehavior!({ message: 'Hello' })).toEqual({
        kind: ToolKind.ReadOnly,
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
        interruptBehavior: 'cancel',
      });
    });
  });

  describe('getFunctionDeclaration', () => {
    it('should return function declaration with name', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.name).toBe('Echo');
    });

    it('should include short description', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.description).toContain('Echoes a message');
    });

    it('should include long description', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.description).toContain('echoes back the provided message');
    });

    it('should include usage notes', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.description).toContain('Usage Notes:');
      expect(declaration.description).toContain('Use for testing');
    });

    it('should include important notes', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.description).toContain('Important:');
      expect(declaration.description).toContain('Do not use in production');
    });

    it('should have parameters schema', () => {
      const declaration = echoTool.getFunctionDeclaration();
      expect(declaration.parameters).toBeDefined();
      expect(declaration.parameters.type).toBe('object');
    });

    it('should support lazy schemas without rebuilding them on repeated access', () => {
      let schemaInitCount = 0;
      const lazyTool = createTool({
        name: 'LazyTool',
        displayName: 'Lazy Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Lazy tool' },
        schema: lazySchema(() => {
          schemaInitCount += 1;
          return z.object({
            value: z.string(),
          });
        }),
        execute: async ({ value }) => ({
          success: true,
          llmContent: value,
        }),
      });

      expect(schemaInitCount).toBe(0);

      lazyTool.getFunctionDeclaration();
      lazyTool.getMetadata();
      lazyTool.build({ value: 'hello' });

      expect(schemaInitCount).toBe(1);
    });

    it('should use dynamic descriptions for concrete invocations while preserving static declarations', () => {
      const describedTool = createTool({
        name: 'DescribeTool',
        displayName: 'Describe Tool',
        kind: ToolKind.Execute,
        description: { short: 'General tool description' },
        describe: (params) => ({
          short: params?.target
            ? `Inspect target: ${params.target}`
            : 'General tool description',
        }),
        schema: z.object({
          target: z.string(),
        }),
        execute: async ({ target }) => ({
          success: true,
          llmContent: target,
        }),
      });

      expect(describedTool.getFunctionDeclaration().description).toContain(
        'General tool description'
      );
      expect(describedTool.describe({ target: '/tmp/demo.txt' }).short).toBe(
        'Inspect target: /tmp/demo.txt'
      );
      expect(describedTool.build({ target: '/tmp/demo.txt' }).getDescription()).toBe(
        'Inspect target: /tmp/demo.txt'
      );
    });
  });

  describe('getMetadata', () => {
    it('should return complete metadata', () => {
      const metadata = echoTool.getMetadata();
      expect(metadata.name).toBe('Echo');
      expect(metadata.displayName).toBe('Echo Tool');
      expect(metadata.kind).toBe(ToolKind.ReadOnly);
      expect(metadata.version).toBe('1.0.0');
    });

    it('should include schema', () => {
      const metadata = echoTool.getMetadata();
      expect(metadata.schema).toBeDefined();
    });
  });

  describe('build', () => {
    it('should create tool invocation with valid params', () => {
      const invocation = echoTool.build({ message: 'Hello' });
      expect(invocation).toBeDefined();
    });

    it('infers affected file paths from common path-shaped params', () => {
      const pathTool = createTool({
        name: 'PathTool',
        displayName: 'Path Tool',
        kind: ToolKind.Write,
        description: { short: 'Path-aware tool' },
        schema: z.object({
          file_path: z.string(),
          backupPath: z.string().optional(),
          files: z.array(z.string()).optional(),
        }),
        execute: async ({ file_path }) => ({
          success: true,
          llmContent: file_path,
        }),
      });

      const invocation = pathTool.build({
        file_path: '/tmp/example.txt',
        backupPath: '/tmp/example.bak',
        files: ['/tmp/one.txt', '/tmp/two.txt'],
      });

      expect(invocation.getAffectedPaths()).toEqual([
        '/tmp/example.txt',
        '/tmp/example.bak',
        '/tmp/one.txt',
        '/tmp/two.txt',
      ]);
    });

    it('should throw on invalid params', () => {
      expect(() => {
        echoTool.build({ message: 123 } as unknown as z.infer<typeof testSchema>);
      }).toThrow();
    });
  });

  describe('execute', () => {
    it('should execute with valid params', async () => {
      const result = await echoTool.execute({ message: 'Hello' });
      expect(result.success).toBe(true);
      expect(result.llmContent).toBe('Hello');
    });

    it('should handle count parameter', async () => {
      const result = await echoTool.execute({ message: 'Hi', count: 3 });
      expect(result.success).toBe(true);
      expect(result.llmContent).toBe('Hi Hi Hi');
    });

    it('should run semantic validateInput before execution', async () => {
      const guardedTool = createTool({
        name: 'GuardedTool',
        displayName: 'Guarded Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Tool with semantic validation' },
        schema: z.object({
          value: z.string(),
        }),
        validateInput: ({ value }) =>
          value === 'blocked'
            ? {
                message: 'Blocked by semantic validation',
              }
            : undefined,
        execute: async ({ value }) => ({
          success: true,
          llmContent: value,
        }),
      });

      const blocked = await guardedTool.execute({ value: 'blocked' });
      const allowed = await guardedTool.execute({ value: 'allowed' });

      expect(blocked.success).toBe(false);
      expect(blocked.error?.message).toBe('Blocked by semantic validation');
      expect(allowed.success).toBe(true);
      expect(allowed.llmContent).toBe('allowed');
    });

    it('should expose tool-level checkPermissions when configured', async () => {
      const guardedTool = createTool({
        name: 'PermissionedTool',
        displayName: 'Permissioned Tool',
        kind: ToolKind.Execute,
        description: { short: 'Tool with permission check' },
        schema: z.object({
          value: z.string(),
        }),
        checkPermissions: ({ value }) =>
          value === 'blocked'
            ? {
                behavior: 'deny',
                message: 'Blocked by tool permission',
              }
            : undefined,
        execute: async ({ value }) => ({
          success: true,
          llmContent: value,
        }),
      });

      const blocked = await guardedTool.checkPermissions?.(
        { value: 'blocked' },
        {} as never,
      );
      const allowed = await guardedTool.checkPermissions?.(
        { value: 'allowed' },
        {} as never,
      );

      expect(blocked).toEqual({
        behavior: 'deny',
        message: 'Blocked by tool permission',
      });
      expect(allowed).toBeUndefined();
    });
  });

  describe('tool kind inference', () => {
    it('should infer isReadOnly from kind', () => {
      const readonlyTool = createTool({
        name: 'ReadTool',
        displayName: 'Read Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Read only tool' },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '' }),
      });
      expect(readonlyTool.isReadOnly).toBe(true);

      const writeTool = createTool({
        name: 'WriteTool',
        displayName: 'Write Tool',
        kind: ToolKind.Write,
        description: { short: 'Write tool' },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '' }),
      });
      expect(writeTool.isReadOnly).toBe(false);
    });

    it('should allow explicit isReadOnly override', () => {
      const tool = createTool({
        name: 'CustomTool',
        displayName: 'Custom Tool',
        kind: ToolKind.ReadOnly,
        isReadOnly: false,
        description: { short: 'Custom tool' },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '' }),
      });
      expect(tool.isReadOnly).toBe(false);
    });

    it('should resolve dynamic behavior from validated params', () => {
      const tool = createTool({
        name: 'DynamicTool',
        displayName: 'Dynamic Tool',
        kind: ToolKind.Execute,
        description: { short: 'Dynamic behavior tool' },
        schema: z.object({
          mode: z.enum(['read', 'write']).default('read'),
        }),
        resolveBehavior: (params) => ({
          kind: params.mode === 'read' ? ToolKind.ReadOnly : ToolKind.Write,
          isReadOnly: params.mode === 'read',
          isConcurrencySafe: params.mode === 'read',
          isDestructive: params.mode !== 'read',
        }),
        execute: async () => ({ success: true, llmContent: '' }),
      });

      expect(tool.resolveBehavior!({} as unknown as { mode: 'read' | 'write' })).toEqual({
        kind: ToolKind.ReadOnly,
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
        interruptBehavior: 'cancel',
      });
      expect(tool.resolveBehavior!({ mode: 'write' })).toEqual({
        kind: ToolKind.Write,
        isReadOnly: false,
        isConcurrencySafe: false,
        isDestructive: true,
        interruptBehavior: 'cancel',
      });
    });

    it('should preserve explicit maxResultSizeChars overrides', () => {
      const tool = createTool({
        name: 'LimitedTool',
        displayName: 'Limited Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Limited tool' },
        schema: z.object({}),
        maxResultSizeChars: 128,
        execute: async () => ({ success: true, llmContent: '' }),
      });

      expect(tool.maxResultSizeChars).toBe(128);
    });

    it('should preserve explicit interruptBehavior overrides', () => {
      const tool = createTool({
        name: 'BlockingTool',
        displayName: 'Blocking Tool',
        kind: ToolKind.Execute,
        description: { short: 'Blocking tool' },
        schema: z.object({}),
        interruptBehavior: 'block',
        execute: async () => ({ success: true, llmContent: '' }),
      });

      expect(tool.interruptBehavior).toBe('block');
      expect(tool.resolveBehavior!({})).toMatchObject({
        interruptBehavior: 'block',
      });
    });
  });

  describe('permission matcher preparation', () => {
    it('should support preparePermissionMatcher', () => {
      const toolWithSignature = createTool({
        name: 'SignatureTool',
        displayName: 'Signature Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Tool with signature' },
        schema: z.object({ path: z.string() }),
        execute: async () => ({ success: true, llmContent: '' }),
        preparePermissionMatcher: (params) => ({
          signatureContent: params.path,
          abstractRule: `read:${params.path}`,
        }),
      });

      expect(toolWithSignature.preparePermissionMatcher).toBeDefined();
      expect(
        toolWithSignature.preparePermissionMatcher!({ path: '/test/file.ts' })
      ).toEqual({
        signatureContent: '/test/file.ts',
        abstractRule: 'read:/test/file.ts',
      });
    });
  });

  describe('toolFromDefinition', () => {
    it('preserves category, tags, and exposure metadata for simplified tool definitions', () => {
      const tool = toolFromDefinition({
        name: 'IndexedTool',
        description: 'Indexed tool',
        parameters: { type: 'object', properties: {} },
        category: 'analysis',
        tags: ['search', 'catalog'],
        exposure: {
          mode: 'deferred',
          discoveryHint: 'Use when searching the tool catalog.',
        },
        async execute() {
          return {
            success: true,
            llmContent: 'ok',
          };
        },
      });

      expect(tool.category).toBe('analysis');
      expect(tool.tags).toEqual(['search', 'catalog']);
      expect(tool.exposure).toMatchObject({
        mode: 'deferred',
        discoveryHint: 'Use when searching the tool catalog.',
      });
      expect(tool.getMetadata()).toMatchObject({
        category: 'analysis',
        tags: ['search', 'catalog'],
      });
    });
  });
});
