import { describe, expect, it, beforeEach } from 'bun:test';
import { ToolRegistry } from '../ToolRegistry.js';
import type { Tool, FunctionDeclaration } from '../../types/index.js';
import { PermissionMode } from '../../../types/common.js';

// ===== Mock Tool Factory =====

function createMockTool(overrides: Partial<Tool> = {}): Tool {
  const name = overrides.name || 'TestTool';
  return {
    name,
    displayName: overrides.displayName || name,
    kind: overrides.kind || 'readonly',
    isReadOnly: overrides.isReadOnly ?? true,
    isConcurrencySafe: overrides.isConcurrencySafe ?? true,
    strict: overrides.strict ?? false,
    description: overrides.description || { short: `${name} description`, long: `${name} long description` },
    version: overrides.version || '1.0.0',
    category: overrides.category,
    tags: overrides.tags || [],
    getFunctionDeclaration: () => ({
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {} },
    }),
    getMetadata: () => ({
      name,
      displayName: name,
      kind: 'readonly',
      description: { short: `${name} desc` },
      version: '1.0.0',
      tags: [],
    }),
    validate: async () => ({ valid: true }),
    execute: async () => ({
      success: true,
      llmContent: 'ok',
      displayContent: 'ok',
    }),
    ...overrides,
  } as Tool;
}

// ===== Tests =====

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register', () => {
    it('should register a tool', () => {
      const tool = createMockTool({ name: 'ReadFile' });
      registry.register(tool);

      expect(registry.get('ReadFile')).toBeDefined();
      expect(registry.get('ReadFile')?.name).toBe('ReadFile');
    });

    it('should throw on duplicate registration', () => {
      const tool = createMockTool({ name: 'ReadFile' });
      registry.register(tool);

      expect(() => registry.register(tool)).toThrow('已注册');
    });

    it('should emit toolRegistered event', () => {
      let emitted = false;
      registry.on('toolRegistered', () => { emitted = true; });

      registry.register(createMockTool({ name: 'ReadFile' }));
      expect(emitted).toBe(true);
    });
  });

  describe('registerAll', () => {
    it('should register multiple tools', () => {
      const tools = [
        createMockTool({ name: 'ReadFile' }),
        createMockTool({ name: 'WriteFile' }),
        createMockTool({ name: 'Grep' }),
      ];
      registry.registerAll(tools);

      expect(registry.get('ReadFile')).toBeDefined();
      expect(registry.get('WriteFile')).toBeDefined();
      expect(registry.get('Grep')).toBeDefined();
    });

    it('should throw on partial failure', () => {
      const tool = createMockTool({ name: 'ReadFile' });
      registry.register(tool);

      expect(() =>
        registry.registerAll([
          createMockTool({ name: 'ReadFile' }), // duplicate
          createMockTool({ name: 'WriteFile' }),
        ])
      ).toThrow('批量注册失败');
    });
  });

  describe('unregister', () => {
    it('should unregister an existing tool', () => {
      registry.register(createMockTool({ name: 'ReadFile' }));
      expect(registry.unregister('ReadFile')).toBe(true);
      expect(registry.get('ReadFile')).toBeUndefined();
    });

    it('should return false for non-existent tool', () => {
      expect(registry.unregister('NonExistent')).toBe(false);
    });

    it('should emit toolUnregistered event', () => {
      let emitted = false;
      registry.on('toolUnregistered', () => { emitted = true; });

      registry.register(createMockTool({ name: 'ReadFile' }));
      registry.unregister('ReadFile');
      expect(emitted).toBe(true);
    });
  });

  describe('get', () => {
    it('should return tool by name', () => {
      registry.register(createMockTool({ name: 'ReadFile' }));
      expect(registry.get('ReadFile')?.name).toBe('ReadFile');
    });

    it('should return undefined for unknown tool', () => {
      expect(registry.get('Unknown')).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('should return all registered tools', () => {
      registry.register(createMockTool({ name: 'ReadFile' }));
      registry.register(createMockTool({ name: 'WriteFile' }));

      const all = registry.getAll();
      expect(all.length).toBe(2);
    });

    it('should return empty array when no tools', () => {
      expect(registry.getAll().length).toBe(0);
    });
  });

  describe('getReadOnlyTools', () => {
    it('should return only readonly tools', () => {
      registry.register(createMockTool({ name: 'ReadFile', isReadOnly: true }));
      registry.register(createMockTool({ name: 'WriteFile', isReadOnly: false }));

      const readOnly = registry.getReadOnlyTools();
      expect(readOnly.length).toBe(1);
      expect(readOnly[0].name).toBe('ReadFile');
    });
  });

  describe('getFunctionDeclarationsByMode', () => {
    it('should return all tools for undefined mode', () => {
      registry.register(createMockTool({ name: 'ReadFile', isReadOnly: true }));
      registry.register(createMockTool({ name: 'WriteFile', isReadOnly: false }));

      const decls = registry.getFunctionDeclarationsByMode(undefined);
      expect(decls.length).toBe(2);
    });

    it('should return only readonly tools for PLAN mode', () => {
      registry.register(createMockTool({ name: 'ReadFile', isReadOnly: true }));
      registry.register(createMockTool({ name: 'WriteFile', isReadOnly: false }));

      const decls = registry.getFunctionDeclarationsByMode(PermissionMode.PLAN);
      expect(decls.length).toBe(1);
      expect(decls[0].name).toBe('ReadFile');
    });
  });

  describe('MCP tools', () => {
    it('should register and retrieve MCP tools', () => {
      const mcpTool = createMockTool({ name: 'mcp__server__tool' });
      registry.registerMcpTool(mcpTool);

      expect(registry.get('mcp__server__tool')).toBeDefined();
    });

    it('should unregister MCP tools by server prefix', () => {
      registry.registerMcpTool(createMockTool({ name: 'mcp__myserver__tool1' }));
      registry.registerMcpTool(createMockTool({ name: 'mcp__myserver__tool2' }));
      registry.registerMcpTool(createMockTool({ name: 'mcp__other__tool3' }));

      registry.removeMcpTools('myserver');

      expect(registry.get('mcp__myserver__tool1')).toBeUndefined();
      expect(registry.get('mcp__myserver__tool2')).toBeUndefined();
      expect(registry.get('mcp__other__tool3')).toBeDefined();
    });
  });

  describe('category and tag indexing', () => {
    it('should index tools by category', () => {
      registry.register(createMockTool({ name: 'ReadFile', category: 'file' }));
      registry.register(createMockTool({ name: 'WriteFile', category: 'file' }));
      registry.register(createMockTool({ name: 'Grep', category: 'search' }));

      const fileTools = registry.getByCategory('file');
      expect(fileTools.length).toBe(2);
    });

    it('should index tools by tag', () => {
      registry.register(createMockTool({ name: 'ReadFile', tags: ['io', 'safe'] }));
      registry.register(createMockTool({ name: 'WriteFile', tags: ['io', 'dangerous'] }));

      const ioTools = registry.getByTag('io');
      expect(ioTools.length).toBe(2);

      const safeTools = registry.getByTag('safe');
      expect(safeTools.length).toBe(1);
    });
  });
});
