import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { Tool } from '../tools/types/index.js';

describe('ToolRegistry (agent-sdk)', () => {
  // Helper to create a minimal tool stub
  function stubTool(name: string, opts?: Partial<Tool>): Tool {
    return {
      name,
      aliases: [],
      displayName: name,
      kind: 'execute' as any,
      isReadOnly: false,
      isConcurrencySafe: true,
      strict: false,
      maxResultSizeChars: 10000,
      interruptBehavior: 'block',
      description: { short: `Tool: ${name}` },
      exposure: { mode: 'manual' as any, alwaysLoad: false, discoveryHint: '' },
      version: '1.0',
      tags: ['stub'],
      ...opts,
      getFunctionDeclaration: () => ({ name, description: `Tool: ${name}`, parameters: { type: 'object', properties: {} } }),
      describe: () => ({ short: `Tool: ${name}` }),
      getMetadata: () => ({}),
      build: () => ({ toolName: name, params: {} as any, getDescription: () => '', getAffectedPaths: () => [], execute: async () => ({ success: true, llmContent: 'ok' }) }),
      execute: async () => ({ success: true, llmContent: 'ok' }),
    } as unknown as Tool;
  }

  it('can be instantiated', () => {
    const registry = new ToolRegistry();
    expect(registry).toBeInstanceOf(ToolRegistry);
  });

  it('registers and retrieves a tool', () => {
    const registry = new ToolRegistry();
    const tool = stubTool('test_tool');
    registry.register(tool);

    expect(registry.has('test_tool')).toBe(true);
    expect(registry.get('test_tool')).toBe(tool);
    expect(registry.getAll()).toHaveLength(1);
  });

  it('throws on duplicate registration', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('test_tool'));
    expect(() => registry.register(stubTool('test_tool'))).toThrow();
  });

  it('unregisters a tool', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('test_tool'));
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.unregister('test_tool')).toBe(true);
    expect(registry.getAll()).toHaveLength(0);
  });

  it('registers and queries by tag', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('tool_a', { tags: ['foo', 'bar'] }));
    registry.register(stubTool('tool_b', { tags: ['bar'] }));

    const byFoo = registry.getByTag('foo');
    expect(byFoo).toHaveLength(1);
    expect(byFoo[0].name).toBe('tool_a');

    const byBar = registry.getByTag('bar');
    expect(byBar).toHaveLength(2);
  });

  it('registers and queries by category', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('cat_tool', { category: 'files' }));
    const byCat = registry.getByCategory('files');
    expect(byCat).toHaveLength(1);
    expect(byCat[0].name).toBe('cat_tool');
  });

  it('searches tools', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('alpha', { tags: ['alpha'] }));
    registry.register(stubTool('beta', { tags: ['beta'] }));

    const results = registry.search('alpha');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('alpha');
  });

  it('provides statistics', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('t1', { tags: ['x'] }));
    registry.register(stubTool('t2', { tags: ['y'] }));

    const stats = registry.getStatistics();
    expect(stats.totalTools).toBe(2);
    expect(stats.builtinTools).toBe(2);
    expect(stats.tags).toBe(2);
  });
});
