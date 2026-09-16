import Type from 'typebox';
import { describe, expect, it } from 'vitest';
import { createTool, defineTool } from '../../core/createTool.js';
import { completeToolExecution } from '../../types/result.js';
import { ToolRegistry, type ToolSourceInfo } from '../ToolRegistry.js';

const BUILTIN_SOURCE = {
  kind: 'builtin',
  trustLevel: 'trusted',
  sourceId: 'builtin',
} as const;

const CUSTOM_SOURCE = {
  kind: 'custom',
  trustLevel: 'workspace',
  sourceId: 'test',
} as const;

function mcpSource(serverName: string): ToolSourceInfo & { kind: 'mcp' } {
  return {
    kind: 'mcp',
    trustLevel: 'remote',
    sourceId: serverName,
    serverName,
  };
}

function createRuntimeTool(
  name: string,
  options: {
    readonly aliases?: string[];
    readonly isReadOnly?: boolean;
  } = {},
) {
  return createTool({
    name,
    aliases: options.aliases,
    displayName: name,
    kind: options.isReadOnly ? 'readonly' : 'execute',
    sideEffect: options.isReadOnly ? 'pure' : 'non_idempotent',
    description: { short: name },
    schema: Type.Object({}),
    execute: () => completeToolExecution({ status: 'success', model: 'ok' }),
  });
}

describe('ToolRegistry', () => {
  it('owns tool source metadata in the registry entry', () => {
    const registry = new ToolRegistry();
    const tool = createRuntimeTool('Read', { isReadOnly: true });

    registry.register(tool, BUILTIN_SOURCE);

    expect(registry.entries()).toEqual([
      {
        tool,
        source: BUILTIN_SOURCE,
      },
    ]);
  });

  it('skips definitions when a declared service is unavailable', () => {
    const registry = new ToolRegistry();
    const definition = defineTool({
      name: 'MemoryBackedTool',
      description: 'Requires memory services',
      parameters: Type.Object({}),
      services: ['memoryManager'] as const,
      async execute() {
        return {};
      },
    });

    expect(registry.registerDefinition(definition, CUSTOM_SOURCE)).toBeUndefined();
    expect(registry.has('MemoryBackedTool')).toBe(false);
  });

  it('rejects tools without a valid side-effect contract', () => {
    const registry = new ToolRegistry();
    const invalidTool = {
      ...createRuntimeTool('MissingContract'),
      staticBehavior: undefined,
    };

    expect(() => registry.register(invalidTool as never, CUSTOM_SOURCE)).toThrow(
      /must declare sideEffect/,
    );
  });

  it('sorts non-MCP entries before MCP entries by name', () => {
    const registry = new ToolRegistry();
    registry.register(createRuntimeTool('Write'), BUILTIN_SOURCE);
    registry.register(createRuntimeTool('Read', { isReadOnly: true }), BUILTIN_SOURCE);
    registry.registerMcpTool(createRuntimeTool('mcp__z__search'), mcpSource('z'));
    registry.registerMcpTool(createRuntimeTool('mcp__a__browser'), mcpSource('a'));

    expect(registry.getAll().map((tool) => tool.name)).toEqual([
      'Read',
      'Write',
      'mcp__a__browser',
      'mcp__z__search',
    ]);
  });

  it('resolves aliases and removes them with the canonical entry', () => {
    const registry = new ToolRegistry();
    registry.register(
      createRuntimeTool('Read', { aliases: ['FileRead', 'OpenFile'] }),
      BUILTIN_SOURCE,
    );

    expect(registry.get('FileRead')?.name).toBe('Read');
    expect(registry.unregister('OpenFile')).toBe(true);
    expect(registry.has('Read')).toBe(false);
    expect(registry.has('FileRead')).toBe(false);
  });

  it('rejects alias collisions', () => {
    const registry = new ToolRegistry();
    registry.register(createRuntimeTool('Read', { aliases: ['FileRead'] }), BUILTIN_SOURCE);

    expect(() =>
      registry.register(createRuntimeTool('OtherTool', { aliases: ['Read'] }), CUSTOM_SOURCE),
    ).toThrow(/别名|冲突/);
    expect(() =>
      registry.register(createRuntimeTool('ThirdTool', { aliases: ['FileRead'] }), CUSTOM_SOURCE),
    ).toThrow(/别名|冲突/);
  });

  it('enforces the MCP namespace from structured source metadata', () => {
    const registry = new ToolRegistry();

    expect(() => registry.register(createRuntimeTool('mcp__remote__Read'), CUSTOM_SOURCE)).toThrow(
      /保留的 MCP 命名空间/,
    );
    expect(() => registry.registerMcpTool(createRuntimeTool('Read'), mcpSource('remote'))).toThrow(
      /必须使用保留命名空间/,
    );
  });

  it('replaces MCP entries during server refresh', () => {
    const registry = new ToolRegistry();
    const original = createRuntimeTool('mcp__docs__Search');
    const replacement = createRuntimeTool('mcp__docs__Search', {
      aliases: ['DocsSearch'],
    });

    registry.registerMcpTool(original, mcpSource('docs'));
    registry.registerMcpTool(replacement, mcpSource('docs'));

    expect(registry.get('mcp__docs__Search')).toBe(replacement);
    expect(registry.get('DocsSearch')).toBe(replacement);
  });

  it('removes MCP tools by structured server ownership', () => {
    const registry = new ToolRegistry();
    const tool = createRuntimeTool('mcp__docs_api__Search');
    registry.registerMcpTool(tool, mcpSource('docs api'));

    expect(registry.removeMcpTools('docs api')).toBe(1);
    expect(registry.has(tool.name)).toBe(false);
  });

  it('does not expose search, stats, or declaration filtering APIs', () => {
    const registry = new ToolRegistry();

    expect('search' in registry).toBe(false);
    expect('getStats' in registry).toBe(false);
    expect('getByCategory' in registry).toBe(false);
    expect('getByTag' in registry).toBe(false);
    expect('getFunctionDeclarationsByMode' in registry).toBe(false);
  });
});
