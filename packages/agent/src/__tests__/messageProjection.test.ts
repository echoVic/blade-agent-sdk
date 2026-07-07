import { describe, expect, it } from 'vitest';
import {
  modelResponseToAssistantMessage,
  toolResultToToolMessage,
} from '../state/index.js';

describe('agent state message projection helpers', () => {
  it('projects a model response into an assistant message', () => {
    expect(modelResponseToAssistantMessage({
      content: 'Need a file read',
      reasoningContent: 'Inspect before answering',
      toolCalls: [
        {
          id: 'call_read',
          name: 'Read',
          input: { path: 'README.md' },
        },
      ],
      finishReason: 'tool-calls',
    })).toEqual({
      role: 'assistant',
      content: 'Need a file read',
      reasoningContent: 'Inspect before answering',
      toolCalls: [
        {
          id: 'call_read',
          name: 'Read',
          input: { path: 'README.md' },
        },
      ],
    });
  });

  it('omits empty optional assistant message fields', () => {
    expect(modelResponseToAssistantMessage({
      content: 'Final answer',
      toolCalls: [],
    })).toEqual({
      role: 'assistant',
      content: 'Final answer',
    });
  });

  it('projects tool results into model tool messages', () => {
    expect(toolResultToToolMessage(
      {
        id: 'call_search',
        name: 'Search',
        output: { matches: 2, ok: true },
      },
      {
        id: 'fallback_call',
        name: 'FallbackSearch',
      },
    )).toEqual({
      role: 'tool',
      content: '{"matches":2,"ok":true}',
      name: 'Search',
      toolCallId: 'call_search',
    });
  });

  it('uses fallback tool call identity when a result omits it', () => {
    expect(toolResultToToolMessage(
      {
        id: '',
        name: '',
        output: 'Tool output',
      },
      {
        id: 'call_write',
        name: 'Write',
      },
    )).toEqual({
      role: 'tool',
      content: 'Tool output',
      name: 'Write',
      toolCallId: 'call_write',
    });
  });
});
