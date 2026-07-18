import { describe, expect, it } from 'vitest';
import { ToolCatalog } from '../tools/catalog/ToolCatalog.js';
import type { Tool } from '../tools/types/index.js';

describe('ToolCatalog (agent-sdk)', () => {
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
      exposure: { mode: 'auto' as any, alwaysLoad: false, discoveryHint: '' },
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
    const catalog = new ToolCatalog();
    expect(catalog).toBeInstanceOf(ToolCatalog);
  });

  it('registers and retrieves tools', () => {
    const catalog = new ToolCatalog();
    const tool = stubTool('test_tool');
    catalog.register(tool);
    expect(catalog.get('test_tool')).toBe(tool);
    expect(catalog.has('test_tool')).toBe(true);
    expect(catalog.getAll()).toHaveLength(1);
  });

  it('provides entries with source info', () => {
    const catalog = new ToolCatalog();
    const tool = stubTool('test_tool');
    catalog.register(tool, { kind: 'builtin', trustLevel: 'trusted', sourceId: 'test' });
    const entries = catalog.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].source.kind).toBe('builtin');
    expect(entries[0].source.trustLevel).toBe('trusted');
  });

  it('unregisters a tool', () => {
    const catalog = new ToolCatalog();
    catalog.register(stubTool('test_tool'));
    expect(catalog.getAll()).toHaveLength(1);
    expect(catalog.unregister('test_tool')).toBe(true);
    expect(catalog.getAll()).toHaveLength(0);
  });

  it('generates function declarations', () => {
    const catalog = new ToolCatalog();
    catalog.register(stubTool('tool_a'));
    catalog.register(stubTool('tool_b'));
    const decls = catalog.getFunctionDeclarations();
    expect(decls).toHaveLength(2);
    expect(decls.map(d => d.name).sort()).toEqual(['tool_a', 'tool_b']);
  });

  it('searches tools', () => {
    const catalog = new ToolCatalog();
    catalog.register(stubTool('find_files', { tags: ['search'] }));
    catalog.register(stubTool('list_dir', { tags: ['filesystem'] }));
    const results = catalog.search('find');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('find_files');
  });

  it('registers MCP tools', () => {
    const catalog = new ToolCatalog();
    const tool = stubTool('mcp_tool', { tags: ['mcp_server'] });
    catalog.registerMcpTool(tool, { kind: 'mcp', trustLevel: 'remote', sourceId: 'server1' });
    expect(catalog.get('mcp_tool')).toBe(tool);
  });

  it('removes MCP tools by server name', () => {
    const catalog = new ToolCatalog();
    catalog.registerMcpTool(stubTool('mcp_a', { tags: ['server1'] }));
    catalog.registerMcpTool(stubTool('mcp_b', { tags: ['server1'] }));
    catalog.registerMcpTool(stubTool('mcp_c', { tags: ['server2'] }));
    expect(catalog.getAll()).toHaveLength(3);
    const removed = catalog.removeMcpTools('server1');
    expect(removed).toBe(2);
    expect(catalog.getAll()).toHaveLength(1);
    expect(catalog.get('mcp_c')).toBeDefined();
  });
});
