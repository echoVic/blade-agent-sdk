import type { ModelPort, ModelRequest, ModelResponse } from '@blade-ai/ai';
import { describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../index.js';

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
});
