import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';

const createAgent = vi.fn(async (_config: unknown, _options?: unknown, _deps?: unknown) => ({
  async setModel() {},
}));

vi.mock('../../agent/Agent.js', () => ({
  Agent: {
    create: createAgent,
  },
}));

const { createSession } = await import('../Session.js');

describe('Session model config', () => {
  it('passes sampling and thinking options into the default model config', async () => {
    const providerOptions = {
      openai: {
        reasoningEffort: 'low',
      },
    };
    const session = await createSession({
      provider: {
        id: 'openai-primary',
        type: 'openai',
        apiKey: 'test-key',
        requestTimeoutMs: 120_000,
        streamIdleTimeoutMs: 30_000,
      },
      model: 'gpt-5',
      temperature: 0.2,
      maxOutputTokens: 4096,
      maxContextTokens: 32000,
      toolTimeoutMs: 45_000,
      providerOptions,
      thinkingEnabled: true,
      thinkingBudget: 1024,
    });

    const [config] = createAgent.mock.calls.at(-1) ?? [];
    expect(config).toMatchObject({
      temperature: 0.2,
      toolTimeoutMs: 45_000,
      models: [
        expect.objectContaining({
          provider: 'openai',
          providerId: 'openai-primary',
          temperature: 0.2,
          maxOutputTokens: 4096,
          maxContextTokens: 32000,
          requestTimeoutMs: 120_000,
          streamIdleTimeoutMs: 30_000,
          providerOptions,
          thinkingEnabled: true,
          thinkingBudget: 1024,
        }),
      ],
    });
    await expect(session.supportedModels()).resolves.toEqual([
      {
        id: 'default',
        name: 'gpt-5',
        provider: 'openai-primary',
      },
    ]);

    await session.close();
  });

  it('passes token budget options into agent runtime options', async () => {
    const tokenBudget = {
      maxTotalTokens: 1_000_000,
      warningThresholdPercent: 0.75,
      costPerInputToken: 0.0000001,
      costPerOutputToken: 0.0000005,
    };
    const session = await createSession({
      provider: { type: 'deepseek', apiKey: 'test-key' },
      model: 'deepseek-v4-pro',
      tokenBudget,
    });

    const [, agentOptions] = createAgent.mock.calls.at(-1) ?? [];
    expect(agentOptions).toEqual(
      expect.objectContaining({
        tokenBudget,
      }),
    );

    await session.close();
  });

  it('passes an instance-scoped provider registry to the Agent runtime', async () => {
    const providerRegistry = new ProviderRegistry();
    const session = await createSession({
      provider: {
        id: 'custom-provider',
        type: 'custom-api',
        apiKey: 'test-key',
      },
      providerRegistry,
      model: 'custom-model',
    });

    const [config, , deps] = createAgent.mock.calls.at(-1) ?? [];
    expect(config).toMatchObject({
      models: [
        expect.objectContaining({
          provider: 'custom-api',
          providerId: 'custom-provider',
        }),
      ],
    });
    expect(deps).toMatchObject({ providerRegistry });

    await session.close();
  });
});
