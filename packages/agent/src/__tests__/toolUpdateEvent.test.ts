import { describe, expect, it } from 'vitest';
import {
  type AgentFunctionToolCall,
  toolUpdateToAgentEvent,
  ToolKind,
} from '../loop/index.js';

const toolCall: AgentFunctionToolCall = {
  id: 'read-1',
  type: 'function',
  function: {
    name: 'Read',
    arguments: '{}',
  },
};

const registry = {
  get: (name: string) =>
    name === 'Read' ? { kind: ToolKind.ReadOnly } : undefined,
};

describe('toolUpdateToAgentEvent', () => {
  it('maps tool_ready to a public tool_start event with registry kind', () => {
    expect(toolUpdateToAgentEvent({ type: 'tool_ready', toolCall }, registry)).toEqual({
      type: 'tool_start',
      toolCall,
      toolKind: ToolKind.ReadOnly,
    });
  });

  it('maps result and streaming status updates', () => {
    const result = { success: true, llmContent: 'ok' };

    expect(
      toolUpdateToAgentEvent(
        { type: 'tool_result', outcome: { toolCall, result, toolUseUuid: null } },
        registry,
      ),
    ).toEqual({ type: 'tool_result', toolCall, result });
    expect(
      toolUpdateToAgentEvent({ type: 'tool_progress', toolCall, message: 'reading' }, registry),
    ).toEqual({ type: 'tool_progress', toolCall, message: 'reading' });
    expect(
      toolUpdateToAgentEvent({ type: 'tool_message', toolCall, message: 'chunk' }, registry),
    ).toEqual({ type: 'tool_message', toolCall, message: 'chunk' });
  });

  it('maps side-effect updates without executing them', () => {
    expect(
      toolUpdateToAgentEvent(
        { type: 'tool_runtime_patch', toolCall, patch: { cwd: '/tmp/project' } },
        registry,
      ),
    ).toEqual({ type: 'tool_runtime_patch', toolCall, patch: { cwd: '/tmp/project' } });
    expect(
      toolUpdateToAgentEvent(
        { type: 'tool_permission_updates', toolCall, updates: [{ type: 'removeRules', rules: [] }] },
        registry,
      ),
    ).toEqual({
      type: 'tool_permission_updates',
      toolCall,
      updates: [{ type: 'removeRules', rules: [] }],
    });
  });

  it('hides internal-only started and completed updates', () => {
    const result = { success: true, llmContent: '' };

    expect(
      toolUpdateToAgentEvent(
        { type: 'tool_started', toolCall, params: {}, toolUseUuid: null },
        registry,
      ),
    ).toBeNull();
    expect(
      toolUpdateToAgentEvent(
        { type: 'tool_completed', outcome: { toolCall, result, toolUseUuid: null } },
        registry,
      ),
    ).toBeNull();
  });
});
