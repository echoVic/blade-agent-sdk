import { describe, expect, it } from 'vitest';
import { ToolExposurePlanner } from '../tools/exposure/ToolExposurePlanner.js';
import type { Tool, ToolCatalogReadView, ToolCatalogEntry } from '../tools/index.js';

describe('ToolExposurePlanner (agent-sdk)', () => {
  function stubTool(name: string, overrides?: Partial<Tool>): Tool {
    return {
      name,
      aliases: [],
      displayName: name,
      kind: 'execute' as any,
      isReadOnly: true,
      isConcurrencySafe: true,
      strict: false,
      maxResultSizeChars: 10000,
      interruptBehavior: 'block',
      description: { short: `Tool: ${name}` },
      exposure: { mode: 'eager' as any, alwaysLoad: false, discoveryHint: '' },
      version: '1.0',
      tags: ['stub'],
      ...overrides,
      getFunctionDeclaration: () => ({ name, description: `Tool: ${name}`, parameters: { type: 'object', properties: {} } }),
      describe: () => ({ short: `Tool: ${name}` }),
      getMetadata: () => ({}),
      build: () => ({ toolName: name, params: {} as any, getDescription: () => '', getAffectedPaths: () => [], execute: async () => ({ success: true, llmContent: 'ok' }) }),
      execute: async () => ({ success: true, llmContent: 'ok' }),
    } as unknown as Tool;
  }

  function stubCatalog(tools: Tool[], entries?: ToolCatalogEntry[]): ToolCatalogReadView {
    return {
      getAll: () => tools,
      getEntries: () => entries ?? [],
    };
  }

  it('can be instantiated with a catalog', () => {
    const catalog = stubCatalog([]);
    const planner = new ToolExposurePlanner(catalog);
    expect(planner).toBeInstanceOf(ToolExposurePlanner);
  });

  it('plans exposures for registered tools', () => {
    const tool = stubTool('test_tool');
    const catalog = stubCatalog([tool]);
    const planner = new ToolExposurePlanner(catalog);
    const plan = planner.plan();
    expect(plan.declarations).toHaveLength(1);
    expect(plan.exposures).toHaveLength(1);
    expect(plan.exposures[0].toolName).toBe('test_tool');
    expect(plan.exposures[0].mode).toBe('eager');
  });

  it('hides tools blocked by runtime deny policy', () => {
    const tool = stubTool('blocked_tool');
    const catalog = stubCatalog([tool]);
    const planner = new ToolExposurePlanner(catalog);
    const plan = planner.plan({
      runtimeToolPolicy: { deny: ['blocked_tool'] },
    });
    expect(plan.declarations).toHaveLength(0);
    expect(plan.exposures[0].mode).toBe('hidden');
    expect(plan.exposures[0].reason).toBeDefined();
  });

  it('returns discoverable tools for deferred mode', () => {
    const tool = stubTool('discoverable_tool', {
      exposure: { mode: 'deferred' as any, alwaysLoad: false, discoveryHint: 'hint' },
    });
    const catalog = stubCatalog([tool]);
    const planner = new ToolExposurePlanner(catalog);
    const plan = planner.plan();
    expect(plan.declarations).toHaveLength(0);
    expect(plan.discoverableTools).toHaveLength(1);
    expect(plan.discoverableTools[0].mode).toBe('deferred');
  });

  it('returns eager declarations for discovered tools', () => {
    const tool = stubTool('discovered_tool');
    const catalog = stubCatalog([tool]);
    const planner = new ToolExposurePlanner(catalog);
    const plan = planner.plan({ discoveredTools: ['discovered_tool'] });
    expect(plan.declarations).toHaveLength(1);
    expect(plan.discoverableTools).toHaveLength(0);
  });
});
