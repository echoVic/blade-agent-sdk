import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../../logging/Logger.js';
import { createContextSnapshot } from '../../../runtime/index.js';
import { AgentSessionStore } from '../AgentSessionStore.js';

const runAgenticLoop = vi.fn(async () => ({
  success: true,
  finalMessage: 'done',
  metadata: {
    toolCallsCount: 0,
    tokensUsed: 0,
  },
}));

const createAgent = vi.fn(async (_config, _options, deps) => ({
  runAgenticLoop,
  deps,
}));

vi.mock('../../Agent.js', () => ({
  Agent: {
    create: createAgent,
  },
}));

const { BackgroundAgentManager } = await import('../BackgroundAgentManager.js');

const bladeConfig = {
  models: [
    {
      id: 'default',
      name: 'gpt-4o-mini',
      provider: 'openai-compatible' as const,
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
    },
  ],
  currentModelId: 'default',
};

const subagentConfig = {
  name: 'research',
  description: 'Research subagent',
};

describe('BackgroundAgentManager', () => {
  beforeEach(() => {
    createAgent.mockClear();
    runAgenticLoop.mockClear();
    AgentSessionStore.resetInstance();
    BackgroundAgentManager.getInstance(NOOP_LOGGER).setLogger(NOOP_LOGGER);
  });

  afterEach(() => {
    const manager = BackgroundAgentManager.getInstance(NOOP_LOGGER);
    manager.killAll();
    AgentSessionStore.resetInstance();
    manager.setLogger(NOOP_LOGGER);
  });

  it('inherits the parent snapshot context when starting a background subagent', async () => {
    const manager = BackgroundAgentManager.getInstance(NOOP_LOGGER);
    const snapshot = createContextSnapshot('parent-session', 'turn-1', {
      capabilities: {
        filesystem: {
          roots: ['/parent-root'],
          cwd: '/parent-root',
        },
      },
      environment: {
        TEST_ENV: '1',
      },
    });

    const agentId = manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Inspect repo',
      prompt: 'inspect',
      snapshot,
    });

    await manager.waitForCompletion(agentId, 1000);

    expect(createAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        defaultContext: snapshot.context,
      }),
    );
  });

  it('updates the session description when resuming with a new description', async () => {
    const manager = BackgroundAgentManager.getInstance(NOOP_LOGGER);
    const agentId = manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Original description',
      prompt: 'inspect',
    });

    await manager.waitForCompletion(agentId, 1000);

    const resumedId = manager.resumeAgent(
      agentId,
      'follow up',
      subagentConfig,
      bladeConfig,
      undefined,
      undefined,
      undefined,
      'Updated description',
    );

    expect(resumedId).toBe(agentId);
    expect(manager.getAgent(agentId)?.description).toBe('Updated description');

    await manager.waitForCompletion(agentId, 1000);
  });
});
