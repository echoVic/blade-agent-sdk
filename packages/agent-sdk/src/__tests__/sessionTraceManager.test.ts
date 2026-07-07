import { describe, expect, it, vi } from 'vitest';
import {
  createSessionTraceFinalizer,
  SessionTraceManager,
} from '../session/traces.js';

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

  it('treats trace finalization as a no-op when no recorder exists', async () => {
    const manager = new SessionTraceManager({
      sessionId: 'session-1',
      observability: undefined,
      metadata: {},
    });
    const finalizer = createSessionTraceFinalizer(undefined, manager);

    await expect(finalizer.finish('success', { content: 'ignored' })).resolves.toBeUndefined();

    expect(manager.getTraces()).toEqual([]);
  });

  it('isolates recorder finish failures from the session turn lifecycle', async () => {
    const recorder = {
      finish: vi.fn(() => {
        throw new Error('trace finish failed');
      }),
    };
    const manager = {
      remember: vi.fn(),
      notifySink: vi.fn(async () => undefined),
    };
    const finalizer = createSessionTraceFinalizer(recorder as never, manager);

    await expect(finalizer.finish('success', { content: 'done' })).resolves.toBeUndefined();

    expect(recorder.finish).toHaveBeenCalledWith('success', { content: 'done' });
    expect(manager.remember).not.toHaveBeenCalled();
    expect(manager.notifySink).not.toHaveBeenCalled();
  });

  it('finishes, remembers, and notifies a trace only once', async () => {
    const sink = vi.fn();
    const manager = new SessionTraceManager({
      sessionId: 'session-1',
      observability: {
        enabled: true,
        capturePayloads: true,
        sink,
      },
      metadata: {},
    });
    const recorder = manager.createRecorder('trace me');
    const finalizer = createSessionTraceFinalizer(recorder, manager);

    const trace = await finalizer.finish('success', { content: 'done' });
    const duplicate = await finalizer.finish('error', { error: 'too late' });

    expect(trace?.status).toBe('success');
    expect(duplicate).toBeUndefined();
    expect(manager.getTraces()).toHaveLength(1);
    expect(manager.getLastTrace()?.status).toBe('success');
    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith(trace);
  });

  it('remembers finished traces even when the sink fails', async () => {
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
    const recorder = manager.createRecorder('safe');
    const finalizer = createSessionTraceFinalizer(recorder, manager);

    const trace = await finalizer.finish('aborted', { reason: 'user_abort' });

    expect(trace?.status).toBe('aborted');
    expect(manager.getTraces()).toHaveLength(1);
    expect(manager.getLastTrace()).toEqual(trace);
    expect(onSinkError).toHaveBeenCalledOnce();
  });
});
