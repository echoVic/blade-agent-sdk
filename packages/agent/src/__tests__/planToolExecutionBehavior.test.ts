import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopExecuteToolCallsHooksInput,
  buildAgentLoopExecuteToolCallsHooksInputFromHookContainer,
  type AgentFunctionToolCall,
  buildAgentLoopExecuteToolCallsInput,
  buildAgentLoopExecuteToolCallsInputFromTurnProjection,
  buildAgentLoopToolExecutionPlanInput,
  buildAgentLoopToolExecutionPlanInputFromExecutionPipelineProjection,
  buildAgentLoopToolExecutionPlanInputFromTurnProjection,
  planAgentLoopToolExecution,
  planToolExecution,
  prepareAgentLoopNonStreamingToolExecution,
  shouldEmitAgentLoopNonStreamingToolResultEffects,
  shouldRunAgentLoopNonStreamingToolExecution,
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

const toolKinds = new Map<
  string,
  {
    kind?: string;
    resolveBehavior?: (params: Record<string, unknown>) => ToolBehavior;
  }
>([
  ['Read', { kind: 'readonly' }],
  ['Glob', { kind: 'readonly' }],
  ['Grep', { kind: 'readonly' }],
  ['Edit', { kind: 'write' }],
  ['Write', { kind: 'write' }],
  [
    'Bash',
    {
      kind: 'execute',
      resolveBehavior: (params) => {
        const command = typeof params.command === 'string' ? params.command : '';
        const isReadOnly = command.startsWith('ls') || command.startsWith('git status');
        return {
          kind: isReadOnly ? ToolKind.ReadOnly : ToolKind.Execute,
          isReadOnly,
          isConcurrencySafe: isReadOnly,
          isDestructive: !isReadOnly,
          interruptBehavior: 'cancel',
        };
      },
    },
  ],
]);

const mockRegistry = {
  get(
    name: string
  ):
    | {
        kind?: string;
        resolveBehavior?: (params: Record<string, unknown>) => ToolBehavior;
      }
    | undefined {
    return toolKinds.get(name);
  },
};

describe('planToolExecution', () => {
  it('returns serial mode for a single call', () => {
    const plan = planToolExecution([makeCall('Read')], mockRegistry);

    expect(plan.mode).toBe('serial');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read']);
    expect(plan.groups).toBeUndefined();
  });

  it('returns serial mode in plan permission mode', () => {
    const plan = planToolExecution(
      [makeCall('Read'), makeCall('Glob')],
      mockRegistry,
      'plan',
    );

    expect(plan.mode).toBe('serial');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read', 'Glob']);
    expect(plan.groups).toBeUndefined();
  });

  it('projects object-style tool execution planning input and runs the planning wrapper', () => {
    const calls = [makeCall('Read'), makeCall('Edit')];

    const input = buildAgentLoopToolExecutionPlanInput({
      calls,
      registry: mockRegistry,
      permissionMode: 'default',
    });

    expect(input).toEqual({
      calls,
      registry: mockRegistry,
      permissionMode: 'default',
    });
    expect(planAgentLoopToolExecution(input)).toEqual(
      planToolExecution(calls, mockRegistry, 'default'),
    );
  });

  it('projects tool execution planning input from a turn state projection', () => {
    const calls = [makeCall('Read'), makeCall('Edit')];
    const turnState = {
      maxContextTokens: 128000,
      executionContext: { cwd: '/tmp/project' },
      permissionMode: 'plan' as const,
    };

    const input = buildAgentLoopToolExecutionPlanInputFromTurnProjection({
      calls,
      registry: mockRegistry,
      turnStateProjection: {
        turnState,
        maxContextTokens: turnState.maxContextTokens,
        executionContext: turnState.executionContext,
        permissionMode: turnState.permissionMode,
      },
    });

    expect(input).toEqual({
      calls,
      registry: mockRegistry,
      permissionMode: 'plan',
    });
    expect(planAgentLoopToolExecution(input)).toEqual(
      planToolExecution(calls, mockRegistry, 'plan'),
    );
  });

  it('projects tool execution planning input from execution pipeline and turn state projection', () => {
    const calls = [makeCall('Read'), makeCall('Edit')];
    const turnState = {
      maxContextTokens: 128000,
      executionContext: { cwd: '/tmp/project' },
      permissionMode: 'autoEdit' as const,
    };
    const executionPipeline = {
      getRegistry: () => mockRegistry,
    };

    const input = buildAgentLoopToolExecutionPlanInputFromExecutionPipelineProjection({
      calls,
      executionPipeline,
      turnStateProjection: {
        turnState,
        maxContextTokens: turnState.maxContextTokens,
        executionContext: turnState.executionContext,
        permissionMode: turnState.permissionMode,
      },
    });

    expect(input).toEqual({
      calls,
      registry: mockRegistry,
      permissionMode: 'autoEdit',
    });
    expect(planAgentLoopToolExecution(input)).toEqual(
      planToolExecution(calls, mockRegistry, 'autoEdit'),
    );
  });

  it('returns parallel mode for all readonly calls', () => {
    const plan = planToolExecution(
      [makeCall('Read'), makeCall('Glob'), makeCall('Grep')],
      mockRegistry,
    );

    expect(plan.mode).toBe('parallel');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read', 'Glob', 'Grep']);
    expect(plan.groups).toBeUndefined();
  });

  it('returns serial mode for all write calls', () => {
    const plan = planToolExecution(
      [makeCall('Edit'), makeCall('Write'), makeCall('Bash')],
      mockRegistry,
    );

    expect(plan.mode).toBe('serial');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Edit', 'Write', 'Bash']);
    expect(plan.groups).toBeUndefined();
  });

  it('returns mixed mode with readonly calls grouped first', () => {
    const plan = planToolExecution(
      [
        makeCall('Edit'),
        makeCall('Read'),
        makeCall('Bash', { command: 'npm install' }),
        makeCall('Glob'),
      ],
      mockRegistry,
    );

    expect(plan.mode).toBe('mixed');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read', 'Glob', 'Edit', 'Bash']);
    expect(plan.groups?.map((group) => group.map((call) => call.function.name))).toEqual([
      ['Read', 'Glob'],
      ['Edit'],
      ['Bash'],
    ]);
  });

  it('treats unknown tools as non-readonly', () => {
    const plan = planToolExecution(
      [makeCall('Read'), makeCall('Unknown')],
      mockRegistry,
    );

    expect(plan.mode).toBe('mixed');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read', 'Unknown']);
    expect(plan.groups?.map((group) => group.map((call) => call.function.name))).toEqual([
      ['Read'],
      ['Unknown'],
    ]);
  });

  it('classifies the same tool differently based on call arguments', () => {
    const plan = planToolExecution(
      [
        makeCall('Bash', { command: 'ls -la' }),
        makeCall('Bash', { command: 'npm install' }),
        makeCall('Read'),
      ],
      mockRegistry,
    );

    expect(plan.mode).toBe('mixed');
    expect(plan.calls.map((call) => `${call.function.name}:${call.function.arguments}`)).toEqual([
      'Bash:{"command":"ls -la"}',
      'Read:{}',
      'Bash:{"command":"npm install"}',
    ]);
    expect(plan.groups?.map((group) => group.map((call) => call.function.arguments))).toEqual([
      ['{"command":"ls -la"}', '{}'],
      ['{"command":"npm install"}'],
    ]);
  });

  it('runs non-streaming tool execution only when streaming results are absent', () => {
    expect(shouldRunAgentLoopNonStreamingToolExecution(undefined)).toBe(true);
    expect(shouldRunAgentLoopNonStreamingToolExecution([])).toBe(false);
    expect(
      shouldRunAgentLoopNonStreamingToolExecution([
        {
          toolCall: makeCall('Read'),
          result: { success: true, llmContent: 'ok' },
          toolUseUuid: null,
        },
      ]),
    ).toBe(false);
  });

  it('emits tool result effects only when streaming execution results are absent', () => {
    expect(shouldEmitAgentLoopNonStreamingToolResultEffects(undefined)).toBe(true);
    expect(shouldEmitAgentLoopNonStreamingToolResultEffects([])).toBe(false);
    expect(
      shouldEmitAgentLoopNonStreamingToolResultEffects([
        {
          toolCall: makeCall('Read'),
          result: { success: true, llmContent: 'ok' },
          toolUseUuid: null,
        },
      ]),
    ).toBe(false);
  });

  it('prepares non-streaming tool execution plan, start events, and execute input together', () => {
    const operations: string[] = [];
    const readCall = makeCall('Read');
    const editCall = makeCall('Edit');
    const ignoredCall = {
      id: 'text-call',
      type: 'text',
      function: { name: 'Ignored', arguments: '{}' },
    };
    const executionPipeline = {
      getRegistry: () => {
        operations.push('getRegistry');
        return mockRegistry;
      },
      name: 'pipeline',
    };
    const turnState = {
      maxContextTokens: 128000,
      executionContext: { cwd: '/tmp/project' },
      permissionMode: 'autoEdit' as const,
    };
    const logger = { debug: () => undefined };
    const signal = new AbortController().signal;
    const beforeExec = async () => null;
    const onUpdate = () => undefined;

    const preparation = prepareAgentLoopNonStreamingToolExecution({
      executionResults: undefined,
      response: {
        toolCalls: [editCall, ignoredCall, readCall],
      },
      executionPipeline,
      turnStateProjection: {
        turnState,
        maxContextTokens: turnState.maxContextTokens,
        executionContext: turnState.executionContext,
        permissionMode: turnState.permissionMode,
      },
      logger,
      signal,
      hooks: {
        tool: {
          beforeExec,
          onUpdate,
        },
      },
    });

    expect(preparation).toEqual({
      action: 'execute',
      functionCalls: [editCall, readCall],
      executionPlan: {
        mode: 'mixed',
        calls: [readCall, editCall],
        groups: [[readCall], [editCall]],
      },
      events: [
        { type: 'tool_start', toolCall: readCall, toolKind: ToolKind.ReadOnly },
        { type: 'tool_start', toolCall: editCall, toolKind: ToolKind.Write },
      ],
      executeInput: {
        plan: {
          mode: 'mixed',
          calls: [readCall, editCall],
          groups: [[readCall], [editCall]],
        },
        executionPipeline,
        executionContext: turnState.executionContext,
        logger,
        permissionMode: turnState.permissionMode,
        signal,
        hooks: {
          onBeforeToolExec: beforeExec,
          onUpdate,
        },
      },
    });
    expect(operations).toEqual(['getRegistry', 'getRegistry']);
  });

  it('skips non-streaming preparation when streaming execution already produced results', () => {
    const streamingExecutionResults = [
      {
        toolCall: makeCall('Read'),
        result: { success: true, llmContent: 'ok' },
        toolUseUuid: null,
      },
    ];

    const preparation = prepareAgentLoopNonStreamingToolExecution({
      executionResults: streamingExecutionResults,
      response: {
        toolCalls: [makeCall('Edit')],
      },
      executionPipeline: {
        getRegistry: () => {
          throw new Error('registry should not be read for streaming results');
        },
      },
      turnStateProjection: {
        turnState: {
          maxContextTokens: 128000,
          executionContext: { cwd: '/tmp/project' },
          permissionMode: 'default' as const,
        },
        maxContextTokens: 128000,
        executionContext: { cwd: '/tmp/project' },
        permissionMode: 'default' as const,
      },
    });

    expect(preparation).toEqual({
      action: 'skip',
      executionResults: streamingExecutionResults,
    });
  });

  it('projects non-streaming tool execution input without owning execution side effects', () => {
    const plan = planToolExecution([makeCall('Read')], mockRegistry);
    const executionPipeline = { name: 'pipeline' };
    const executionContext = { cwd: '/tmp/project' };
    const logger = { debug: () => undefined };
    const signal = new AbortController().signal;
    const hooks = {
      onBeforeToolExec: async () => null,
      onUpdate: () => undefined,
    };

    expect(
      buildAgentLoopExecuteToolCallsInput({
        plan,
        executionPipeline,
        executionContext,
        logger,
        permissionMode: 'default',
        signal,
        hooks,
      }),
    ).toEqual({
      plan,
      executionPipeline,
      executionContext,
      logger,
      permissionMode: 'default',
      signal,
      hooks,
    });
  });

  it('projects non-streaming tool execution input from a turn state projection', () => {
    const plan = planToolExecution([makeCall('Read')], mockRegistry);
    const executionPipeline = { name: 'pipeline' };
    const turnState = {
      maxContextTokens: 128000,
      executionContext: { cwd: '/tmp/project' },
      permissionMode: 'default' as const,
    };
    const logger = { debug: () => undefined };
    const signal = new AbortController().signal;
    const beforeExec = async () => null;
    const onUpdate = () => undefined;

    expect(
      buildAgentLoopExecuteToolCallsInputFromTurnProjection({
        plan,
        executionPipeline,
        turnStateProjection: {
          turnState,
          maxContextTokens: turnState.maxContextTokens,
          executionContext: turnState.executionContext,
          permissionMode: turnState.permissionMode,
        },
        logger,
        signal,
        hookContainer: {
          tool: {
            beforeExec,
            onUpdate,
          },
        },
      }),
    ).toEqual({
      plan,
      executionPipeline,
      executionContext: turnState.executionContext,
      logger,
      permissionMode: turnState.permissionMode,
      signal,
      hooks: {
        onBeforeToolExec: beforeExec,
        onUpdate,
      },
    });
  });

  it('projects non-streaming tool execution hooks from session hook names', () => {
    const beforeExec = async () => null;
    const onUpdate = () => undefined;

    expect(
      buildAgentLoopExecuteToolCallsHooksInput({
        beforeExec,
        onUpdate,
      }),
    ).toEqual({
      onBeforeToolExec: beforeExec,
      onUpdate,
    });
  });

  it('projects non-streaming tool execution hooks from a session hook container', () => {
    const beforeExec = async () => null;
    const onUpdate = () => undefined;

    expect(
      buildAgentLoopExecuteToolCallsHooksInputFromHookContainer({
        hooks: {
          tool: {
            beforeExec,
            onUpdate,
          },
        },
      }),
    ).toEqual({
      onBeforeToolExec: beforeExec,
      onUpdate,
    });
  });
});
