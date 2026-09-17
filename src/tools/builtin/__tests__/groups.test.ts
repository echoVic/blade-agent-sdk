import { describe, expect, it } from 'vitest';
import { resolveBehavior } from '../../behavior.js';
import type { BuiltinToolGroup, Tool } from '../../types/tool.js';
import { builtinTools } from '../index.js';

function toolNames(tools: readonly Tool[]): string[] {
  return tools.map((tool) => tool.name);
}

describe('builtin tool groups', () => {
  it('preserves the default builtin tool order', () => {
    expect(toolNames(builtinTools)).toEqual([
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
      'MemoryRead',
      'MemoryWrite',
      'EnterPlanMode',
      'ExitPlanMode',
      'AskUserQuestion',
      'DiscoverTools',
      'Skill',
      'ListMcpResources',
      'ReadMcpResource',
    ]);
  });

  it('declares one group for every default builtin tool', () => {
    const toolsByGroup = Object.groupBy(builtinTools, (tool) => tool.group as BuiltinToolGroup);

    expect(
      Object.fromEntries(
        Object.entries(toolsByGroup).map(([group, tools]) => [group, toolNames(tools ?? [])]),
      ),
    ).toEqual({
      filesystem: ['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep'],
      shell: ['Bash', 'KillShell'],
      web: ['WebFetch', 'WebSearch'],
      task: [
        'Task',
        'TaskOutput',
        'TaskCreate',
        'TaskGet',
        'TaskUpdate',
        'TaskList',
        'TaskStop',
        'TodoWrite',
      ],
      memory: ['MemoryRead', 'MemoryWrite'],
      system: ['EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'DiscoverTools', 'Skill'],
      'mcp-resources': ['ListMcpResources', 'ReadMcpResource'],
    });
  });

  it('declares an explicit interruption policy for every default builtin tool', () => {
    expect(
      Object.fromEntries(
        builtinTools.map((tool) => [tool.name, tool.staticBehavior.interruptBehavior]),
      ),
    ).toEqual({
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
      MemoryRead: 'block',
      MemoryWrite: 'block',
      EnterPlanMode: 'block',
      ExitPlanMode: 'block',
      AskUserQuestion: 'block',
      DiscoverTools: 'block',
      Skill: 'block',
      ListMcpResources: 'block',
      ReadMcpResource: 'block',
    });

    const bash = builtinTools.find((tool) => tool.name === 'Bash');
    expect(
      resolveBehavior(bash, {
        command: 'sleep 10',
        run_in_background: false,
      }),
    ).toMatchObject({ interruptBehavior: 'cancel' });
    expect(
      resolveBehavior(bash, {
        command: 'sleep 10',
        run_in_background: true,
      }),
    ).toMatchObject({ interruptBehavior: 'block' });
  });

  it('declares an explicit side-effect contract for every default builtin tool', () => {
    expect(
      Object.fromEntries(builtinTools.map((tool) => [tool.name, tool.staticBehavior.sideEffect])),
    ).toEqual({
      Read: 'pure',
      Edit: 'non_idempotent',
      Write: 'idempotent',
      NotebookEdit: 'idempotent',
      Glob: 'pure',
      Grep: 'pure',
      Bash: 'non_idempotent',
      KillShell: 'idempotent',
      WebFetch: 'pure',
      WebSearch: 'pure',
      Task: 'non_idempotent',
      TaskOutput: 'non_idempotent',
      TaskCreate: 'non_idempotent',
      TaskGet: 'pure',
      TaskUpdate: 'idempotent',
      TaskList: 'pure',
      TaskStop: 'idempotent',
      TodoWrite: 'idempotent',
      MemoryRead: 'pure',
      MemoryWrite: 'idempotent',
      EnterPlanMode: 'non_idempotent',
      ExitPlanMode: 'non_idempotent',
      AskUserQuestion: 'non_idempotent',
      DiscoverTools: 'idempotent',
      Skill: 'non_idempotent',
      ListMcpResources: 'pure',
      ReadMcpResource: 'pure',
    });

    const bash = builtinTools.find((tool) => tool.name === 'Bash');
    expect(
      resolveBehavior(bash, {
        command: 'git status',
        run_in_background: false,
      }),
    ).toMatchObject({ sideEffect: 'pure' });
    expect(
      resolveBehavior(bash, {
        command: 'git commit -m test',
        run_in_background: false,
      }),
    ).toMatchObject({ sideEffect: 'non_idempotent' });

    const webFetch = builtinTools.find((tool) => tool.name === 'WebFetch');
    expect(resolveBehavior(webFetch, { url: 'https://example.com', method: 'GET' })).toMatchObject({
      sideEffect: 'pure',
    });
    expect(resolveBehavior(webFetch, { url: 'https://example.com', method: 'PUT' })).toMatchObject({
      sideEffect: 'idempotent',
    });
    expect(resolveBehavior(webFetch, { url: 'https://example.com', method: 'POST' })).toMatchObject(
      { sideEffect: 'non_idempotent' },
    );
  });
});
