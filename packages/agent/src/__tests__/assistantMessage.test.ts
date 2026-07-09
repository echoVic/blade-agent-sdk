import { describe, expect, it } from 'vitest';
import {
  assertAgentLoopTurnResponse,
  applyAgentLoopAssistantMessageProjection,
  buildAgentLoopAssistantMessageProjection,
  handleAgentLoopAssistantMessage,
  runAgentLoopAssistantMessageHook,
} from '../loop/assistantMessage.js';

describe('agent loop assistant message projection', () => {
  it('builds the stored assistant message and hook payload from a tool-call response', () => {
    const toolCalls = [
      {
        id: 'call_read',
        type: 'function' as const,
        function: { name: 'Read', arguments: '{"file":"README.md"}' },
      },
    ];

    expect(buildAgentLoopAssistantMessageProjection({
      response: {
        content: 'I will inspect the file.',
        reasoningContent: 'Need evidence first.',
        toolCalls,
      },
      turn: 3,
    })).toEqual({
      message: {
        role: 'assistant',
        content: 'I will inspect the file.',
        reasoningContent: 'Need evidence first.',
        tool_calls: toolCalls,
      },
      hookPayload: {
        content: 'I will inspect the file.',
        reasoningContent: 'Need evidence first.',
        toolCalls,
        turn: 3,
      },
    });
  });

  it('normalizes empty content and omits absent optional hook fields', () => {
    expect(buildAgentLoopAssistantMessageProjection({
      response: {
        content: '',
      },
      turn: 1,
    })).toEqual({
      message: {
        role: 'assistant',
        content: '',
      },
      hookPayload: {
        content: '',
        turn: 1,
      },
    });
  });

  it('applies an assistant message projection to conversation state', () => {
    const appendedMessages: unknown[] = [];
    const projection = buildAgentLoopAssistantMessageProjection({
      response: {
        content: 'I will inspect the file.',
        reasoningContent: 'Need evidence first.',
      },
      turn: 3,
    });

    const applied = applyAgentLoopAssistantMessageProjection({
      conversation: {
        append: (...messages) => {
          appendedMessages.push(...messages);
        },
      },
      projection,
    });

    expect(applied).toBe(projection);
    expect(appendedMessages).toEqual([projection.message]);
    expect(applied.hookPayload).toEqual({
      content: 'I will inspect the file.',
      reasoningContent: 'Need evidence first.',
      turn: 3,
    });
  });

  it('runs assistant message hooks from the session hook container', async () => {
    const calls: unknown[] = [];
    const projection = buildAgentLoopAssistantMessageProjection({
      response: {
        content: 'I will inspect the file.',
        reasoningContent: 'Need evidence first.',
      },
      turn: 3,
    });

    const applied = await runAgentLoopAssistantMessageHook({
      projection,
      hooks: {
        message: {
          onAssistant: async (payload) => {
            calls.push(payload);
          },
        },
      },
    });

    expect(applied).toBe(projection);
    expect(calls).toEqual([
      {
        content: 'I will inspect the file.',
        reasoningContent: 'Need evidence first.',
        turn: 3,
      },
    ]);
  });

  it('handles assistant message projection, append, and hook dispatch together', async () => {
    const operations: unknown[] = [];
    const toolCalls = [
      {
        id: 'call_read',
        type: 'function' as const,
        function: { name: 'Read', arguments: '{"file":"README.md"}' },
      },
    ];

    const projection = await handleAgentLoopAssistantMessage({
      response: {
        content: 'I will inspect the file.',
        reasoningContent: 'Need evidence first.',
        toolCalls,
      },
      turn: 3,
      conversation: {
        append: (...messages) => {
          operations.push({ type: 'append', messages });
        },
      },
      hooks: {
        message: {
          onAssistant: async (payload) => {
            operations.push({ type: 'hook', payload });
          },
        },
      },
    });

    expect(projection).toEqual({
      message: {
        role: 'assistant',
        content: 'I will inspect the file.',
        reasoningContent: 'Need evidence first.',
        tool_calls: toolCalls,
      },
      hookPayload: {
        content: 'I will inspect the file.',
        reasoningContent: 'Need evidence first.',
        toolCalls,
        turn: 3,
      },
    });
    expect(operations).toEqual([
      { type: 'append', messages: [projection.message] },
      { type: 'hook', payload: projection.hookPayload },
    ]);
  });

  it('returns the chat response when a turn produced one', () => {
    const response = {
      content: 'done',
    };

    expect(assertAgentLoopTurnResponse(response)).toBe(response);
  });

  it('throws a stable invariant error when a turn completed without a chat response', () => {
    expect(() => assertAgentLoopTurnResponse(undefined)).toThrow(
      'Agent loop completed without a chat response',
    );
  });
});
