import { describe, expect, it } from 'vitest';
import { createKernelTracePort } from '../local/index.js';
import type { KernelTracePortOptions } from '../local/index.js';
import type { TraceRecorder } from '../local/index.js';

/** Minimal TraceRecorder stub that collects span events. */
function makeRecorder(): TraceRecorder {
  const events: Array<{ type: string; data: any; spanId?: string }> = [];
  return {
    startSpan(name: string, kind: string, attrs?: Record<string, unknown>): string {
      return `span-${name}`;
    },
    endSpan(_spanId: string): void {},
    addEvent(name: string, attrs: Record<string, unknown>, spanId?: string): void {
      events.push({ type: name, data: attrs, spanId });
    },
    recordUsage(_usage: any): void {},
    recordToolStart(toolCallId: string, toolName: string, input: unknown): string {
      return `tool-${toolCallId}`;
    },
    recordToolResult(_spanId: string | undefined, _toolCallId: string, _toolName: string, _output: unknown, _isError: boolean): void {},
    // @ts-expect-error — test-only access to collected events
    _events: events,
  };
}

describe('createKernelTracePort', () => {
  it('creates a trace port', () => {
    const port = createKernelTracePort({ recorder: makeRecorder() });
    expect(port).toBeDefined();
    expect(typeof port.record).toBe('function');
  });

  it('records turn start and end events', () => {
    const recorder = makeRecorder();
    const port = createKernelTracePort({ recorder });
    port.record({ type: 'turn_start', input: 'hello' } as any);
    port.record({ type: 'turn_end', content: 'done', finishReason: 'stop' } as any);
    expect((recorder as any)._events.length).toBeGreaterThan(0);
  });
});
