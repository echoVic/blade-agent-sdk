import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopTurnStateProjection,
  buildAgentLoopTurnStateProjectionFromPreparation,
} from '../loop/turnState.js';

describe('agent loop turn state projection', () => {
  it('preserves the prepared turn state and exposes loop-facing fields', () => {
    const executionContext = { cwd: '/tmp/project' };
    const turnState = {
      tools: [{ name: 'Read' }],
      maxContextTokens: 128_000,
      permissionMode: 'default',
      executionContext,
    };

    const projection = buildAgentLoopTurnStateProjection({ turnState });

    expect(projection.turnState).toBe(turnState);
    expect(projection).toEqual({
      turnState,
      maxContextTokens: 128_000,
      permissionMode: 'default',
      executionContext,
    });
  });

  it('projects turn state from a turn preparation function', () => {
    const executionContext = { cwd: '/tmp/project' };
    const preparedTurns: number[] = [];
    const turnState = {
      tools: [{ name: 'Read' }],
      maxContextTokens: 128_000,
      permissionMode: 'default',
      executionContext,
    };

    const projection = buildAgentLoopTurnStateProjectionFromPreparation({
      prepareTurnState: (turn) => {
        preparedTurns.push(turn);
        return turnState;
      },
      turn: 3,
    });

    expect(preparedTurns).toEqual([3]);
    expect(projection).toEqual({
      turnState,
      maxContextTokens: 128_000,
      permissionMode: 'default',
      executionContext,
    });
  });
});
