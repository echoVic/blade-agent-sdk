import Type from 'typebox';
import { describe, expect, it } from 'vitest';
import { PermissionMode } from '../../../types/constants.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import { ToolRegistry, type ToolSourceInfo } from '../../registry/ToolRegistry.js';
import { completeToolExecution } from '../../types/result.js';
import { ToolExposurePlanner } from '../ToolExposurePlanner.js';

const BUILTIN_SOURCE = {
  kind: 'builtin',
  trustLevel: 'trusted',
  sourceId: 'builtin',
} as const;

function registerTool(
  registry: ToolRegistry,
  tool: ReturnType<typeof createTool>,
  source: ToolSourceInfo = BUILTIN_SOURCE,
) {
  registry.register(tool, source);
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
        sideEffect: 'pure',
        description: { short: 'Read tool' },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'WriteTool',
        displayName: 'Write Tool',
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
        description: { short: 'Write tool' },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
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
        sideEffect: 'non_idempotent',
        resolveBehavior: () => ({
          kind: ToolKind.ReadOnly,
          sideEffect: 'pure',
          isReadOnly: true,
        }),
        description: { short: 'Hinted readonly tool' },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'HintWriteTool',
        displayName: 'Hint Write Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        resolveBehavior: () => ({
          kind: ToolKind.Execute,
          sideEffect: 'non_idempotent',
          isReadOnly: false,
        }),
        description: { short: 'Hinted non-readonly tool' },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
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
          sideEffect: name === 'Read' ? 'pure' : 'non_idempotent',
          description: { short: `${name} tool` },
          schema: Type.Object({}),
          execute: () => completeToolExecution({ status: 'success', model: '' }),
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
        sideEffect: 'non_idempotent',
        description: { short: 'Deferred tool' },
        exposure: {
          mode: 'deferred',
          discoveryHint: 'Use when you need heavyweight inspection.',
        },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'AlwaysLoadTool',
        displayName: 'Always Load Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Always loaded deferred tool' },
        exposure: {
          mode: 'deferred',
          alwaysLoad: true,
        },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
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
        title: 'Deferred Tool',
        description: 'Deferred tool',
        exposureMode: 'deferred',
        discoveryHint: 'Use when you need heavyweight inspection.',
      },
    ]);
    expect(discoveredPlan.declarations.map((tool) => tool.name)).toEqual([
      'AlwaysLoadTool',
      'DeferredTool',
    ]);
  });

  it('provides a narrow searchable view of undiscovered tools', () => {
    const registry = new ToolRegistry();
    for (const name of ['HeavyInspect', 'HeavyWrite', 'VisibleRead']) {
      registerTool(
        registry,
        createTool({
          name,
          displayName: name,
          kind: name === 'VisibleRead' ? ToolKind.ReadOnly : ToolKind.Execute,
          sideEffect: name === 'VisibleRead' ? 'pure' : 'non_idempotent',
          description: { short: `${name} tool` },
          exposure: {
            mode: name === 'VisibleRead' ? 'eager' : 'deferred',
          },
          schema: Type.Object({}),
          execute: () => completeToolExecution({ status: 'success', model: '' }),
        }),
      );
    }
    const planner = new ToolExposurePlanner(registry, () => new Set(['HeavyWrite']));
    const matches = planner.listDiscoverable({ query: 'heavy' });

    expect(matches.map((tool) => tool.name)).toEqual(['HeavyInspect']);
  });

  it('reads the current discovered set from its scoped provider', () => {
    const registry = new ToolRegistry();
    registerTool(
      registry,
      createTool({
        name: 'HeavyInspect',
        displayName: 'Heavy Inspect',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Heavy inspection tool' },
        exposure: { mode: 'deferred' },
        schema: Type.Object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      }),
    );
    const planner = new ToolExposurePlanner(registry, () => new Set(['HeavyInspect']));

    expect(planner.listDiscoverable({ query: 'heavy' })).toEqual([]);
  });

  it('filters tool exposure from registry-owned source metadata', () => {
    const registry = new ToolRegistry();
    const builtinTool = createTool({
      name: 'BuiltinTool',
      displayName: 'Builtin Tool',
      kind: ToolKind.ReadOnly,
      sideEffect: 'pure',
      description: { short: 'Builtin tool' },
      schema: Type.Object({}),
      execute: () => completeToolExecution({ status: 'success', model: '' }),
    });
    const remoteMcpTool = createTool({
      name: 'mcp__remote-docs__RemoteTool',
      displayName: 'Remote Tool',
      kind: ToolKind.ReadOnly,
      sideEffect: 'pure',
      description: { short: 'Remote tool' },
      schema: Type.Object({}),
      execute: () => completeToolExecution({ status: 'success', model: '' }),
    });

    registerTool(registry, builtinTool);
    registry.registerMcpTool(remoteMcpTool, {
      kind: 'mcp',
      trustLevel: 'remote',
      sourceId: 'remote-docs',
      serverName: 'remote-docs',
    });

    const planner = new ToolExposurePlanner(registry);
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
        { toolName: 'mcp__remote-docs__RemoteTool', mode: 'hidden', reason: 'source-policy' },
      ]),
    );
  });

  it('plans directly from registry entries', () => {
    const registry = new ToolRegistry();
    const deferredTool = createTool({
      name: 'DeferredTool',
      displayName: 'Deferred Tool',
      kind: ToolKind.Execute,
      sideEffect: 'non_idempotent',
      description: { short: 'Deferred tool' },
      exposure: {
        mode: 'deferred',
      },
      schema: Type.Object({}),
      execute: () => completeToolExecution({ status: 'success', model: '' }),
    });

    registerTool(registry, deferredTool);

    const planner = new ToolExposurePlanner(registry);
    const plan = planner.plan();

    expect(plan.declarations).toEqual([]);
    expect(plan.discoverableTools).toEqual([
      {
        name: 'DeferredTool',
        title: 'Deferred Tool',
        description: 'Deferred tool',
        exposureMode: 'deferred',
        discoveryHint: undefined,
      },
    ]);
  });
});
