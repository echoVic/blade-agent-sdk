import { describe, expect, it } from 'vitest';
import { SubagentRegistry } from '../../../agent/subagents/SubagentRegistry.js';
import { SessionId } from '../../../types/branded.js';
import { createBuiltinToolGroups, flattenBuiltinToolGroups } from '../groups.js';

function toolNames(tools: ReturnType<typeof flattenBuiltinToolGroups>): string[] {
  return tools.map((tool) => tool.name);
}

describe('builtin tool groups', () => {
  it('preserves the default builtin tool boundaries and order', () => {
    const groups = createBuiltinToolGroups({
      sessionId: SessionId('builtin-groups'),
      subagentRegistry: new SubagentRegistry(),
    });

    expect(toolNames(groups.filesystem)).toEqual([
      'Read',
      'Edit',
      'Write',
      'NotebookEdit',
      'Glob',
      'Grep',
    ]);
    expect(toolNames(groups.shell)).toEqual(['Bash', 'KillShell']);
    expect(toolNames(groups.web)).toEqual(['WebFetch', 'WebSearch']);
    expect(toolNames(groups.task)).toEqual([
      'Task',
      'TaskOutput',
      'TaskCreate',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
      'TaskStop',
      'TodoWrite',
    ]);
    expect(groups.memory).toEqual([]);
    expect(toolNames(groups.system)).toEqual([
      'EnterPlanMode',
      'ExitPlanMode',
      'AskUserQuestion',
      'DiscoverTools',
      'Skill',
    ]);
    expect(groups.mcpResources).toEqual([]);

    expect(toolNames(flattenBuiltinToolGroups(groups))).toEqual([
      'Read',
      'Edit',
      'Write',
      'NotebookEdit',
      'Glob',
      'Grep',
      'Bash',
      'KillShell',
      'WebFetch',
      'WebSearch',
      'Task',
      'TaskOutput',
      'TaskCreate',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
      'TaskStop',
      'TodoWrite',
      'EnterPlanMode',
      'ExitPlanMode',
      'AskUserQuestion',
      'DiscoverTools',
      'Skill',
    ]);
  });
});
