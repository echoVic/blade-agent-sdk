import { access, readFile, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../../logging/Logger.js';
import { createContextSnapshot } from '../../../runtime/index.js';
import { ProviderRegistry } from '../../../services/ProviderRegistry.js';
import { DurableExecutionLeaseError } from '../../../session/events/DurableExecutionLeaseStore.js';
import {
  AgentId,
  ExecutionLeaseId,
  FencingToken,
  SessionId,
} from '../../../types/branded.js';
import type { ChatContext, LoopOptions } from '../../types.js';
import { AgentSessionStore } from '../AgentSessionStore.js';

const runAgenticLoop = vi.fn<
  (message: string, context: ChatContext, options?: LoopOptions) => Promise<{
    success: boolean;
    finalMessage?: string;
    error?: { message?: string };
    metadata?: {
      toolCallsCount?: number;
      tokensUsed?: number;
      duration?: number;
    };
  }>
>(async () => ({
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

let manager: InstanceType<typeof BackgroundAgentManager>;

describe('BackgroundAgentManager', () => {
  beforeEach(() => {
    createAgent.mockClear();
    runAgenticLoop.mockClear();
    const store = AgentSessionStore.create();
    manager = BackgroundAgentManager.create(NOOP_LOGGER, store);
  });

  afterEach(() => {
    manager.killAll();
  });

  it('inherits the parent snapshot context when starting a background subagent', async () => {
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

    const agentId = AgentId(await manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Inspect repo',
      prompt: 'inspect',
      snapshot,
    }));

    await manager.waitForCompletion(agentId, 1000);

    expect(createAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        backgroundAgentManager: manager,
        defaultContext: snapshot.context,
      }),
    );
  });

  it('propagates Session middleware into background subagents', async () => {
    const modelMiddleware = {};
    const toolMiddleware = vi.fn();
    const providerRegistry = new ProviderRegistry();
    const managerWithMiddleware = BackgroundAgentManager.create(
      NOOP_LOGGER,
      AgentSessionStore.create(),
      SessionId('middleware-owner'),
      {
        model: [modelMiddleware],
        tool: [toolMiddleware],
      },
      providerRegistry,
    );

    const agentId = AgentId(await managerWithMiddleware.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Inspect repo',
      prompt: 'inspect',
    }));
    await managerWithMiddleware.waitForCompletion(agentId, 1000);

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

  it('updates the session description when resuming with a new description', async () => {
    const agentId = AgentId(await manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Original description',
      prompt: 'inspect',
    }));

    await manager.waitForCompletion(agentId, 1000);

    const resumedId = await manager.resumeAgent(
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

  it('maintains separate lifecycle and work controllers for a running agent', async () => {
    runAgenticLoop.mockImplementationOnce(
      async (
        _message: string,
        _context: ChatContext,
        options?: LoopOptions,
      ) =>
        await new Promise((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () =>
              resolve({
                success: false,
                error: { message: 'aborted' },
                metadata: { duration: 0 },
              }),
            { once: true },
          );
        }),
    );

    const agentId = AgentId(await manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Long running task',
      prompt: 'inspect',
    }));

    const runtime = (manager as unknown as {
      runningAgents: Map<string, {
        lifecycleController: AbortController;
        workController: AbortController;
      }>;
    }).runningAgents.get(agentId);

    expect(runtime).toBeDefined();
    expect(runtime?.lifecycleController).toBeInstanceOf(AbortController);
    expect(runtime?.workController).toBeInstanceOf(AbortController);
    expect(runtime?.lifecycleController).not.toBe(runtime?.workController);

    await vi.waitFor(() => expect(runAgenticLoop).toHaveBeenCalled());
    await manager.killAgent(agentId);

    expect(runtime?.lifecycleController.signal.aborted).toBe(true);
    expect(runtime?.workController.signal.aborted).toBe(true);
    await manager.waitForCompletion(agentId, 1000);
  });

  it('preserves cancelled status after killing a running agent', async () => {
    runAgenticLoop.mockImplementationOnce(
      async (
        _message: string,
        _context: ChatContext,
        options?: LoopOptions,
      ) =>
        await new Promise((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () =>
              resolve({
                success: false,
                error: { message: 'aborted' },
                metadata: { duration: 0 },
              }),
            { once: true },
          );
        }),
    );

    const agentId = AgentId(await manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Long running task',
      prompt: 'inspect',
    }));

    await vi.waitFor(() => expect(runAgenticLoop).toHaveBeenCalled());
    await expect(manager.killAgent(agentId)).resolves.toBe(true);

    const session = await manager.waitForCompletion(agentId, 1000);
    expect(session?.status).toBe('cancelled');
  });

  it('seals new admissions only after all background agents settle', async () => {
    runAgenticLoop.mockImplementationOnce(
      async (
        _message: string,
        _context: ChatContext,
        options?: LoopOptions,
      ) =>
        await new Promise((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () =>
              resolve({
                success: false,
                error: { message: 'aborted' },
                metadata: { duration: 0 },
              }),
            { once: true },
          );
        }),
    );

    const agentId = AgentId(await manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Handoff blocker',
      prompt: 'inspect',
    }));

    expect(manager.getActiveAgentIds()).toEqual([agentId]);
    await vi.waitFor(() => expect(runAgenticLoop).toHaveBeenCalled());
    await expect(manager.killAgent(agentId)).resolves.toBe(true);
    await manager.waitForCompletion(agentId, 1000);

    expect(manager.getActiveAgentIds()).toEqual([]);
    manager.sealForHandoff();
    await expect(
      manager.startBackgroundAgent({
        config: subagentConfig,
        bladeConfig,
        description: 'Rejected after handoff seal',
        prompt: 'inspect',
      }),
    ).rejects.toThrow('Background agent admission is closed for Session handoff');
  });

  it('seals admission and cancels every running agent after ownership loss', async () => {
    runAgenticLoop.mockImplementationOnce(
      async (
        _message: string,
        _context: ChatContext,
        options?: LoopOptions,
      ) =>
        await new Promise((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () =>
              resolve({
                success: false,
                error: { message: 'ownership lost' },
                metadata: { duration: 0 },
              }),
            { once: true },
          );
        }),
    );
    const agentId = AgentId(await manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Lease-owned work',
      prompt: 'inspect',
    }));
    await vi.waitFor(() => expect(runAgenticLoop).toHaveBeenCalled());

    await expect(manager.sealCancelAndWait()).resolves.toEqual([agentId]);
    expect(manager.getAgent(agentId)?.status).toBe('cancelled');
    expect(manager.getActiveAgentIds()).toEqual([]);
    await expect(
      manager.startBackgroundAgent({
        config: subagentConfig,
        bladeConfig,
        description: 'Rejected after ownership loss',
        prompt: 'inspect',
      }),
    ).rejects.toThrow('Background agent admission is closed');
  });

  it('fails cleanup closed when a background agent misses the shutdown deadline', async () => {
    let finishExecution: (() => void) | undefined;
    runAgenticLoop.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishExecution = resolve;
      });
      return { success: false, error: { message: 'cancelled late' } };
    });
    const agentId = AgentId(await manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Unresponsive work',
      prompt: 'inspect',
    }));
    await vi.waitFor(() => expect(runAgenticLoop).toHaveBeenCalled());

    await expect(manager.sealCancelAndWait(10)).rejects.toThrow(
      `Timed out waiting for background agents to stop: ${agentId}`,
    );
    expect(manager.getActiveAgentIds()).toEqual([agentId]);

    finishExecution?.();
    await manager.waitForCompletion(agentId, 0);
  });

  it('prevents a stale owner from overwriting successor state or output', async () => {
    const store = AgentSessionStore.create();
    const oldManager = BackgroundAgentManager.create(
      NOOP_LOGGER,
      store,
      SessionId('root-session'),
    );
    const successorManager = BackgroundAgentManager.create(
      NOOP_LOGGER,
      store,
      SessionId('root-session'),
    );
    const agentId = AgentId('shared-agent');
    const staleFence = {
      leaseId: ExecutionLeaseId('stale-lease'),
      fencingToken: FencingToken(1),
    };
    const successorFence = {
      leaseId: ExecutionLeaseId('successor-lease'),
      fencingToken: FencingToken(2),
    };
    let activeToken = 1;
    const boundary = (token: number) =>
      async <T>(operation: () => Promise<T>): Promise<T> => {
        if (activeToken !== token) {
          throw new DurableExecutionLeaseError(
            'DURABLE_EXECUTION_LEASE_LOST',
            `Execution token ${token} is stale`,
          );
        }
        return operation();
      };
    let finishOld: (() => void) | undefined;
    let finishSuccessor: (() => void) | undefined;
    runAgenticLoop
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finishOld = resolve;
        });
        return { success: true, finalMessage: 'stale result' };
      })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finishSuccessor = resolve;
        });
        return { success: true, finalMessage: 'successor result' };
      });

    await oldManager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Stale execution',
      prompt: 'inspect',
      agentId,
      executionFence: staleFence,
      assertExecutionLease: async () => {
        await boundary(1)(async () => {});
      },
      runWithExecutionLease: boundary(1),
    });
    await vi.waitFor(() => expect(runAgenticLoop).toHaveBeenCalledTimes(1));
    const staleOutputFile = store.loadSession(agentId)?.outputFile;

    activeToken = 2;
    await successorManager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Successor execution',
      prompt: 'continue',
      agentId,
      executionFence: successorFence,
      assertExecutionLease: async () => {
        await boundary(2)(async () => {});
      },
      runWithExecutionLease: boundary(2),
    });
    await vi.waitFor(() => expect(runAgenticLoop).toHaveBeenCalledTimes(2));
    const successorOutputFile = store.loadSession(agentId)?.outputFile;
    expect(successorOutputFile).not.toBe(staleOutputFile);

    finishOld?.();
    await oldManager.waitForCompletion(agentId, 0);
    expect(store.loadSession(agentId)).toMatchObject({
      description: 'Successor execution',
      status: 'running',
      executionFence: successorFence,
      outputFile: successorOutputFile,
    });
    if (staleOutputFile) {
      await expect(access(staleOutputFile)).rejects.toThrow();
    }

    finishSuccessor?.();
    await successorManager.waitForCompletion(agentId, 0);
    expect(store.loadSession(agentId)).toMatchObject({
      status: 'completed',
      result: {
        success: true,
        message: 'successor result',
      },
      executionFence: successorFence,
      outputFile: successorOutputFile,
    });
    if (successorOutputFile) {
      await expect(readFile(successorOutputFile, 'utf8')).resolves.toContain(
        'successor result',
      );
      await rm(successorOutputFile, { force: true });
    }
  });
});
