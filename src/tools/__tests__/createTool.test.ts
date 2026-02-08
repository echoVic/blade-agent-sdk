import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createTool } from '../core/createTool.js';
import { ToolKind } from '../types/ToolTypes.js';

describe('createTool', () => {
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
      return { success: true, llmContent: result, displayContent: result };
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

    it('should throw on invalid params', () => {
      expect(() => {
        echoTool.build({ message: 123 } as any);
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
  });

  describe('tool kind inference', () => {
    it('should infer isReadOnly from kind', () => {
      const readonlyTool = createTool({
        name: 'ReadTool',
        displayName: 'Read Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Read only tool' },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
      });
      expect(readonlyTool.isReadOnly).toBe(true);

      const writeTool = createTool({
        name: 'WriteTool',
        displayName: 'Write Tool',
        kind: ToolKind.Write,
        description: { short: 'Write tool' },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
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
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
      });
      expect(tool.isReadOnly).toBe(false);
    });
  });

  describe('signature extraction', () => {
    it('should support extractSignatureContent', () => {
      const toolWithSignature = createTool({
        name: 'SignatureTool',
        displayName: 'Signature Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Tool with signature' },
        schema: z.object({ path: z.string() }),
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
        extractSignatureContent: (params) => params.path,
      });

      expect(toolWithSignature.extractSignatureContent).toBeDefined();
      expect(toolWithSignature.extractSignatureContent!({ path: '/test/file.ts' })).toBe(
        '/test/file.ts'
      );
    });
  });

  describe('permission rule abstraction', () => {
    it('should support abstractPermissionRule', () => {
      const toolWithPermission = createTool({
        name: 'PermissionTool',
        displayName: 'Permission Tool',
        kind: ToolKind.Write,
        description: { short: 'Tool with permission' },
        schema: z.object({ path: z.string() }),
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
        abstractPermissionRule: (params) => `write:${params.path}`,
      });

      expect(toolWithPermission.abstractPermissionRule).toBeDefined();
      expect(
        toolWithPermission.abstractPermissionRule!({ path: '/test/file.ts' })
      ).toBe('write:/test/file.ts');
    });
  });
});
