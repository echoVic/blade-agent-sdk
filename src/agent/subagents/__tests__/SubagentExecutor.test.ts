import { describe, expect, it, vi } from 'vitest';
import { createContextSnapshot } from '../../../runtime/index.js';
import { ProviderRegistry } from '../../../services/ProviderRegistry.js';
import { ExecutionLeaseId, FencingToken, SessionId } from '../../../types/branded.js';

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
    const controller = new AbortController();
    const assertExecutionLease = vi.fn(async () => {});
    const runWithExecutionLease = async <T>(
      operation: () => Promise<T>,
    ): Promise<T> => operation();

    await executor.execute({
      prompt: 'inspect',
      parentSessionId: 'parent-session',
      snapshot,
      signal: controller.signal,
      executionFence: {
        leaseId: ExecutionLeaseId('lease-1'),
        fencingToken: FencingToken(7),
      },
      assertExecutionLease,
      runWithExecutionLease,
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
        executionFence: {
          leaseId: 'lease-1',
          fencingToken: 7,
        },
        assertExecutionLease,
        runWithExecutionLease,
      }),
      expect.objectContaining({
        signal: controller.signal,
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

  it('inherits model and tool middleware from the parent Session runtime', async () => {
    const modelMiddleware = {};
    const toolMiddleware = vi.fn();
    const providerRegistry = new ProviderRegistry();
    const backgroundAgentManager = {
      getMiddleware: () => ({
        model: [modelMiddleware],
        tool: [toolMiddleware],
      }),
      getProviderRegistry: () => providerRegistry,
    };
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
      undefined,
      backgroundAgentManager as never,
    );

    await executor.execute({
      prompt: 'inspect',
      parentSessionId: 'parent-session',
    });

    expect(createAgent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        modelMiddleware: [modelMiddleware],
        toolMiddleware: [toolMiddleware],
        providerRegistry,
      }),
    );
  });
});
