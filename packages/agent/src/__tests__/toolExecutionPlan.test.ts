import { describe, expect, it } from 'vitest';
import {
  type AgentFunctionToolCall,
  planToolExecution,
  selectAgentFunctionToolCalls,
  type ToolBehavior,
  ToolKind,
} from '../loop/index.js';

const makeCall = (
  name: string,
  args: Record<string, unknown> = {},
): AgentFunctionToolCall => ({
  id: `${name}-call`,
  type: 'function',
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});

const registry = {
  get(name: string) {
    const tools = new Map<
      string,
      {
        kind?: ToolKind;
        isConcurrencySafe?: boolean;
        resolveBehavior?: (params: Record<string, unknown>) => Partial<ToolBehavior>;
      }
    >([
      ['Read', { kind: ToolKind.ReadOnly }],
      ['Glob', { kind: ToolKind.ReadOnly }],
      ['Edit', { kind: ToolKind.Write }],
      [
        'Bash',
        {
          kind: ToolKind.Execute,
          resolveBehavior: (params) => {
            const command = typeof params.command === 'string' ? params.command : '';
            const isReadOnly = command.startsWith('ls');
            return {
              kind: isReadOnly ? ToolKind.ReadOnly : ToolKind.Execute,
              isReadOnly,
              isConcurrencySafe: isReadOnly,
              isDestructive: !isReadOnly,
            };
          },
        },
      ],
    ]);

    return tools.get(name);
  },
};

describe('planToolExecution', () => {
  it('selects only executable function tool calls before planning', () => {
    const functionCall = makeCall('Read');

    expect(
      selectAgentFunctionToolCalls([
        functionCall,
        { id: 'custom-call', type: 'custom', function: { name: 'Nope', arguments: '{}' } },
        { id: 'missing-function', type: 'function' },
        { id: 'bad-args', type: 'function', function: { name: 'Read', arguments: 12 } },
      ]),
    ).toEqual([functionCall]);
  });

  it('groups readonly calls for parallel execution before serial mutating calls', () => {
    const plan = planToolExecution(
      [
        makeCall('Edit'),
        makeCall('Read'),
        makeCall('Bash', { command: 'npm install' }),
        makeCall('Glob'),
      ],
      registry,
    );

    expect(plan.mode).toBe('mixed');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read', 'Glob', 'Edit', 'Bash']);
    expect(plan.groups?.map((group) => group.map((call) => call.function.name))).toEqual([
      ['Read', 'Glob'],
      ['Edit'],
      ['Bash'],
    ]);
  });

  it('keeps all calls serial in plan permission mode', () => {
    const plan = planToolExecution(
      [makeCall('Read'), makeCall('Glob')],
      registry,
      'plan',
    );

    expect(plan).toEqual({
      mode: 'serial',
      calls: [makeCall('Read'), makeCall('Glob')],
    });
  });

  it('classifies the same tool from parsed call arguments', () => {
    const plan = planToolExecution(
      [
        makeCall('Bash', { command: 'ls -la' }),
        makeCall('Bash', { command: 'npm install' }),
        makeCall('Read'),
      ],
      registry,
    );

    expect(plan.mode).toBe('mixed');
    expect(plan.calls.map((call) => `${call.function.name}:${call.function.arguments}`)).toEqual([
      'Bash:{"command":"ls -la"}',
      'Read:{}',
      'Bash:{"command":"npm install"}',
    ]);
  });
});
