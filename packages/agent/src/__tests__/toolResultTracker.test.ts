import { describe, expect, it } from 'vitest';
import { createAgentToolResultTracker } from '../loop/toolResultTracker.js';

describe('agent tool result tracker', () => {
  it('starts with zero tool calls and no recent results', () => {
    const tracker = createAgentToolResultTracker();

    expect(tracker.toolCallsCount).toBe(0);
    expect(tracker.recentToolResults).toEqual([]);
  });

  it('increments the total count for every recorded result', () => {
    const tracker = createAgentToolResultTracker<{ id: number }>();

    tracker.record({ id: 1 });
    tracker.record({ id: 2 });

    expect(tracker.toolCallsCount).toBe(2);
    expect(tracker.recentToolResults).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('keeps only the latest recent results within the configured limit', () => {
    const tracker = createAgentToolResultTracker<{ id: number }>({ maxRecentResults: 2 });

    tracker.record({ id: 1 });
    tracker.record({ id: 2 });
    tracker.record({ id: 3 });

    expect(tracker.toolCallsCount).toBe(3);
    expect(tracker.recentToolResults).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it('exposes recent results as snapshots so callers cannot mutate tracker state', () => {
    const tracker = createAgentToolResultTracker<{ id: number }>({ maxRecentResults: 3 });

    tracker.record({ id: 1 });
    const snapshot = tracker.recentToolResults as Array<{ id: number }>;
    snapshot.push({ id: 999 });

    expect(tracker.toolCallsCount).toBe(1);
    expect(tracker.recentToolResults).toEqual([{ id: 1 }]);
  });
});
