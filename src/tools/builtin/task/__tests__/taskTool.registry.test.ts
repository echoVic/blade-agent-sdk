import { describe, expect, it } from 'vitest';
import { SubagentRegistry } from '../../../../agent/subagents/SubagentRegistry.js';
import { createTaskTool } from '../task.js';

describe('createTaskTool', () => {
  it('validates against the injected registry only', () => {
    const registry = new SubagentRegistry();
    registry.register({
      name: 'session-auditor',
      description: 'Review code changes',
      tools: ['Read', 'Glob', 'Grep'],
    });

    const tool = createTaskTool({ registry });

    expect(() =>
      tool.build({
        subagent_type: 'session-auditor',
        description: 'Review SDK diff',
        prompt: 'Inspect the memory and subagent API changes.',
        run_in_background: false,
      })
    ).not.toThrow();

    const description = tool.getFunctionDeclaration().description;
    expect(description).toContain('session-auditor');
    expect(description).not.toContain('verification');
  });
});
