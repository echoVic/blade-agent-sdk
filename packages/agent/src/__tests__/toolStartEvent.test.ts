import { describe, expect, it } from 'vitest';
import type { AgentFunctionToolCall } from '../loop/planToolExecution.js';
import type { ToolExecutionRegistryLike } from '../loop/toolBehavior.js';
import { buildAgentLoopToolStartEvent } from '../loop/toolStartEvent.js';

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
});
