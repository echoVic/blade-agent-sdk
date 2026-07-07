import { describe, expect, it } from 'vitest';
import { createBufferedAgentTracePort } from '../tracing/index.js';

describe('createBufferedAgentTracePort', () => {
  it('records a bounded copy of trace events and can be cleared', async () => {
    const trace = createBufferedAgentTracePort({ maxEvents: 2 });

    await trace.record({ type: 'turn_start', input: 'find docs' });
    await trace.record({
      type: 'usage',
      usage: {
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
      },
    });
    await trace.record({ type: 'turn_end', content: 'done', finishReason: 'stop' });

    const events = trace.getEvents();

    expect(events).toEqual([
      {
        type: 'usage',
        usage: {
          promptTokens: 3,
          completionTokens: 5,
          totalTokens: 8,
        },
      },
      { type: 'turn_end', content: 'done', finishReason: 'stop' },
    ]);

    events.push({ type: 'turn_start', input: 'mutate copy' });
    expect(trace.getEvents()).toHaveLength(2);

    trace.clear();
    expect(trace.getEvents()).toEqual([]);
  });

  it('rejects invalid maxEvents values before recording starts', () => {
    expect(() => createBufferedAgentTracePort({ maxEvents: -1 })).toThrow(RangeError);
    expect(() => createBufferedAgentTracePort({ maxEvents: 1.5 })).toThrow(RangeError);
  });
});
