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

  it('declares an explicit interruption policy for every default builtin tool', () => {
    const tools = flattenBuiltinToolGroups(createBuiltinToolGroups({
      sessionId: SessionId('builtin-interrupt-behavior'),
      subagentRegistry: new SubagentRegistry(),
    }));

    expect(Object.fromEntries(
      tools.map((tool) => [tool.name, tool.interruptBehavior]),
    )).toEqual({
      Read: 'cancel',
      Edit: 'block',
      Write: 'block',
      NotebookEdit: 'block',
      Glob: 'cancel',
      Grep: 'cancel',
      Bash: 'cancel',
      KillShell: 'block',
      WebFetch: 'cancel',
      WebSearch: 'cancel',
      Task: 'block',
      TaskOutput: 'block',
      TaskCreate: 'block',
      TaskGet: 'block',
      TaskUpdate: 'block',
      TaskList: 'block',
      TaskStop: 'block',
      TodoWrite: 'block',
      EnterPlanMode: 'block',
      ExitPlanMode: 'block',
      AskUserQuestion: 'block',
      DiscoverTools: 'block',
      Skill: 'block',
    });

    const bash = tools.find((tool) => tool.name === 'Bash');
    expect(bash?.resolveBehavior?.({
      command: 'sleep 10',
      run_in_background: false,
    })).toMatchObject({ interruptBehavior: 'cancel' });
    expect(bash?.resolveBehavior?.({
      command: 'sleep 10',
      run_in_background: true,
    })).toMatchObject({ interruptBehavior: 'block' });
  });

  it('declares an explicit side-effect contract for every default builtin tool', () => {
    const tools = flattenBuiltinToolGroups(createBuiltinToolGroups({
      sessionId: SessionId('builtin-side-effects'),
      subagentRegistry: new SubagentRegistry(),
    }));

    expect(Object.fromEntries(
      tools.map((tool) => [tool.name, tool.sideEffect]),
    )).toEqual({
      Read: 'pure',
      Edit: 'non_idempotent',
      Write: 'idempotent',
      NotebookEdit: 'non_idempotent',
      Glob: 'pure',
      Grep: 'pure',
      Bash: 'non_idempotent',
      KillShell: 'idempotent',
      WebFetch: 'non_idempotent',
      WebSearch: 'pure',
      Task: 'non_idempotent',
      TaskOutput: 'non_idempotent',
      TaskCreate: 'non_idempotent',
      TaskGet: 'pure',
      TaskUpdate: 'idempotent',
      TaskList: 'pure',
      TaskStop: 'idempotent',
      TodoWrite: 'idempotent',
      EnterPlanMode: 'non_idempotent',
      ExitPlanMode: 'non_idempotent',
      AskUserQuestion: 'non_idempotent',
      DiscoverTools: 'idempotent',
      Skill: 'non_idempotent',
    });

    const bash = tools.find((tool) => tool.name === 'Bash');
    expect(bash?.resolveBehavior?.({
      command: 'git status',
      run_in_background: false,
    })).toMatchObject({ sideEffect: 'pure' });
    expect(bash?.resolveBehavior?.({
      command: 'git commit -m test',
      run_in_background: false,
    })).toMatchObject({ sideEffect: 'non_idempotent' });

    const webFetch = tools.find((tool) => tool.name === 'WebFetch');
    expect(webFetch?.resolveBehavior?.({ url: 'https://example.com', method: 'GET' }))
      .toMatchObject({ sideEffect: 'pure' });
    expect(webFetch?.resolveBehavior?.({ url: 'https://example.com', method: 'PUT' }))
      .toMatchObject({ sideEffect: 'idempotent' });
    expect(webFetch?.resolveBehavior?.({ url: 'https://example.com', method: 'POST' }))
      .toMatchObject({ sideEffect: 'non_idempotent' });
  });
});
