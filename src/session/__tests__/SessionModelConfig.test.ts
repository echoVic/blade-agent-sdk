import { describe, expect, it, vi } from 'vitest';

const createAgent = vi.fn(async () => ({
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
      provider: { type: 'openai', apiKey: 'test-key' },
      model: 'gpt-5',
      temperature: 0.2,
      maxOutputTokens: 4096,
      maxContextTokens: 32000,
      providerOptions,
      thinkingEnabled: true,
      thinkingBudget: 1024,
    });

    const [config] = createAgent.mock.calls.at(-1) ?? [];
    expect(config).toMatchObject({
      temperature: 0.2,
      models: [
        expect.objectContaining({
          temperature: 0.2,
          maxOutputTokens: 4096,
          maxContextTokens: 32000,
          providerOptions,
          thinkingEnabled: true,
          thinkingBudget: 1024,
        }),
      ],
    });

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
});
