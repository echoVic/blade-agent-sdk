import { describe, expect, it, vi } from 'vitest';
import { createContextSnapshot } from '../../../runtime/index.js';
import { SessionId } from '../../../types/branded.js';

const runAgenticLoop = vi.fn(async () => ({
  success: true,
  finalMessage: 'done',
  metadata: {
    toolCallsCount: 0,
    tokensUsed: 0,
  },
}));

const createAgent = vi.fn(async (_config: unknown, _options: unknown, deps: unknown) => ({
  runAgenticLoop,
  deps,
}));

vi.mock('../../Agent.js', () => ({
  Agent: {
    create: createAgent,
  },
}));

const { SubagentExecutor } = await import('../SubagentExecutor.js');

describe('SubagentExecutor', () => {
  it('should inherit the parent snapshot context when creating a subagent', async () => {
    const snapshot = createContextSnapshot(SessionId('parent-session'), 'turn-1', {
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

    const executor = new SubagentExecutor(
      {
        name: 'research',
        description: 'Research subagent',
      },
      {
        models: [
          {
            id: 'default',
            name: 'gpt-4o-mini',
            provider: 'openai-compatible',
            model: 'gpt-4o-mini',
            apiKey: 'test-key',
            baseUrl: 'https://example.com',
          },
        ],
        currentModelId: 'default',
      },
    );

    await executor.execute({
      prompt: 'inspect',
      parentSessionId: 'parent-session',
      snapshot,
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        defaultContext: snapshot.context,
      }),
    );
    expect(runAgenticLoop).toHaveBeenCalledWith(
      'inspect',
      expect.objectContaining({
        snapshot,
      }),
    );
  });

  it('passes configured context omissions into the child agent context', async () => {
    const executor = new SubagentExecutor(
      {
        name: 'Explore',
        description: 'Explore subagent',
        omitEnvironment: true,
      },
      {
        models: [
          {
            id: 'default',
            name: 'gpt-4o-mini',
            provider: 'openai-compatible',
            model: 'gpt-4o-mini',
            apiKey: 'test-key',
            baseUrl: 'https://example.com',
          },
        ],
        currentModelId: 'default',
      },
    );

    await executor.execute({
      prompt: 'inspect',
      parentSessionId: 'parent-session',
    });

    expect(runAgenticLoop).toHaveBeenCalledWith(
      'inspect',
      expect.objectContaining({
        omitEnvironment: true,
      }),
    );
  });
});
