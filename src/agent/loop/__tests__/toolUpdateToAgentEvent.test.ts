import { describe, expect, it } from 'vitest';
import type { ModelToolCall } from '../../../model/message.js';
import type { ToolRegistry } from '../../../tools/registry/ToolRegistry.js';
import { toolUpdateToAgentEvent } from '../toolUpdateToAgentEvent.js';

const toolCall: ModelToolCall = {
  id: 'tc-1',
  type: 'function',
  function: { name: 'Read', arguments: '{}' },
};

const registry = {
  get: (name: string) => (name === 'Read' ? { kind: 'readonly' as const } : undefined),
} as unknown as ToolRegistry;

describe('toolUpdateToAgentEvent', () => {
  it('maps tool_ready to tool_start with kind from registry', () => {
    const event = toolUpdateToAgentEvent({ type: 'tool_ready', toolCall }, registry);
    expect(event).toEqual({ type: 'tool_start', toolCall, toolKind: 'readonly' });
  });

  it('maps tool_ready for unknown tool to tool_start with undefined kind', () => {
    const unknown: ModelToolCall = {
      ...toolCall,
      function: { ...toolCall.function, name: 'Unknown' },
    };
    const event = toolUpdateToAgentEvent({ type: 'tool_ready', toolCall: unknown }, registry);
    expect(event).toEqual({ type: 'tool_start', toolCall: unknown, toolKind: undefined });
  });

  it('maps tool_result', () => {
    const result = { status: 'success' as const, model: 'ok' };
    const event = toolUpdateToAgentEvent(
      { type: 'tool_result', outcome: { toolCall, result, effects: [], toolMessageId: null } },
      registry,
    );
    expect(event).toEqual({ type: 'tool_result', toolCall, result });
  });

  it('maps tool_progress / tool_message', () => {
    expect(
      toolUpdateToAgentEvent(
        {
          type: 'tool_progress',
          toolCall,
          progress: { kind: 'progress', message: 'p', completed: 1, total: 2 },
        },
        registry,
      ),
    ).toEqual({
      type: 'tool_progress',
      toolCall,
      progress: { kind: 'progress', message: 'p', completed: 1, total: 2 },
    });
    expect(
      toolUpdateToAgentEvent(
        {
          type: 'tool_message',
          toolCall,
          content: { summary: 'm' },
        },
        registry,
      ),
    ).toEqual({ type: 'tool_message', toolCall, content: { summary: 'm' } });
  });

  it('returns null for internal-only updates', () => {
    expect(
      toolUpdateToAgentEvent(
        { type: 'tool_started', toolCall, params: {}, toolMessageId: null },
        registry,
      ),
    ).toBeNull();
    expect(
      toolUpdateToAgentEvent(
        {
          type: 'tool_completed',
          outcome: {
            toolCall,
            result: { status: 'success' as const, model: '' },
            effects: [],
            toolMessageId: null,
          },
        },
        registry,
      ),
    ).toBeNull();
  });
});
