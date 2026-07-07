import { describe, expect, it } from 'vitest';
import { createAgentLoopTokenUsageTracker } from '../loop/tokenUsageTracker.js';

describe('agent loop token usage tracker', () => {
  it('starts with no accumulated tokens or prompt token memory', () => {
    const tracker = createAgentLoopTokenUsageTracker();

    expect(tracker.totalTokens).toBe(0);
    expect(tracker.lastPromptTokens).toBeUndefined();
  });

  it('accumulates total tokens and remembers the latest prompt tokens', () => {
    const tracker = createAgentLoopTokenUsageTracker();

    tracker.record({ promptTokens: 10, totalTokens: 14 });
    tracker.record({ promptTokens: 7, totalTokens: 11 });

    expect(tracker.totalTokens).toBe(25);
    expect(tracker.lastPromptTokens).toBe(7);
  });

  it('preserves accumulated total when provider usage omits total tokens', () => {
    const tracker = createAgentLoopTokenUsageTracker();

    tracker.record({ promptTokens: 10, totalTokens: 14 });
    tracker.record({ promptTokens: 4 });

    expect(tracker.totalTokens).toBe(14);
    expect(tracker.lastPromptTokens).toBe(4);
  });

  it('allows zero total-token usage without changing the accumulated total', () => {
    const tracker = createAgentLoopTokenUsageTracker();

    tracker.record({ promptTokens: 3, totalTokens: 0 });

    expect(tracker.totalTokens).toBe(0);
    expect(tracker.lastPromptTokens).toBe(3);
  });
});
