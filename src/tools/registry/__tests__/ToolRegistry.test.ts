import { describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../types/constants.js';
import { ToolRegistry } from '../ToolRegistry.js';

function createTool(
  name: string,
  options: {
    isReadOnly?: boolean;
    tags?: string[];
    aliases?: string[];
    sideEffect?: 'pure' | 'idempotent' | 'non_idempotent';
    displayName?: string;
    description?: string | { short: string; long?: string };
    category?: string;
    exposure?: { mode?: 'eager' | 'deferred' | 'discoverable-only'; discoveryHint?: string };
  } = {},
) {
  const description = options.description ?? name;
  return {
    name,
    aliases: options.aliases ?? [],
    displayName: options.displayName ?? name,
    description,
    kind: options.isReadOnly ? 'readonly' : 'execute',
    sideEffect: options.sideEffect ?? (options.isReadOnly ? 'pure' : 'non_idempotent'),
    isReadOnly: options.isReadOnly ?? false,
    tags: options.tags ?? [],
    category: options.category,
    exposure: {
      mode: options.exposure?.mode ?? 'eager',
      alwaysLoad: false,
      discoveryHint: options.exposure?.discoveryHint ?? '',
    },
    getFunctionDeclaration: () => ({
      name,
      description: `${name} description`,
      parameters: {},
    }),
  };
}

describe('ToolRegistry ordering', () => {
  it('rejects tools without a valid side-effect contract', () => {
    const registry = new ToolRegistry();

    expect(() =>
      registry.register({
        ...createTool('MissingContract'),
        sideEffect: undefined,
      } as never),
    ).toThrow(/must declare sideEffect/);
    expect(() =>
      registry.registerMcpTool({
        ...createTool('InvalidContract'),
        sideEffect: 'unknown',
      } as never),
    ).toThrow(/must declare sideEffect/);
  });

  it('is a plain registry instead of exposing EventEmitter APIs', () => {
    const registry = new ToolRegistry();

    expect('on' in (registry as unknown as Record<string, unknown>)).toBe(false);
    expect('emit' in (registry as unknown as Record<string, unknown>)).toBe(false);
  });

  it('stably sorts builtin tools before MCP tools by name', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('Write') as never);
    registry.register(createTool('Read', { isReadOnly: true }) as never);
    registry.registerMcpTool(createTool('mcp__z__search', { tags: ['mcp'] }) as never);
    registry.registerMcpTool(createTool('mcp__a__browser', { tags: ['mcp'] }) as never);

    expect(registry.getFunctionDeclarationsByMode()).toEqual([
      expect.objectContaining({ name: 'Read' }),
      expect.objectContaining({ name: 'Write' }),
      expect.objectContaining({ name: 'mcp__a__browser' }),
      expect.objectContaining({ name: 'mcp__z__search' }),
    ]);
  });

  it('keeps the same stable ordering in plan mode after readonly filtering', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('Write') as never);
    registry.register(createTool('Glob', { isReadOnly: true }) as never);
    registry.registerMcpTool(
      createTool('mcp__z__docs', { isReadOnly: true, tags: ['mcp'] }) as never,
    );
    registry.registerMcpTool(
      createTool('mcp__a__api', { isReadOnly: true, tags: ['mcp'] }) as never,
    );

    expect(registry.getFunctionDeclarationsByMode(PermissionMode.PLAN)).toEqual([
      expect.objectContaining({ name: 'Glob' }),
      expect.objectContaining({ name: 'mcp__a__api' }),
      expect.objectContaining({ name: 'mcp__z__docs' }),
    ]);
  });

  it('uses behavior hints when filtering readonly declarations for plan mode', () => {
    const registry = new ToolRegistry();
    registry.register({
      ...createTool('HintRead'),
      kind: 'execute',
      isReadOnly: false,
      getBehaviorHint: () => ({
        kind: 'readonly',
        sideEffect: 'pure',
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
        interruptBehavior: 'cancel',
      }),
    } as never);
    registry.register({
      ...createTool('HintWrite', { isReadOnly: true }),
      getBehaviorHint: () => ({
        kind: 'execute',
        sideEffect: 'non_idempotent',
        isReadOnly: false,
        isConcurrencySafe: true,
        isDestructive: false,
        interruptBehavior: 'cancel',
      }),
    } as never);

    expect(registry.getFunctionDeclarationsByMode(PermissionMode.PLAN)).toEqual([
      expect.objectContaining({ name: 'HintRead' }),
    ]);
  });

  it('caches sorted tool lists until registry contents change', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('Write') as never);
    registry.register(createTool('Read', { isReadOnly: true }) as never);
    registry.registerMcpTool(createTool('mcp__z__search', { tags: ['mcp'] }) as never);

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

    registry.registerMcpTool(createTool('mcp__a__browser', { tags: ['mcp'] }) as never);
    registry.getAll();
    registry.getBuiltinTools();
    registry.getMcpTools();

    expect(sortSpy).toHaveBeenCalledTimes(6);
  });

  it('resolves tools by alias and removes alias mappings on unregister', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('Read', { aliases: ['FileRead', 'OpenFile'] }) as never);

    expect(registry.get('Read')?.name).toBe('Read');
    expect(registry.get('FileRead')?.name).toBe('Read');
    expect(registry.has('OpenFile')).toBe(true);

    registry.unregister('Read');

    expect(registry.get('FileRead')).toBeUndefined();
    expect(registry.has('OpenFile')).toBe(false);
  });

  it('rejects alias collisions with existing tool names or aliases', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('Read', { aliases: ['FileRead'] }) as never);

    expect(() =>
      registry.register(createTool('OtherTool', { aliases: ['Read'] }) as never),
    ).toThrow(/别名|冲突/);

    expect(() =>
      registry.register(createTool('ThirdTool', { aliases: ['FileRead'] }) as never),
    ).toThrow(/别名|冲突/);
  });

  it('enforces the MCP namespace in both registration directions', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('Read') as never);

    expect(() => registry.register(createTool('mcp__remote__Read') as never)).toThrow(
      /保留的 MCP 命名空间/,
    );
    expect(() =>
      registry.registerMcpTool(createTool('Read', { tags: ['mcp'] }) as never),
    ).toThrow(/必须使用保留命名空间/);
  });

  it('searches alias names alongside canonical tool metadata', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('Read', { aliases: ['FileRead'] }) as never);

    expect(registry.search('fileread').map((tool) => tool.name)).toEqual(['Read']);
  });

  it('prioritizes exact name and alias matches ahead of looser description hits', () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool('Inspect', {
        aliases: ['Scan'],
        description: { short: 'Inspect project files' },
      }) as never,
    );
    registry.register(
      createTool('ProjectAnalyzer', {
        description: { short: 'Runs a scan over the project' },
      }) as never,
    );

    expect(registry.search('scan').map((tool) => tool.name)).toEqual([
      'Inspect',
      'ProjectAnalyzer',
    ]);
  });

  it('indexes discovery hints and long descriptions for deferred tool search', () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool('HeavyInspect', {
        description: {
          short: 'Heavy inspection tool',
          long: 'Performs exhaustive repository inspection for architecture review.',
        },
        exposure: {
          mode: 'deferred',
          discoveryHint: 'Use for architecture review or deep repository inspection.',
        },
        tags: ['analysis'],
        category: 'inspection',
      }) as never,
    );

    expect(registry.search('architecture review').map((tool) => tool.name)).toEqual([
      'HeavyInspect',
    ]);
  });
});
