import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../agent/AgentEvent.js';
import { SessionId, ToolUseId } from '../../types/identifiers.js';
import { StreamBroadcaster } from '../StreamBroadcaster.js';

const sessionId = SessionId('session-stream-broadcaster');

describe('StreamBroadcaster', () => {
  it('projects content and optional thinking events onto the public stream', () => {
    const visibleThinking = new StreamBroadcaster({ sessionId, includeThinking: true });
    const hiddenThinking = new StreamBroadcaster({ sessionId, includeThinking: false });

    expect(visibleThinking.project({ type: 'content_delta', delta: 'hello' })).toEqual({
      type: 'content',
      delta: 'hello',
      sessionId,
    });
    expect(visibleThinking.project({ type: 'thinking_delta', delta: 'reasoning' })).toEqual({
      type: 'thinking',
      delta: 'reasoning',
      sessionId,
    });
    expect(hiddenThinking.project({ type: 'thinking', content: 'private' })).toBeNull();
  });

  it('tracks tool results and usage while projecting function tool events', () => {
    const broadcaster = new StreamBroadcaster({ sessionId });
    const toolCall = {
      id: 'tool-1',
      type: 'function' as const,
      function: {
        name: 'Read',
        arguments: '{"file_path":"README.md"}',
      },
    };

    expect(broadcaster.project({ type: 'tool_start', toolCall })).toEqual({
      type: 'tool_use',
      id: ToolUseId('tool-1'),
      name: 'Read',
      input: { file_path: 'README.md' },
      sessionId,
    });
    expect(
      broadcaster.project({
        type: 'tool_result',
        toolCall,
        result: {
          status: 'success',
          model: 'contents',
        },
      }),
    ).toEqual({
      type: 'tool_result',
      id: ToolUseId('tool-1'),
      name: 'Read',
      output: 'contents',
      display: undefined,
      isError: false,
      sessionId,
    });

    const usageEvent = {
      type: 'token_usage',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        maxContextTokens: 128_000,
      },
    } satisfies AgentEvent;
    expect(broadcaster.project(usageEvent)).toBeNull();
    expect(broadcaster.summary()).toEqual({
      toolCalls: [
        {
          id: ToolUseId('tool-1'),
          name: 'Read',
          input: { file_path: 'README.md' },
          output: 'contents',
          duration: 0,
          isError: false,
        },
      ],
      usage: usageEvent.usage,
    });
  });
});
