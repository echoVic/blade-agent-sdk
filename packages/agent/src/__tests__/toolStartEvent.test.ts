import { describe, expect, it } from 'vitest';
import type { AgentFunctionToolCall, ToolExecutionPlan } from '../loop/planToolExecution.js';
import type { ToolExecutionRegistryLike } from '../loop/toolBehavior.js';
import {
  buildAgentLoopToolStartEventsInputFromExecutionPipeline,
  buildAgentLoopToolStartEventsInput,
  buildAgentLoopToolStartEvent,
  buildAgentLoopToolStartEvents,
} from '../loop/toolStartEvent.js';

const toolCall: AgentFunctionToolCall = {
  id: 'call_read',
  type: 'function',
  function: { name: 'Read', arguments: '{"file":"README.md"}' },
};

describe('agent loop tool start event projection', () => {
  it('builds a tool_start event with the kind from the registry', () => {
    const registry = {
      get: (name: string) =>
        name === 'Read' ? { kind: 'readonly' as const } : undefined,
    } satisfies ToolExecutionRegistryLike;

    expect(buildAgentLoopToolStartEvent({ toolCall, registry })).toEqual({
      type: 'tool_start',
      toolCall,
      toolKind: 'readonly',
    });
  });

  it('preserves unknown tool kind as undefined', () => {
    const registry = {
      get: () => undefined,
    } satisfies ToolExecutionRegistryLike;

    expect(buildAgentLoopToolStartEvent({ toolCall, registry })).toEqual({
      type: 'tool_start',
      toolCall,
      toolKind: undefined,
    });
  });

  it('normalizes custom registry kinds to undefined for the public agent event', () => {
    const registry = {
      get: () => ({ kind: 'custom-kind' }),
    } satisfies ToolExecutionRegistryLike;

    expect(buildAgentLoopToolStartEvent({ toolCall, registry })).toEqual({
      type: 'tool_start',
      toolCall,
      toolKind: undefined,
    });
  });

  it('builds planned tool_start events for every execution-plan call', () => {
    const writeCall: AgentFunctionToolCall = {
      id: 'call_write',
      type: 'function',
      function: { name: 'Write', arguments: '{"file":"README.md"}' },
    };
    const plan: ToolExecutionPlan = {
      mode: 'mixed',
      calls: [toolCall, writeCall],
    };
    const registry = {
      get: (name: string) => {
        if (name === 'Read') return { kind: 'readonly' as const };
        if (name === 'Write') return { kind: 'write' as const };
        return undefined;
      },
    } satisfies ToolExecutionRegistryLike;

    expect(buildAgentLoopToolStartEvents({ plan, registry })).toEqual([
      {
        type: 'tool_start',
        toolCall,
        toolKind: 'readonly',
      },
      {
        type: 'tool_start',
        toolCall: writeCall,
        toolKind: 'write',
      },
    ]);
  });

  it('projects planned tool_start event input without owning registry side effects', () => {
    const plan: ToolExecutionPlan = {
      mode: 'serial',
      calls: [toolCall],
    };
    const registry = {
      get: () => ({ kind: 'readonly' as const }),
    } satisfies ToolExecutionRegistryLike;

    expect(buildAgentLoopToolStartEventsInput({ plan, registry })).toEqual({
      plan,
      registry,
    });
  });

  it('projects planned tool_start event input from an execution pipeline', () => {
    const plan: ToolExecutionPlan = {
      mode: 'serial',
      calls: [toolCall],
    };
    const registry = {
      get: () => ({ kind: 'readonly' as const }),
    } satisfies ToolExecutionRegistryLike;
    const executionPipeline = {
      getRegistry: () => registry,
    };

    expect(
      buildAgentLoopToolStartEventsInputFromExecutionPipeline({
        plan,
        executionPipeline,
      }),
    ).toEqual({
      plan,
      registry,
    });
  });
});
