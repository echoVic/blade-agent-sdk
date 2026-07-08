import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopAfterExecHookPayload,
  buildAgentLoopToolResultContinuation,
} from '../loop/index.js';

const toolCall = {
  id: 'call_read',
  type: 'function' as const,
  function: { name: 'Read', arguments: '{"file":"README.md"}' },
};

describe('agent loop tool result continuation projection', () => {
  it('projects non-streaming tool results into result effects and storage messages', () => {
    const result = {
      success: true,
      llmContent: { ok: true },
      newMessages: [
        { role: 'system' as const, content: 'tool context' },
        { role: 'user' as const, content: 'follow-up' },
      ],
    };

    expect(
      buildAgentLoopToolResultContinuation({
        toolCall,
        result,
        streamingExecutionResults: undefined,
      }),
    ).toEqual({
      events: [{ type: 'tool_result', toolCall, result }],
      shouldRunAfterExecHook: true,
      toolMessage: {
        role: 'tool',
        tool_call_id: 'call_read',
        name: 'Read',
        content: '{\n  "ok": true\n}',
      },
      injectedMessages: [
        {
          role: 'system',
          content: 'tool context',
          metadata: { _systemSource: 'tool_injection' },
        },
        { role: 'user', content: 'follow-up' },
      ],
    });
  });

  it('suppresses duplicate result effects when streaming execution already emitted them', () => {
    const result = {
      success: false,
      error: { message: 'permission denied' },
    };

    expect(
      buildAgentLoopToolResultContinuation({
        toolCall,
        result,
        streamingExecutionResults: [{ toolCall, result, toolUseUuid: null }],
      }),
    ).toEqual({
      events: [],
      shouldRunAfterExecHook: false,
      toolMessage: {
        role: 'tool',
        tool_call_id: 'call_read',
        name: 'Read',
        content: 'permission denied',
      },
      injectedMessages: [],
    });
  });

  it('projects after-exec hook payloads from tool execution results', () => {
    const result = {
      success: true,
      llmContent: 'done',
    };

    expect(
      buildAgentLoopAfterExecHookPayload({
        toolCall,
        result,
        toolUseUuid: null,
      }),
    ).toEqual({
      toolCall,
      result,
      toolUseUuid: null,
    });
  });
});
