import { describe, expect, it } from 'vitest';
import {
  PermissionMode,
  SubagentExecutor,
  SubagentRegistry,
  mapClaudeCodePermissionMode,
} from '../../packages/agent-sdk/src/index.js';

describe('agent-sdk root subagent exports', () => {
  it('exposes package-local subagent registry behavior', () => {
    const registry = new SubagentRegistry();

    registry.loadBuiltinAgents();
    registry.register({
      name: 'Plan',
      description: 'Session planner',
      source: 'session',
    }, { override: true });

    expect(registry.getAllNames()).toEqual(['general-purpose', 'Explore', 'Plan']);
    expect(registry.getSubagent('Plan')).toMatchObject({
      description: 'Session planner',
      source: 'session',
    });
    expect(registry.getDescriptionsForPrompt()).toContain('Session planner');
  });

  it('keeps executor facade package-local and runner-injectable', async () => {
    const executor = new SubagentExecutor(
      {
        name: 'Explore',
        description: 'Explore code',
        omitEnvironment: true,
      },
      {
        models: [],
        currentModelId: 'default',
      },
      undefined,
      async ({ config, context }) => ({
        success: true,
        message: `${config.name}:${context.prompt}`,
        agentId: 'child-1',
        stats: {
          duration: 1,
        },
      }),
    );

    await expect(executor.execute({ prompt: 'inspect' })).resolves.toMatchObject({
      success: true,
      message: 'Explore:inspect',
      agentId: 'child-1',
    });
  });

  it('maps Claude-style permission modes without importing legacy root subagent types', () => {
    expect(mapClaudeCodePermissionMode('acceptEdits')).toBe(PermissionMode.AUTO_EDIT);
    expect(mapClaudeCodePermissionMode('bypassPermissions')).toBe(PermissionMode.YOLO);
    expect(mapClaudeCodePermissionMode('plan')).toBe(PermissionMode.PLAN);
  });
});
