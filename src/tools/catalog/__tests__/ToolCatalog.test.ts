import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../types/index.js';
import { ToolCatalog } from '../ToolCatalog.js';

describe('ToolCatalog', () => {
  it('tracks source and trust metadata alongside registered tools', () => {
    const catalog = new ToolCatalog();
    const builtinTool = createTool({
      name: 'Read',
      displayName: 'Read',
      kind: ToolKind.ReadOnly,
      description: { short: 'Read tool' },
      schema: z.object({}),
      execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
    });

    catalog.register(builtinTool, {
      kind: 'builtin',
      trustLevel: 'trusted',
      sourceId: 'builtin',
    });

    expect(catalog.getAll().map((tool) => tool.name)).toEqual(['Read']);
    expect(catalog.getEntry('Read')).toMatchObject({
      tool: expect.objectContaining({ name: 'Read' }),
      source: {
        kind: 'builtin',
        trustLevel: 'trusted',
        sourceId: 'builtin',
      },
    });
  });

  it('keeps MCP source metadata in sync when server tools are refreshed', () => {
    const catalog = new ToolCatalog();
    const remoteTool = createTool({
      name: 'mcp__docs__Search',
      displayName: 'Search',
      kind: ToolKind.ReadOnly,
      description: { short: 'Search docs' },
      tags: ['docs'],
      schema: z.object({}),
      execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
    });

    catalog.registerMcpTool(remoteTool, {
      kind: 'mcp',
      trustLevel: 'remote',
      sourceId: 'docs',
    });
    expect(catalog.getEntry('mcp__docs__Search')?.source.sourceId).toBe('docs');

    catalog.removeMcpTools('docs');
    expect(catalog.getEntry('mcp__docs__Search')).toBeUndefined();
  });

  it('reflects current registrations in getAll and getEntries', () => {
    const catalog = new ToolCatalog();
    const readTool = createTool({
      name: 'Read',
      displayName: 'Read',
      kind: ToolKind.ReadOnly,
      description: { short: 'Read tool' },
      schema: z.object({}),
      execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
    });
    const writeTool = createTool({
      name: 'Write',
      displayName: 'Write',
      kind: ToolKind.Write,
      description: { short: 'Write tool' },
      schema: z.object({}),
      execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
    });

    catalog.register(readTool, {
      kind: 'builtin',
      trustLevel: 'trusted',
      sourceId: 'builtin',
    });

    expect(catalog.getAll().map((tool) => tool.name)).toEqual(['Read']);
    expect(catalog.getEntries().map((entry) => entry.tool.name)).toEqual(['Read']);

    catalog.register(writeTool, {
      kind: 'custom',
      trustLevel: 'workspace',
      sourceId: 'session',
    });

    expect(catalog.getAll().map((tool) => tool.name)).toEqual(['Read', 'Write']);
    expect(catalog.getEntries().map((entry) => entry.tool.name)).toEqual(['Read', 'Write']);
  });
});
