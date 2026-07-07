import { describe, expect, it } from 'vitest';
import { TraceRecorder } from '../observability/TraceRecorder.js';
import { SessionId } from '../types/branded.js';

const tracePortModulePath = '../../packages/agent-sdk/src/session/kernelTracePort.js';

describe('agent-sdk package-local kernel trace port', () => {
  it('records total-only kernel usage without requiring token breakdowns', async () => {
    const { createPackageLocalKernelTracePort } = await import(tracePortModulePath);
    const recorder = new TraceRecorder(SessionId('session-total-only-usage'), {
      enabled: true,
      capturePayloads: true,
    });
    const tracePort = createPackageLocalKernelTracePort({
      recorder,
      maxContextTokens: 4096,
    });

    await tracePort.record({
      type: 'usage',
      usage: {
        totalTokens: 12,
      },
    });

    expect(recorder.getTrace().events.find((event) => event.type === 'usage')?.data?.usage)
      .toMatchObject({
        value: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 12,
          maxContextTokens: 4096,
        },
      });
  });
});
