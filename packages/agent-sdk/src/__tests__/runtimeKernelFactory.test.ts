import type { ModelPort, ModelRequest, ModelResponse } from '@blade-ai/ai';
import { describe, expect, it, vi } from 'vitest';
import { createPackageLocalAgentKernelFactory } from '../session/kernelFactory.js';

describe('agent-sdk package-local agent kernel factory', () => {
  it('creates real AgentKernel instances that run turns through the model port', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
      content: 'Hello from the package-local kernel',
      usage: {
        promptTokens: 2,
        completionTokens: 5,
        totalTokens: 7,
      },
      finishReason: 'stop',
    }));
    const model: ModelPort = {
      generate,
      async *stream() {},
    };

    const factory = createPackageLocalAgentKernelFactory();
    const kernel = factory.create({
      model,
      modelRequestDefaults: {
        model: 'test-model',
        temperature: 0.1,
        maxOutputTokens: 128,
      },
    });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Say hello', turnId: 'turn_1' })) {
      events.push(event);
    }

    expect(generate).toHaveBeenCalledWith({
      model: 'test-model',
      temperature: 0.1,
      maxOutputTokens: 128,
      messages: [{ role: 'user', content: 'Say hello' }],
      signal: undefined,
    });
    expect(events).toEqual([
      { type: 'content', delta: 'Hello from the package-local kernel' },
      {
        type: 'usage',
        usage: {
          promptTokens: 2,
          completionTokens: 5,
          totalTokens: 7,
        },
      },
      {
        type: 'result',
        content: 'Hello from the package-local kernel',
        finishReason: 'stop',
      },
    ]);
  });
});
