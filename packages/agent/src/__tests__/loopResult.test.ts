import { describe, expect, it } from 'vitest';
import { buildAgentLoopAbortResult } from '../loop/loopResult.js';

describe('agent loop result builders', () => {
  it('builds an abort result with deterministic loop metadata', () => {
    const result = buildAgentLoopAbortResult({
      turnsCount: 2,
      toolCallsCount: 3,
      startTime: 100,
      now: 175,
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: 'aborted',
        message: '任务已被用户中止',
      },
      metadata: {
        turnsCount: 2,
        toolCallsCount: 3,
        duration: 75,
      },
    });
  });
});
