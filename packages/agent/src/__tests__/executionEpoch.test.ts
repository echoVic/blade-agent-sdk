import { describe, expect, it } from 'vitest';
import {
  ExecutionEpoch,
  shouldStopAgentLoopToolResultProcessing,
} from '../epoch/ExecutionEpoch.js';

describe('ExecutionEpoch', () => {
  it('starts valid and becomes invalid after invalidate()', () => {
    const epoch = new ExecutionEpoch();

    expect(epoch.isValid).toBe(true);

    epoch.invalidate();

    expect(epoch.isValid).toBe(false);
  });

  it('continues tool result processing when no epoch is present', () => {
    expect(shouldStopAgentLoopToolResultProcessing(null)).toBe(false);
  });

  it('continues tool result processing for a valid epoch', () => {
    const epoch = new ExecutionEpoch();

    expect(shouldStopAgentLoopToolResultProcessing(epoch)).toBe(false);
  });

  it('stops tool result processing for an invalid epoch', () => {
    const epoch = new ExecutionEpoch();
    epoch.invalidate();

    expect(shouldStopAgentLoopToolResultProcessing(epoch)).toBe(true);
  });
});
