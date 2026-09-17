import Type from 'typebox';
import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../../../types/json.js';
import { ToolKind } from '../../../behavior.js';
import { createTool } from '../../../core/createTool.js';
import { ToolExposurePlanner } from '../../../exposure/ToolExposurePlanner.js';
import { BUILTIN_TOOL_SOURCE, ToolRegistry } from '../../../registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../types/execution.js';
import {
  collectToolExecution,
  completeToolExecution,
  type ToolYield,
} from '../../../types/result.js';
import { discoverToolsTool } from '../discoverTools.js';

async function executeDiscoverTools(params: JsonObject, context: Partial<ExecutionContext>) {
  const events: ToolYield[] = [];
  const result = await collectToolExecution(discoverToolsTool.execute(params, context), (event) => {
    events.push(event);
  });
  return { result, events };
}

describe('DiscoverTools tool', () => {
  it('discovers tools through a narrow catalog view', async () => {
    const { result, events } = await executeDiscoverTools({ query: 'heavy' }, {
      discoverableCatalog: {
        listDiscoverable: () => [
          {
            name: 'HeavyInspect',
            title: 'Heavy Inspect',
            description: 'Heavy inspection tool',
            exposureMode: 'deferred',
          },
        ],
      },
    } as Partial<ExecutionContext>);

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

  it('activates matching deferred tools through a runtime patch', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'HeavyInspect',
        displayName: 'Heavy Inspect',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Heavy inspection tool' },
        exposure: {
          mode: 'deferred',
        },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      }) as never,
      BUILTIN_TOOL_SOURCE,
    );

    const { result, events } = await executeDiscoverTools(
      { query: 'heavy' },
      { discoverableCatalog: new ToolExposurePlanner(registry) },
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
    registry.register(
      createTool({
        name: 'HeavyInspect',
        displayName: 'Heavy Inspect',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Heavy inspection tool' },
        exposure: {
          mode: 'deferred',
        },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      }) as never,
      BUILTIN_TOOL_SOURCE,
    );

    const { result, events } = await executeDiscoverTools(
      { query: 'heavy' },
      {
        discoverableCatalog: new ToolExposurePlanner(registry, () => new Set(['HeavyInspect'])),
      },
    );

    expect(result.status).toBe('success');
    expect(events).toEqual([]);
    expect(String(result.model)).toContain('No hidden tools matched');
  });

  it('searches registry entries directly', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'HeavyInspect',
        displayName: 'Heavy Inspect',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Heavy inspection tool' },
        exposure: {
          mode: 'deferred',
        },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      }),
      BUILTIN_TOOL_SOURCE,
    );

    const { result, events } = await executeDiscoverTools(
      { query: 'heavy' },
      { discoverableCatalog: new ToolExposurePlanner(registry) },
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
