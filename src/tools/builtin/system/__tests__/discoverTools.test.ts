import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolCatalog } from '../../../catalog/ToolCatalog.js';
import { ToolRegistry } from '../../../registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../types/ExecutionTypes.js';
import { ToolKind } from '../../../types/ToolKind.js';
import {
  collectToolExecution,
  completeToolExecution,
  type ToolYield,
} from '../../../types/ToolResult.js';
import { createTool } from '../../../core/createTool.js';
import { discoverToolsTool } from '../discoverTools.js';

async function executeDiscoverTools(
  params: Parameters<typeof discoverToolsTool.build>[0],
  context: Partial<ExecutionContext>,
) {
  const events: ToolYield[] = [];
  const result = await collectToolExecution(
    discoverToolsTool.build(params).execute(
      new AbortController().signal,
      context,
    ),
    (event) => {
      events.push(event);
    },
  );
  return { result, events };
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
      execute: () => completeToolExecution({ status: 'success', model: '' }),
    }) as never);

    const { result, events } = await executeDiscoverTools(
      { query: 'heavy' },
      { toolRegistry: registry },
    );

    expect(result.status).toBe('success');
    expect(events).toEqual([
      {
        kind: 'effect',
        effect: {
          type: 'runtimePatch',
          patch: {
            scope: 'session',
            source: 'tool',
            toolDiscovery: {
              discover: ['HeavyInspect'],
            },
          },
        },
      },
    ]);
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
      execute: () => completeToolExecution({ status: 'success', model: '' }),
    }) as never);

    const { result, events } = await executeDiscoverTools(
      { query: 'heavy' },
      { toolRegistry: registry, discoveredTools: ['HeavyInspect'] },
    );

    expect(result.status).toBe('success');
    expect(events).toEqual([]);
    expect(String(result.model)).toContain('No hidden tools matched');
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
      execute: () => completeToolExecution({ status: 'success', model: '' }),
    }), {
      kind: 'builtin',
      trustLevel: 'trusted',
      sourceId: 'builtin',
    });

    const { result, events } = await executeDiscoverTools(
      { query: 'heavy' },
      { toolCatalog: catalog },
    );

    expect(result.status).toBe('success');
    expect(events).toEqual([
      {
        kind: 'effect',
        effect: {
          type: 'runtimePatch',
          patch: {
            scope: 'session',
            source: 'tool',
            toolDiscovery: {
              discover: ['HeavyInspect'],
            },
          },
        },
      },
    ]);
  });
});
