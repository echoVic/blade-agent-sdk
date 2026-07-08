import { describe, expect, it } from 'vitest';
import {
  applyAgentLoopToolResultContinuation,
  buildAgentLoopAfterExecHookPayload,
  buildAgentLoopToolResultAppendMessages,
  buildAgentLoopToolResultContinuation,
  runAgentLoopToolResultAfterExecHook,
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

  it('projects tool-result continuation messages in append order', () => {
    const continuation = buildAgentLoopToolResultContinuation({
      toolCall,
      result: {
        success: true,
        llmContent: 'done',
        newMessages: [{ role: 'system' as const, content: 'fresh context' }],
      },
      streamingExecutionResults: undefined,
    });

    expect(buildAgentLoopToolResultAppendMessages(continuation)).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_read',
        name: 'Read',
        content: 'done',
      },
      {
        role: 'system',
        content: 'fresh context',
        metadata: { _systemSource: 'tool_injection' },
      },
    ]);
  });

  it('applies tool-result continuation messages to conversation state', () => {
    const appendedMessages: unknown[] = [];
    const continuation = buildAgentLoopToolResultContinuation({
      toolCall,
      result: {
        success: true,
        llmContent: 'done',
        newMessages: [{ role: 'system' as const, content: 'fresh context' }],
      },
      streamingExecutionResults: undefined,
    });

    const applied = applyAgentLoopToolResultContinuation({
      conversation: {
        append: (...messages) => {
          appendedMessages.push(...messages);
        },
      },
      continuation,
    });

    expect(applied).toBe(continuation);
    expect(appendedMessages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_read',
        name: 'Read',
        content: 'done',
      },
      {
        role: 'system',
        content: 'fresh context',
        metadata: { _systemSource: 'tool_injection' },
      },
    ]);
  });

  it('runs after-exec hooks for non-streaming tool-result continuations', async () => {
    const calls: unknown[] = [];
    const result = {
      success: true,
      llmContent: 'done',
    };
    const continuation = buildAgentLoopToolResultContinuation({
      toolCall,
      result,
      streamingExecutionResults: undefined,
    });

    const applied = await runAgentLoopToolResultAfterExecHook({
      continuation,
      hooks: {
        tool: {
          afterExec: async (payload) => {
            calls.push(payload);
          },
        },
      },
      toolCall,
      result,
      toolUseUuid: 'tool-use-1',
    });

    expect(applied).toBe(continuation);
    expect(calls).toEqual([
      {
        toolCall,
        result,
        toolUseUuid: 'tool-use-1',
      },
    ]);
  });

  it('skips after-exec hooks when streaming execution already emitted effects', async () => {
    const calls: unknown[] = [];
    const result = {
      success: true,
      llmContent: 'done',
    };
    const continuation = buildAgentLoopToolResultContinuation({
      toolCall,
      result,
      streamingExecutionResults: [{ toolCall, result, toolUseUuid: null }],
    });

    await runAgentLoopToolResultAfterExecHook({
      continuation,
      hooks: {
        tool: {
          afterExec: async (payload) => {
            calls.push(payload);
          },
        },
      },
      toolCall,
      result,
      toolUseUuid: null,
    });

    expect(calls).toEqual([]);
  });
});
