import { describe, expect, it } from 'vitest';
import {
  assertAgentLoopTurnResponse,
  buildAgentLoopAssistantMessageProjection,
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
