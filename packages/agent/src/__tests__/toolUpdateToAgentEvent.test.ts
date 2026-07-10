import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentFunctionToolCall } from '../loop/planToolExecution.js';
import type { ToolExecutionRegistryLike } from '../loop/toolBehavior.js';
import {
  buildAgentLoopToolResultEvent,
  toolUpdateToAgentEvent,
} from '../loop/toolUpdateToAgentEvent.js';

const toolCall: AgentFunctionToolCall = {
  id: 'tc-1',
  type: 'function',
  function: { name: 'Read', arguments: '{}' },
};

const registry = {
  get: (name: string) =>
    name === 'Read' ? { kind: 'readonly' as const } : undefined,
} satisfies ToolExecutionRegistryLike;

describe('toolUpdateToAgentEvent', () => {
  it('maps tool_ready to tool_start with kind from registry', () => {
    const event = toolUpdateToAgentEvent({ type: 'tool_ready', toolCall }, registry);
    expect(event).toEqual({ type: 'tool_start', toolCall, toolKind: 'readonly' });
  });

  it('maps tool_ready for unknown tool to tool_start with undefined kind', () => {
    const unknown: AgentFunctionToolCall = {
      ...toolCall,
      function: { ...toolCall.function, name: 'Unknown' },
    };
    const event = toolUpdateToAgentEvent({ type: 'tool_ready', toolCall: unknown }, registry);
    expect(event).toEqual({ type: 'tool_start', toolCall: unknown, toolKind: undefined });
  });

  it('maps tool_result', () => {
    const result = { success: true as const, llmContent: 'ok' };
    const event = toolUpdateToAgentEvent(
      { type: 'tool_result', outcome: { toolCall, result, toolUseUuid: null } },
      registry,
    );
    expect(event).toEqual({ type: 'tool_result', toolCall, result });
  });

  it('wraps non-streaming tool outcomes as public tool_result events', () => {
    const result = { success: true as const, llmContent: 'ok' };

    expect(buildAgentLoopToolResultEvent({ toolCall, result })).toEqual({
      type: 'tool_result',
      toolCall,
      result,
    });
  });

  it('keeps the explicit generic parameter result-first', () => {
    const result = { success: true as const, llmContent: 'typed' };
    const event = buildAgentLoopToolResultEvent<typeof result>({
      toolCall,
      result,
    });

    expectTypeOf(event.result).toEqualTypeOf<typeof result>();
  });

  it('maps tool_progress / tool_message', () => {
    expect(
      toolUpdateToAgentEvent({ type: 'tool_progress', toolCall, message: 'p' }, registry),
    ).toEqual({ type: 'tool_progress', toolCall, message: 'p' });
    expect(
      toolUpdateToAgentEvent({ type: 'tool_message', toolCall, message: 'm' }, registry),
    ).toEqual({ type: 'tool_message', toolCall, message: 'm' });
  });

  it('returns null for internal-only updates', () => {
    expect(
      toolUpdateToAgentEvent(
        { type: 'tool_started', toolCall, params: {}, toolUseUuid: null },
        registry,
      ),
    ).toBeNull();
    expect(
      toolUpdateToAgentEvent(
        { type: 'tool_completed', outcome: { toolCall, result: { success: true as const, llmContent: '' }, toolUseUuid: null } },
        registry,
      ),
    ).toBeNull();
  });
});
