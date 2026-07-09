import { describe, expect, it } from 'vitest';
import {
  applyAgentLoopToolResultContinuation,
  buildAgentLoopAfterExecHookPayload,
  buildAgentLoopToolResultAppendMessages,
  buildAgentLoopToolResultContinuation,
  handleAgentLoopToolResult,
  runAgentLoopToolResultAfterExecHook,
} from '../loop/index.js';

const toolCall = {
  id: 'call_read',
  type: 'function' as const,
  function: { name: 'Read', arguments: '{"file":"README.md"}' },
};

async function collectGenerator<TEvent, TResult>(
  generator: AsyncGenerator<TEvent, TResult>,
): Promise<{ events: TEvent[]; result: TResult }> {
  const events: TEvent[] = [];

  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

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

  it('handles continuing tool results with event-before-hook-before-append ordering', async () => {
    const operations: unknown[] = [];
    const result = {
      success: true,
      llmContent: 'done',
      newMessages: [{ role: 'system' as const, content: 'fresh context' }],
    };

    const handled = await collectGenerator(
      handleAgentLoopToolResult({
        toolCall,
        result,
        toolUseUuid: 'tool-use-1',
        streamingExecutionResults: undefined,
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => {
            operations.push({ type: 'timing', turnsCount, toolCallsCount });
            return {
              turnsCount,
              toolCallsCount,
              startTime: 1000,
              now: 1040,
            };
          },
        },
        turnsCount: 3,
        toolResultTracker: {
          toolCallsCount: 0,
          recentToolResults: [],
          record(recordedResult) {
            operations.push({ type: 'record', result: recordedResult });
          },
        },
        conversation: {
          append: (...messages) => {
            operations.push({ type: 'append', messages });
          },
        },
        hooks: {
          tool: {
            afterExec: async (payload) => {
              operations.push({ type: 'hook', payload });
            },
          },
        },
      }),
    );

    expect(handled.events).toEqual([{ type: 'tool_result', toolCall, result }]);
    expect(handled.result.action).toBe('continue');
    if (handled.result.action === 'continue') {
      expect(handled.result.continuation.toolMessage).toEqual({
        role: 'tool',
        tool_call_id: 'call_read',
        name: 'Read',
        content: 'done',
      });
    }
    expect(operations).toEqual([
      { type: 'record', result },
      { type: 'timing', turnsCount: 3, toolCallsCount: 0 },
      {
        type: 'hook',
        payload: {
          toolCall,
          result,
          toolUseUuid: 'tool-use-1',
        },
      },
      {
        type: 'append',
        messages: [
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
        ],
      },
    ]);
  });

  it('handles exit tool results without continuation hooks or appends', async () => {
    const operations: unknown[] = [];
    const result = {
      success: true,
      llmContent: 'leaving plan mode',
      metadata: {
        shouldExitLoop: true,
        targetMode: 'default',
      },
    };

    const handled = await collectGenerator(
      handleAgentLoopToolResult({
        toolCall,
        result,
        toolUseUuid: null,
        streamingExecutionResults: undefined,
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => {
            operations.push({ type: 'timing', turnsCount, toolCallsCount });
            return {
              turnsCount,
              toolCallsCount,
              startTime: 2000,
              now: 2050,
            };
          },
        },
        turnsCount: 4,
        toolResultTracker: {
          toolCallsCount: 1,
          recentToolResults: [],
          record(recordedResult) {
            operations.push({ type: 'record', result: recordedResult });
          },
        },
        conversation: {
          append: (...messages) => {
            operations.push({ type: 'append', messages });
          },
        },
        hooks: {
          tool: {
            afterExec: async (payload) => {
              operations.push({ type: 'hook', payload });
            },
          },
        },
      }),
    );

    expect(handled.events).toEqual([
      { type: 'tool_result', toolCall, result },
      { type: 'turn_end', turn: 4, hasToolCalls: true },
      { type: 'agent_end' },
    ]);
    expect(handled.result).toEqual({
      action: 'exit',
      exitDecision: {
        action: 'exit',
        events: handled.events,
        result: {
          success: true,
          finalMessage: 'leaving plan mode',
          metadata: {
            turnsCount: 4,
            toolCallsCount: 1,
            duration: 50,
            shouldExitLoop: true,
            targetMode: 'default',
          },
        },
      },
    });
    expect(operations).toEqual([
      { type: 'record', result },
      { type: 'timing', turnsCount: 4, toolCallsCount: 1 },
    ]);
  });
});
