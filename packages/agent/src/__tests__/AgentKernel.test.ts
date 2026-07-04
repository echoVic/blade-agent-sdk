import type { ModelPort, ModelRequest, ModelResponse } from '@blade-ai/ai';
import { describe, expect, it, vi } from 'vitest';
import { AgentKernel, type AgentToolPort } from '../index.js';

describe('AgentKernel', () => {
  it('runs a no-tool turn through the model port and emits result events', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
      content: 'Hello from Blade',
      usage: {
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7,
      },
      finishReason: 'stop',
    }));
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };

    const kernel = new AgentKernel({ model });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Say hello' })) {
      events.push(event);
    }

    expect(generate).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'Say hello' }],
      signal: undefined,
    });
    expect(events).toEqual([
      { type: 'content', delta: 'Hello from Blade' },
      {
        type: 'usage',
        usage: {
          promptTokens: 3,
          completionTokens: 4,
          totalTokens: 7,
        },
      },
      { type: 'result', content: 'Hello from Blade', finishReason: 'stop' },
    ]);
  });

  it('executes model tool calls and follows up with tool results', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => {
      if (generate.mock.calls.length === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'Search',
              input: { q: 'blade' },
            },
          ],
          finishReason: 'tool-calls',
        };
      }

      return {
        content: 'Found Blade docs',
        usage: {
          promptTokens: 8,
          completionTokens: 5,
          totalTokens: 13,
        },
        finishReason: 'stop',
      };
    });
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const execute = vi.fn(async () => ({
      id: 'call_search',
      name: 'Search',
      output: 'Blade docs result',
    }));
    const tools: AgentToolPort = {
      list: async () => [],
      execute,
    };

    const kernel = new AgentKernel({ model, tools });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Find Blade docs' })) {
      events.push(event);
    }

    expect(execute).toHaveBeenCalledWith(
      { id: 'call_search', name: 'Search', input: { q: 'blade' } },
      undefined,
    );
    expect(generate).toHaveBeenNthCalledWith(2, {
      messages: [
        { role: 'user', content: 'Find Blade docs' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
        },
        {
          role: 'tool',
          content: 'Blade docs result',
          name: 'Search',
          toolCallId: 'call_search',
        },
      ],
      signal: undefined,
    });
    expect(events).toEqual([
      { type: 'tool_use', toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } } },
      { type: 'tool_result', result: { id: 'call_search', name: 'Search', output: 'Blade docs result' } },
      { type: 'content', delta: 'Found Blade docs' },
      {
        type: 'usage',
        usage: {
          promptTokens: 8,
          completionTokens: 5,
          totalTokens: 13,
        },
      },
      { type: 'result', content: 'Found Blade docs', finishReason: 'stop' },
    ]);
  });
});
