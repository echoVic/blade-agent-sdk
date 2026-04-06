import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PermissionMode } from '../../../types/common.js';
import { ToolCatalog } from '../../catalog/ToolCatalog.js';
import { createTool } from '../../core/createTool.js';
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import { ToolKind } from '../../types/index.js';
import { ToolExposurePlanner } from '../ToolExposurePlanner.js';

function registerTool(registry: ToolRegistry, tool: ReturnType<typeof createTool>) {
  registry.register(tool as never);
}

describe('ToolExposurePlanner', () => {
  it('filters non-readonly tools in plan mode', () => {
    const registry = new ToolRegistry();
    registerTool(
      registry,
      createTool({
        name: 'ReadTool',
        displayName: 'Read Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Read tool' },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'WriteTool',
        displayName: 'Write Tool',
        kind: ToolKind.Write,
        description: { short: 'Write tool' },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
      }),
    );

    const planner = new ToolExposurePlanner(registry);
    const plan = planner.plan({ permissionMode: PermissionMode.PLAN });

    expect(plan.declarations.map((tool) => tool.name)).toEqual(['ReadTool']);
    expect(plan.exposures).toEqual(
      expect.arrayContaining([
        { toolName: 'ReadTool', mode: 'eager' },
        { toolName: 'WriteTool', mode: 'hidden', reason: 'plan-mode-hidden' },
      ]),
    );
  });

  it('uses behavior hints instead of static readonly flags when planning exposure', () => {
    const registry = new ToolRegistry();
    registerTool(
      registry,
      createTool({
        name: 'HintReadTool',
        displayName: 'Hint Read Tool',
        kind: ToolKind.Execute,
        resolveBehaviorHint: () => ({
          kind: ToolKind.ReadOnly,
          isReadOnly: true,
        }),
        description: { short: 'Hinted readonly tool' },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'HintWriteTool',
        displayName: 'Hint Write Tool',
        kind: ToolKind.ReadOnly,
        resolveBehaviorHint: () => ({
          kind: ToolKind.Execute,
          isReadOnly: false,
        }),
        description: { short: 'Hinted non-readonly tool' },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
      }),
    );

    const planner = new ToolExposurePlanner(registry);
    const plan = planner.plan({ permissionMode: PermissionMode.PLAN });

    expect(plan.declarations.map((tool) => tool.name)).toEqual(['HintReadTool']);
    expect(plan.exposures).toEqual(
      expect.arrayContaining([
        { toolName: 'HintReadTool', mode: 'eager' },
        { toolName: 'HintWriteTool', mode: 'hidden', reason: 'plan-mode-hidden' },
      ]),
    );
  });

  it('applies runtime allow and deny policies before exposing tools', () => {
    const registry = new ToolRegistry();
    for (const name of ['Read', 'Write', 'Bash']) {
      registerTool(
        registry,
        createTool({
          name,
          displayName: name,
          kind: name === 'Read' ? ToolKind.ReadOnly : ToolKind.Execute,
          description: { short: `${name} tool` },
          schema: z.object({}),
          execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
        }),
      );
    }

    const planner = new ToolExposurePlanner(registry);
    const plan = planner.plan({
      runtimeToolPolicy: {
        allow: ['Read', 'Bash(command:*)'],
        deny: ['Bash'],
      },
    });

    expect(plan.declarations.map((tool) => tool.name)).toEqual(['Read']);
    expect(plan.exposures).toEqual(
      expect.arrayContaining([
        { toolName: 'Read', mode: 'eager' },
        { toolName: 'Write', mode: 'hidden', reason: 'runtime-allow-list' },
        { toolName: 'Bash', mode: 'hidden', reason: 'runtime-deny' },
      ]),
    );
  });

  it('keeps deferred tools out of declarations until they are discovered', () => {
    const registry = new ToolRegistry();
    registerTool(
      registry,
      createTool({
        name: 'DeferredTool',
        displayName: 'Deferred Tool',
        kind: ToolKind.Execute,
        description: { short: 'Deferred tool' },
        exposure: {
          mode: 'deferred',
          discoveryHint: 'Use when you need heavyweight inspection.',
        },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'AlwaysLoadTool',
        displayName: 'Always Load Tool',
        kind: ToolKind.Execute,
        description: { short: 'Always loaded deferred tool' },
        exposure: {
          mode: 'deferred',
          alwaysLoad: true,
        },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
      }),
    );

    const planner = new ToolExposurePlanner(registry);
    const hiddenPlan = planner.plan();
    const discoveredPlan = planner.plan({
      discoveredTools: ['DeferredTool'],
    });

    expect(hiddenPlan.declarations.map((tool) => tool.name)).toEqual(['AlwaysLoadTool']);
    expect(hiddenPlan.discoverableTools).toEqual([
      {
        name: 'DeferredTool',
        displayName: 'Deferred Tool',
        description: 'Deferred tool',
        mode: 'deferred',
        discoveryHint: 'Use when you need heavyweight inspection.',
      },
    ]);
    expect(discoveredPlan.declarations.map((tool) => tool.name)).toEqual([
      'AlwaysLoadTool',
      'DeferredTool',
    ]);
  });

  it('filters tool exposure by source and trust when planning from a catalog', () => {
    const catalog = new ToolCatalog();
    const builtinTool = createTool({
      name: 'BuiltinTool',
      displayName: 'Builtin Tool',
      kind: ToolKind.ReadOnly,
      description: { short: 'Builtin tool' },
      schema: z.object({}),
      execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
    });
    const remoteMcpTool = createTool({
      name: 'RemoteTool',
      displayName: 'Remote Tool',
      kind: ToolKind.ReadOnly,
      description: { short: 'Remote tool' },
      schema: z.object({}),
      execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
    });

    catalog.register(builtinTool, {
      kind: 'builtin',
      trustLevel: 'trusted',
      sourceId: 'builtin',
    });
    catalog.registerMcpTool(remoteMcpTool, {
      kind: 'mcp',
      trustLevel: 'remote',
      sourceId: 'remote-docs',
    });

    const planner = new ToolExposurePlanner(catalog);
    const plan = planner.plan({
      sourcePolicy: {
        allowedSources: ['builtin'],
        allowedTrustLevels: ['trusted', 'workspace'],
      },
    });

    expect(plan.declarations.map((tool) => tool.name)).toEqual(['BuiltinTool']);
    expect(plan.exposures).toEqual(
      expect.arrayContaining([
        { toolName: 'BuiltinTool', mode: 'eager' },
        { toolName: 'RemoteTool', mode: 'hidden', reason: 'source-policy' },
      ]),
    );
  });

  it('can plan directly from an immutable tool pool snapshot', () => {
    const catalog = new ToolCatalog();
    const deferredTool = createTool({
      name: 'DeferredTool',
      displayName: 'Deferred Tool',
      kind: ToolKind.Execute,
      description: { short: 'Deferred tool' },
      exposure: {
        mode: 'deferred',
      },
      schema: z.object({}),
      execute: async () => ({ success: true, llmContent: '', displayContent: '' }),
    });

    catalog.register(deferredTool, {
      kind: 'builtin',
      trustLevel: 'trusted',
      sourceId: 'builtin',
    });

    const planner = new ToolExposurePlanner(catalog);
    const plan = planner.plan();

    expect(plan.declarations).toEqual([]);
    expect(plan.discoverableTools).toEqual([
      {
        name: 'DeferredTool',
        displayName: 'Deferred Tool',
        description: 'Deferred tool',
        mode: 'deferred',
        discoveryHint: undefined,
      },
    ]);
  });
});
