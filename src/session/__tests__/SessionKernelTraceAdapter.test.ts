import type { AgentTraceEvent } from '@blade-ai/agent';
import { describe, expect, it } from 'vitest';
import { TraceRecorder } from '../../observability/TraceRecorder.js';
import { SessionId } from '../../types/branded.js';
import { createKernelTracePort } from '../SessionKernelTraceAdapter.js';

describe('SessionKernelTraceAdapter', () => {
  it('maps kernel trace events into the session trace recorder', async () => {
    const recorder = new TraceRecorder(SessionId('session-kernel-trace'), {
      enabled: true,
      capturePayloads: true,
    });
    const tracePort = createKernelTracePort({ recorder, maxContextTokens: 4096 });

    const events: AgentTraceEvent[] = [
      { type: 'turn_start', input: 'Find Blade docs' },
      { type: 'model_request', messages: [{ role: 'user', content: 'Find Blade docs' }] },
      {
        type: 'tool_call_start',
        toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } },
      },
      {
        type: 'tool_call_end',
        toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } },
        result: { id: 'call_search', name: 'Search', output: 'Blade docs result' },
      },
      {
        type: 'usage',
        usage: { promptTokens: 8, completionTokens: 5, totalTokens: 13 },
      },
      { type: 'turn_end', content: 'Found Blade docs', finishReason: 'stop' },
    ];

    for (const event of events) {
      await tracePort.record(event);
    }

    const trace = recorder.getTrace();
    expect(trace.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'turn_start',
        'model_request',
        'tool_use',
        'tool_result',
        'usage',
        'turn_end',
      ]),
    );
    expect(trace.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'turn', name: 'kernel.turn', status: 'success' }),
        expect.objectContaining({ kind: 'tool', name: 'Search', status: 'success' }),
      ]),
    );
    expect(trace.events.find((event) => event.type === 'usage')?.data?.usage).toMatchObject({
      value: {
        inputTokens: 8,
        outputTokens: 5,
        totalTokens: 13,
        maxContextTokens: 4096,
      },
    });
    expect(JSON.stringify(trace)).toContain('Blade docs result');
  });

  it('keeps kernel payloads redacted when trace payload capture is disabled', async () => {
    const recorder = new TraceRecorder(SessionId('session-kernel-trace-safe'), {
      enabled: true,
    });
    const tracePort = createKernelTracePort({ recorder });

    await tracePort.record({
      type: 'model_request',
      messages: [{ role: 'user', content: 'secret prompt' }],
    });
    await tracePort.record({
      type: 'model_response',
      content: 'secret answer',
      finishReason: 'stop',
    });

    const serialized = JSON.stringify(recorder.getTrace());
    expect(serialized).not.toContain('secret prompt');
    expect(serialized).not.toContain('secret answer');
    expect(serialized).toContain('"preview":"[redacted]"');
  });
});
