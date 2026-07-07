import { describe, expect, it } from 'vitest';
import { TraceRecorder } from '../observability/TraceRecorder.js';
import { HookEvent } from '../types/constants.js';

describe('agent-sdk package TraceRecorder', () => {
  it('records session, turn, tool, usage, result, and hook events into one trace', () => {
    const recorder = new TraceRecorder('session-1', {
      enabled: true,
      capturePayloads: true,
    }, {
      model: 'glm-5.2',
      provider: 'openai-compatible',
    });

    recorder.addEvent('user_prompt', { message: 'hello trace' });
    const turnSpan = recorder.recordTurnStart(1, 4);
    const toolSpan = recorder.recordToolStart('tool-1', 'Search', { q: 'blade' });
    recorder.recordToolResult(toolSpan, 'tool-1', 'Search', 'result text');
    recorder.recordUsage({
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
      maxContextTokens: 128000,
    });
    const hookSpan = recorder.recordHookStart(HookEvent.UserPromptSubmit, { prompt: 'hello' });
    recorder.recordHookEnd(hookSpan, { action: 'continue' });
    recorder.recordTurnEnd(turnSpan, 1);

    const trace = recorder.finish('success', { content: 'done' });

    expect(trace.sessionId).toBe('session-1');
    expect(trace.status).toBe('success');
    expect(trace.metadata).toMatchObject({
      model: 'glm-5.2',
      provider: 'openai-compatible',
    });
    expect(trace.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'user_prompt',
        'turn_start',
        'tool_use',
        'tool_result',
        'usage',
        'hook_start',
        'hook_end',
        'turn_end',
        'result',
      ]),
    );
    expect(trace.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'session', name: 'session.stream', status: 'success' }),
        expect.objectContaining({ kind: 'turn', name: 'turn.1', status: 'success' }),
        expect.objectContaining({ kind: 'tool', name: 'Search', status: 'success' }),
        expect.objectContaining({
          kind: 'hook',
          name: HookEvent.UserPromptSubmit,
          status: 'success',
        }),
      ]),
    );
    expect(JSON.stringify(trace)).toContain('result text');
  });

  it('redacts payload values by default while preserving useful shape metadata', () => {
    const recorder = new TraceRecorder('session-1', { enabled: true });

    recorder.addEvent('user_prompt', {
      message: 'secret prompt',
      params: {
        token: 'secret-token',
        count: 3,
      },
    });

    const trace = recorder.finish('error', { error: 'secret failure' });
    const serialized = JSON.stringify(trace);

    expect(serialized).not.toContain('secret prompt');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('secret failure');
    expect(serialized).toContain('"preview":"[redacted]"');
    expect(trace.events.find((event) => event.type === 'user_prompt')?.data?.params).toMatchObject({
      keys: ['token', 'count'],
      type: 'object',
    });
  });

  it('returns cloned traces so callers cannot mutate recorder state', () => {
    const recorder = new TraceRecorder('session-1', {
      enabled: true,
      capturePayloads: true,
    });
    recorder.addEvent('content', { content: 'hello' });

    const firstTrace = recorder.getTrace();
    firstTrace.events.length = 0;

    expect(recorder.getTrace().events.map((event) => event.type)).toContain('content');
  });
});
