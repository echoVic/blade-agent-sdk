import { describe, expect, it, vi } from 'vitest';
import { SessionTraceManager } from '../../packages/agent-sdk/src/session/traces.js';

function createFinishedTrace(sessionId: string, marker: string) {
  const manager = new SessionTraceManager({
    sessionId,
    observability: {
      enabled: true,
      capturePayloads: true,
    },
    metadata: {},
  });
  const recorder = manager.createRecorder(marker);
  if (!recorder) {
    throw new Error('expected recorder');
  }
  return recorder.finish('success', { marker });
}

describe('agent-sdk session trace manager', () => {
  it('does not create a recorder when observability is disabled', () => {
    const manager = new SessionTraceManager({
      sessionId: 'session-1',
      observability: undefined,
      metadata: {},
    });

    expect(manager.createRecorder('secret prompt')).toBeUndefined();
    expect(manager.getTraces()).toEqual([]);
    expect(manager.getLastTrace()).toBeUndefined();
  });

  it('creates a trace recorder with session metadata and an initial user prompt event', () => {
    const manager = new SessionTraceManager({
      sessionId: 'session-1',
      observability: {
        enabled: true,
        capturePayloads: true,
      },
      metadata: {
        model: 'glm-5.2',
        provider: 'openai-compatible',
        permissionMode: 'default',
      },
    });

    const recorder = manager.createRecorder('visible prompt');
    const trace = recorder?.finish('success', { content: 'done' });

    expect(trace?.metadata).toMatchObject({
      model: 'glm-5.2',
      provider: 'openai-compatible',
      permissionMode: 'default',
    });
    expect(trace?.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['user_prompt', 'result']),
    );
    expect(JSON.stringify(trace)).toContain('visible prompt');
  });

  it('keeps only the configured number of remembered traces', () => {
    const manager = new SessionTraceManager({
      sessionId: 'session-1',
      observability: {
        enabled: true,
        maxTraces: 2,
      },
      metadata: {},
    });

    manager.remember(createFinishedTrace('session-1', 'first'));
    manager.remember(createFinishedTrace('session-1', 'second'));
    manager.remember(createFinishedTrace('session-1', 'third'));

    expect(manager.getTraces()).toHaveLength(2);
    expect(manager.getTraces().map((trace) => trace.events.at(-1)?.data?.marker)).toEqual([
      expect.objectContaining({ length: 6 }),
      expect.objectContaining({ length: 5 }),
    ]);
    expect(manager.getLastTrace()?.events.at(-1)?.data?.marker).toMatchObject({ length: 5 });
  });

  it('isolates sink failures from the session turn lifecycle', async () => {
    const sink = vi.fn(async () => {
      throw new Error('sink failed');
    });
    const onSinkError = vi.fn();
    const manager = new SessionTraceManager({
      sessionId: 'session-1',
      observability: {
        enabled: true,
        sink,
      },
      metadata: {},
      onSinkError,
    });
    const trace = createFinishedTrace('session-1', 'safe');

    await expect(manager.notifySink(trace)).resolves.toBeUndefined();

    expect(sink).toHaveBeenCalledWith(trace);
    expect(onSinkError).toHaveBeenCalledOnce();
    expect(onSinkError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
