import { describe, expect, it } from 'vitest';
import { SessionId } from '../local/branded.js';
import { PromptStreamAccumulator } from '../session/promptStreamAccumulator.js';
import type { StreamMessage } from '../session/types.js';

function feed(messages: StreamMessage[]): PromptStreamAccumulator {
  const accumulator = new PromptStreamAccumulator();
  for (const message of messages) {
    accumulator.accept(message);
  }
  return accumulator;
}

describe('agent-sdk prompt stream accumulator', () => {
  it('builds a prompt result from successful stream events', () => {
    const accumulator = feed([
      { type: 'turn_start', turn: 2, sessionId: SessionId('session-1') },
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'lookup',
        input: { query: 'blade' },
        sessionId: SessionId('session-1'),
      },
      {
        type: 'tool_result',
        id: 'tool-1',
        name: 'lookup',
        output: 'found blade',
        sessionId: SessionId('session-1'),
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          totalTokens: 8,
          maxContextTokens: 128000,
        },
        sessionId: SessionId('session-1'),
      },
      {
        type: 'result',
        subtype: 'success',
        content: 'done',
        sessionId: SessionId('session-1'),
      },
    ]);

    expect(accumulator.build({ duration: 42 })).toEqual({
      result: 'done',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'lookup',
          input: { query: 'blade' },
          output: 'found blade',
          duration: 0,
          isError: undefined,
        },
      ],
      usage: {
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
        maxContextTokens: 128000,
      },
      duration: 42,
      turnsCount: 2,
    });
  });

  it('marks failed tool results on their matching tool call', () => {
    const accumulator = feed([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'lookup',
        input: 'raw',
        sessionId: SessionId('session-1'),
      },
      {
        type: 'tool_result',
        id: 'tool-1',
        name: 'lookup',
        output: { error: 'not found' },
        isError: true,
        sessionId: SessionId('session-1'),
      },
      { type: 'result', subtype: 'success', content: 'handled', sessionId: SessionId('session-1') },
    ]);

    expect(accumulator.build({ duration: 1 }).toolCalls).toEqual([
      {
        id: 'tool-1',
        name: 'lookup',
        input: 'raw',
        output: { error: 'not found' },
        duration: 0,
        isError: true,
      },
    ]);
  });

  it('throws the captured stream error when building the result', () => {
    const accumulator = feed([
      { type: 'error', message: 'model failed', code: 'MODEL_ERROR', sessionId: SessionId('session-1') },
    ]);

    expect(() => accumulator.build({ duration: 1 })).toThrow('model failed');
  });

  it('throws result error messages with a safe fallback', () => {
    expect(() =>
      feed([{ type: 'result', subtype: 'error', sessionId: SessionId('session-1') }]).build({ duration: 1 }),
    ).toThrow('Unknown error');
  });
});
