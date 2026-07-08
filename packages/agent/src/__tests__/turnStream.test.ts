import { describe, expect, it } from 'vitest';
import { consumeAgentLoopTurnStream } from '../loop/turnStream.js';

describe('agent loop turn stream consumption', () => {
  it('passes through run-turn events and projects the terminal outcome', async () => {
    async function* runTurnStream(): AsyncGenerator<
      { type: 'stream_delta'; content: string },
      {
        chatResponse: { content: string };
        streamingExecutionResults?: Array<{ toolUseUuid: string | null }>;
      }
    > {
      yield { type: 'stream_delta', content: 'hello' };
      return {
        chatResponse: { content: 'done' },
        streamingExecutionResults: [{ toolUseUuid: null }],
      };
    }

    const consumed = consumeAgentLoopTurnStream(runTurnStream());

    await expect(consumed.next()).resolves.toEqual({
      value: { type: 'stream_delta', content: 'hello' },
      done: false,
    });
    await expect(consumed.next()).resolves.toEqual({
      value: {
        turnResult: { content: 'done' },
        streamingExecutionResults: [{ toolUseUuid: null }],
      },
      done: true,
    });
  });
});
