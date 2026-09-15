import { describe, expect, it } from 'vitest';
import { taskTool } from '../task.js';

describe('taskTool', () => {
  it('declares its runtime services instead of capturing a registry', () => {
    expect(taskTool.services).toEqual(['subagentRegistry', 'backgroundAgentManager']);
    expect(() =>
      taskTool.build({
        subagent_type: 'session-auditor',
        description: 'Review SDK diff',
        prompt: 'Inspect the memory and subagent API changes.',
        run_in_background: false,
      }),
    ).not.toThrow();
  });
});
