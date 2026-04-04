import { describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../types/common.js';
import { ToolRegistry } from '../ToolRegistry.js';

function createTool(name: string, options: { isReadOnly?: boolean; tags?: string[] } = {}) {
  return {
    name,
    displayName: name,
    description: name,
    kind: options.isReadOnly ? 'readonly' : 'execute',
    isReadOnly: options.isReadOnly ?? false,
    tags: options.tags ?? [],
    getFunctionDeclaration: () => ({
      name,
      description: `${name} description`,
      parameters: {},
    }),
  };
}

describe('ToolRegistry ordering', () => {
  it('stably sorts builtin tools before MCP tools by name', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('Write') as never);
    registry.register(createTool('Read', { isReadOnly: true }) as never);
    registry.registerMcpTool(createTool('z-search', { tags: ['mcp'] }) as never);
    registry.registerMcpTool(createTool('a-browser', { tags: ['mcp'] }) as never);

    expect(registry.getFunctionDeclarationsByMode()).toEqual([
      expect.objectContaining({ name: 'Read' }),
      expect.objectContaining({ name: 'Write' }),
      expect.objectContaining({ name: 'a-browser' }),
      expect.objectContaining({ name: 'z-search' }),
    ]);
  });

  it('keeps the same stable ordering in plan mode after readonly filtering', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('Write') as never);
    registry.register(createTool('Glob', { isReadOnly: true }) as never);
    registry.registerMcpTool(createTool('z-docs', { isReadOnly: true, tags: ['mcp'] }) as never);
    registry.registerMcpTool(createTool('a-api', { isReadOnly: true, tags: ['mcp'] }) as never);

    expect(registry.getFunctionDeclarationsByMode(PermissionMode.PLAN)).toEqual([
      expect.objectContaining({ name: 'Glob' }),
      expect.objectContaining({ name: 'a-api' }),
      expect.objectContaining({ name: 'z-docs' }),
    ]);
  });

  it('caches sorted tool lists until registry contents change', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('Write') as never);
    registry.register(createTool('Read', { isReadOnly: true }) as never);
    registry.registerMcpTool(createTool('z-search', { tags: ['mcp'] }) as never);

    const sortSpy = vi.spyOn(
      registry as unknown as { getSortedTools: (tools: unknown[]) => unknown[] },
      'getSortedTools',
    );

    registry.getAll();
    registry.getAll();
    registry.getBuiltinTools();
    registry.getBuiltinTools();
    registry.getMcpTools();
    registry.getMcpTools();

    expect(sortSpy).toHaveBeenCalledTimes(3);

    registry.registerMcpTool(createTool('a-browser', { tags: ['mcp'] }) as never);
    registry.getAll();
    registry.getBuiltinTools();
    registry.getMcpTools();

    expect(sortSpy).toHaveBeenCalledTimes(6);
  });
});
