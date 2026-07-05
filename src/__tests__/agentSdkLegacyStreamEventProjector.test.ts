import { describe, expect, it } from 'vitest';
import { TraceRecorder } from '../../packages/agent-sdk/src/observability/TraceRecorder.js';
import {
  LegacyStreamEventProjector,
  type LegacyStreamAgentEvent,
} from '../../packages/agent-sdk/src/session/legacyStreamEvents.js';

describe('agent-sdk legacy stream event projector', () => {
  it('projects turn and content events with session ids while recording trace events', () => {
    const traceRecorder = new TraceRecorder('session-1', { enabled: true, capturePayloads: true });
    const projector = new LegacyStreamEventProjector({
      sessionId: 'session-1',
      traceRecorder,
    });

    const messages = [
      projector.project({ type: 'turn_start', turn: 1, maxTurns: 3 }),
      projector.project({ type: 'content_delta', delta: 'Hello' }),
      projector.project({ type: 'turn_end', turn: 1 }),
    ];

    expect(messages).toEqual([
      { type: 'turn_start', turn: 1, sessionId: 'session-1' },
      { type: 'content', delta: 'Hello', sessionId: 'session-1' },
      { type: 'turn_end', turn: 1, sessionId: 'session-1' },
    ]);
    expect(traceRecorder.getTrace().events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['turn_start', 'content_delta', 'turn_end']),
    );
  });

  it('only projects thinking events when includeThinking is enabled', () => {
    const hiddenProjector = new LegacyStreamEventProjector({
      sessionId: 'session-1',
      includeThinking: false,
    });
    const visibleProjector = new LegacyStreamEventProjector({
      sessionId: 'session-1',
      includeThinking: true,
    });

    expect(hiddenProjector.project({ type: 'thinking_delta', delta: 'hidden' })).toBeUndefined();
    expect(visibleProjector.project({ type: 'thinking', content: 'visible' })).toEqual({
      type: 'thinking',
      delta: 'visible',
      sessionId: 'session-1',
    });
  });

  it('tracks tool calls and projects tool lifecycle events', () => {
    const traceRecorder = new TraceRecorder('session-1', { enabled: true, capturePayloads: true });
    const projector = new LegacyStreamEventProjector({
      sessionId: 'session-1',
      traceRecorder,
    });
    const toolCall = {
      id: 'tool-1',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
    } as const;

    const messages = [
      projector.project({ type: 'tool_start', toolCall }),
      projector.project({ type: 'tool_progress', toolCall, message: 'Reading' }),
      projector.project({
        type: 'tool_result',
        toolCall,
        result: { success: true, llmContent: 'done' },
      }),
    ];

    expect(messages).toEqual([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'read_file',
        input: { path: 'README.md' },
        sessionId: 'session-1',
      },
      {
        type: 'tool_progress',
        id: 'tool-1',
        name: 'read_file',
        message: 'Reading',
        sessionId: 'session-1',
      },
      {
        type: 'tool_result',
        id: 'tool-1',
        name: 'read_file',
        output: 'done',
        isError: false,
        sessionId: 'session-1',
      },
    ]);
    expect(projector.getToolCalls()).toEqual([
      {
        id: 'tool-1',
        name: 'read_file',
        input: { path: 'README.md' },
        output: 'done',
        duration: 0,
        isError: false,
      },
    ]);
    expect(traceRecorder.getTrace().events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['tool_use', 'tool_progress', 'tool_result']),
    );
  });

  it('projects tool side-effect events without accepting non-function tool calls', () => {
    const projector = new LegacyStreamEventProjector({ sessionId: 'session-1' });
    const toolCall = {
      id: 'tool-1',
      type: 'function',
      function: {
        name: 'edit_file',
        arguments: '{}',
      },
    } as const;
    const ignored = {
      type: 'tool_start',
      toolCall: { id: 'tool-2', type: 'custom' },
    } satisfies LegacyStreamAgentEvent;

    expect(projector.project(ignored)).toBeUndefined();
    expect(
      projector.project({
        type: 'tool_runtime_patch',
        toolCall,
        patch: { scope: 'turn', source: 'tool', toolPolicy: { allow: ['read_file'] } },
      }),
    ).toEqual({
      type: 'tool_runtime_patch',
      id: 'tool-1',
      name: 'edit_file',
      patch: { scope: 'turn', source: 'tool', toolPolicy: { allow: ['read_file'] } },
      sessionId: 'session-1',
    });
    expect(
      projector.project({
        type: 'tool_new_messages',
        toolCall,
        messages: [{ role: 'assistant', content: 'created' }],
      }),
    ).toEqual({
      type: 'tool_new_messages',
      id: 'tool-1',
      name: 'edit_file',
      messages: [{ role: 'assistant', content: 'created' }],
      sessionId: 'session-1',
    });
  });

  it('tracks token usage without yielding a stream message', () => {
    const traceRecorder = new TraceRecorder('session-1', { enabled: true });
    const projector = new LegacyStreamEventProjector({
      sessionId: 'session-1',
      traceRecorder,
    });

    expect(
      projector.project({
        type: 'token_usage',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          maxContextTokens: 128000,
        },
      }),
    ).toBeUndefined();

    expect(projector.getUsage()).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      maxContextTokens: 128000,
    });
    expect(traceRecorder.getTrace().events.map((event) => event.type)).toContain('usage');
  });
});
