import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolCatalog } from '../../../catalog/ToolCatalog.js';
import { ToolRegistry } from '../../../registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../types/ExecutionTypes.js';
import { ToolKind } from '../../../types/ToolKind.js';
import { createTool } from '../../../core/createTool.js';
import { discoverToolsTool } from '../discoverTools.js';

async function executeDiscoverTools(
  params: Parameters<typeof discoverToolsTool.build>[0],
  context: Partial<ExecutionContext>,
) {
  return discoverToolsTool.build(params).execute(
    new AbortController().signal,
    undefined,
    context,
  );
}

describe('DiscoverTools tool', () => {
  it('activates matching deferred tools through a runtime patch', async () => {
    const registry = new ToolRegistry();
    registry.register(createTool({
      name: 'HeavyInspect',
      displayName: 'Heavy Inspect',
      kind: ToolKind.Execute,
      description: { short: 'Heavy inspection tool' },
      exposure: {
        mode: 'deferred',
      },
      schema: z.object({}),
      execute: async () => ({ success: true, llmContent: '' }),
    }) as never);

    const result = await executeDiscoverTools(
      { query: 'heavy' },
      { toolRegistry: registry },
    );

    expect(result.success).toBe(true);
    expect(result.effects).toEqual([
      {
        type: 'runtimePatch',
        patch: {
          scope: 'session',
          source: 'tool',
          toolDiscovery: {
            discover: ['HeavyInspect'],
          },
        },
      },
    ]);
    expect(result.runtimePatch).toEqual({
      scope: 'session',
      source: 'tool',
      toolDiscovery: {
        discover: ['HeavyInspect'],
      },
    });
  });

  it('skips already discovered tools and returns a helpful empty result', async () => {
    const registry = new ToolRegistry();
    registry.register(createTool({
      name: 'HeavyInspect',
      displayName: 'Heavy Inspect',
      kind: ToolKind.Execute,
      description: { short: 'Heavy inspection tool' },
      exposure: {
        mode: 'deferred',
      },
      schema: z.object({}),
      execute: async () => ({ success: true, llmContent: '' }),
    }) as never);

    const result = await executeDiscoverTools(
      { query: 'heavy' },
      { toolRegistry: registry, discoveredTools: ['HeavyInspect'] },
    );

    expect(result.success).toBe(true);
    expect(result.effects).toBeUndefined();
    expect(result.runtimePatch).toBeUndefined();
    expect(String(result.llmContent)).toContain('No hidden tools matched');
  });

  it('prefers catalog-backed search so discovery works from immutable pools too', async () => {
    const catalog = new ToolCatalog();
    catalog.register(createTool({
      name: 'HeavyInspect',
      displayName: 'Heavy Inspect',
      kind: ToolKind.Execute,
      description: { short: 'Heavy inspection tool' },
      exposure: {
        mode: 'deferred',
      },
      schema: z.object({}),
      execute: async () => ({ success: true, llmContent: '' }),
    }), {
      kind: 'builtin',
      trustLevel: 'trusted',
      sourceId: 'builtin',
    });

    const result = await executeDiscoverTools(
      { query: 'heavy' },
      { toolCatalog: catalog },
    );

    expect(result.success).toBe(true);
    expect(result.runtimePatch).toEqual({
      scope: 'session',
      source: 'tool',
      toolDiscovery: {
        discover: ['HeavyInspect'],
      },
    });
  });
});
