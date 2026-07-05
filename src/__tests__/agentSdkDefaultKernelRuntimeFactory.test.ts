import { describe, expect, it, vi } from 'vitest';
import type { AgentKernelOptions } from '@blade-ai/agent';
import type { ModelPort } from '@blade-ai/ai';
import { createDefaultKernelSessionRuntimeFactory } from '../../packages/agent-sdk/src/session/defaultKernelRuntimeFactory.js';
import { PackageLocalSession } from '../../packages/agent-sdk/src/session/sessionInstance.js';
import type { SessionOptions, StreamMessage } from '../../packages/agent-sdk/src/session/types.js';

const model: ModelPort = {
  async generate() {
    return { content: 'unused' };
  },
  async *stream() {},
};

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
  temperature: 0.2,
  maxOutputTokens: 256,
  maxContextTokens: 4096,
  providerOptions: { routing: { tier: 'test' } },
  defaultContext: {
    capabilities: {
      filesystem: {
        cwd: '/workspace/project',
        roots: ['/workspace/project'],
      },
    },
  },
};

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

describe('agent-sdk default kernel runtime factory', () => {
  it('assembles package-local kernel sessions from session options and runtime ports', async () => {
    const kernelOptions: AgentKernelOptions[] = [];
    const turns: Array<{ input: string; turnId?: string; signal?: AbortSignal }> = [];
    const disconnectAll = vi.fn();
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'kernel-session',
      createTurnId: () => 'kernel-turn',
      runtime: {
        mcpRegistry: {
          disconnectAll,
          async getCapabilities() {
            return [];
          },
        },
        kernelModelResolver: {
          resolve(resolveOptions) {
            expect(resolveOptions.modelId).toBeUndefined();
            expect(resolveOptions.bladeConfig.currentModelId).toBe('default');
            expect(resolveOptions.bladeConfig.models[0]).toMatchObject({
              model: 'test-model',
              temperature: 0.2,
              maxOutputTokens: 256,
              maxContextTokens: 4096,
              providerOptions: { routing: { tier: 'test' } },
            });
            return {
              model,
              modelRequestDefaults: {
                model: 'test-model',
                temperature: 0.2,
                maxOutputTokens: 256,
                maxContextTokens: 4096,
                providerOptions: { routing: { tier: 'test' } },
              },
            };
          },
        },
        kernelFactory: {
          create(createOptions) {
            kernelOptions.push(createOptions);
            return {
              async *runTurn(turn) {
                turns.push(turn);
                yield { type: 'content' as const, delta: `echo:${turn.input}` };
                yield {
                  type: 'usage' as const,
                  usage: {
                    promptTokens: 1,
                    completionTokens: 2,
                    totalTokens: 3,
                  },
                };
                yield { type: 'result' as const, content: 'done' };
              },
            };
          },
        },
      },
    });

    const session = await factory.create(options);

    expect(session).toBeInstanceOf(PackageLocalSession);
    expect(session.sessionId).toBe('kernel-session');
    expect(session.getDefaultContext()).toEqual(options.defaultContext);
    await session.send('hello', { maxTurns: 5 });
    await expect(collect(session.stream())).resolves.toEqual([
      { type: 'turn_start', turn: 1, sessionId: 'kernel-session' },
      { type: 'content', delta: 'echo:hello', sessionId: 'kernel-session' },
      {
        type: 'usage',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          maxContextTokens: 4096,
        },
        sessionId: 'kernel-session',
      },
      { type: 'turn_end', turn: 1, sessionId: 'kernel-session' },
      { type: 'result', subtype: 'success', content: 'done', sessionId: 'kernel-session' },
    ]);
    await session.close();

    expect(kernelOptions).toHaveLength(1);
    expect(kernelOptions[0]).toMatchObject({
      model,
      modelRequestDefaults: {
        model: 'test-model',
        temperature: 0.2,
        maxOutputTokens: 256,
        maxContextTokens: 4096,
        providerOptions: { routing: { tier: 'test' } },
      },
      maxSteps: 5,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ input: 'hello', turnId: 'kernel-turn' });
    expect(turns[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(disconnectAll).toHaveBeenCalledTimes(1);
  });
});
