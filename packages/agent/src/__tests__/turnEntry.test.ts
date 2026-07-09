import { describe, expect, it } from 'vitest';
import {
  createAgentLoopTurnCounter,
  handleAgentLoopTurnEntryWithEmissions,
} from '../loop/index.js';

describe('agent loop turn entry orchestration', () => {
  it('runs before-turn hooks and prepares turn state after turn_start emission', async () => {
    const operations: unknown[] = [];
    const turnCounter = createAgentLoopTurnCounter();

    const generator = handleAgentLoopTurnEntryWithEmissions({
      signal: undefined,
      loopClock: {
        resultTiming: ({ turnsCount, toolCallsCount }) => ({
          turnsCount,
          toolCallsCount,
          startTime: 1000,
        }),
      },
      turnCounter,
      effectiveMaxTurns: 3,
      toolResultTracker: {
        toolCallsCount: 0,
      },
      conversation: {
        toArray: () => [{ role: 'user', content: 'hello' }],
      },
      tokenUsageTracker: {
        lastPromptTokens: 42,
      },
      hooks: {
        turn: {
          beforeTurn: async function* (payload) {
            operations.push({ type: 'hookPayload', payload });
            yield { type: 'hook_event', turn: payload.turn };
            return true;
          },
        },
      },
      prepareTurnState: (turn) => {
        operations.push({ type: 'prepare', turn });
        return {
          maxContextTokens: 128000,
          executionContext: { cwd: '/tmp/project' },
          permissionMode: 'default',
        };
      },
    });

    expect(await generator.next()).toEqual({
      done: false,
      value: { type: 'hook_event', turn: 0 },
    });
    expect(operations).toEqual([
      {
        type: 'hookPayload',
        payload: {
          turn: 0,
          messages: [{ role: 'user', content: 'hello' }],
          lastPromptTokens: 42,
        },
      },
    ]);

    expect(await generator.next()).toEqual({
      done: false,
      value: { type: 'turn_start', turn: 1, maxTurns: 3 },
    });
    expect(operations).toHaveLength(1);

    expect(await generator.next()).toEqual({
      done: true,
      value: {
        action: 'continue',
        turnsCount: 1,
        turnStateProjection: {
          turnState: {
            maxContextTokens: 128000,
            executionContext: { cwd: '/tmp/project' },
            permissionMode: 'default',
          },
          maxContextTokens: 128000,
          executionContext: { cwd: '/tmp/project' },
          permissionMode: 'default',
        },
      },
    });
    expect(operations).toEqual([
      {
        type: 'hookPayload',
        payload: {
          turn: 0,
          messages: [{ role: 'user', content: 'hello' }],
          lastPromptTokens: 42,
        },
      },
      { type: 'prepare', turn: 1 },
    ]);
  });
});
