import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSessionStore } from '../../../../agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../../agent/subagents/BackgroundAgentManager.js';
import { SubagentRegistry } from '../../../../agent/subagents/SubagentRegistry.js';
import type { AgentExecutionContext, LoopOptions, LoopResult } from '../../../../agent/types.js';
import { NOOP_LOGGER } from '../../../../logging/Logger.js';
import { DurableExecutionLeaseError } from '../../../../session/events/DurableExecutionLeaseStore.js';
import { AgentId, SessionId } from '../../../../types/identifiers.js';
import type { JsonObject } from '../../../../types/json.js';
import type { ExecutionContext } from '../../../types/execution.js';
import { collectToolExecution } from '../../../types/result.js';
import type { Tool } from '../../../types/tool.js';
import { getBuiltinTools } from '../../index.js';
import { taskTool } from '../task.js';
import { taskCreateTool } from '../taskCreate.js';
import { taskGetTool } from '../taskGet.js';
import { taskListTool } from '../taskList.js';
import { taskStopTool } from '../taskStop.js';
import { taskUpdateTool } from '../taskUpdate.js';

const { streamChat, createAgent, destroyAgent } = vi.hoisted(() => ({
  streamChat:
    vi.fn<
      (
        message: string,
        context: AgentExecutionContext,
        options?: LoopOptions,
      ) => AsyncGenerator<never, LoopResult>
    >(),
  createAgent: vi.fn(),
  destroyAgent: vi.fn(async () => {}),
}));

createAgent.mockImplementation(async () => ({
  streamChat,
  destroy: destroyAgent,
}));

vi.mock('../../../../agent/Agent.js', () => ({
  Agent: {
    create: createAgent,
  },
}));

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

async function executeWithContext(
  tool: Tool,
  params: JsonObject,
  context: SessionId | Partial<ExecutionContext>,
) {
  return collectToolExecution(
    tool.execute(params, typeof context === 'string' ? { sessionId: context } : context),
  );
}

let manager: InstanceType<typeof BackgroundAgentManager>;

describe('task tools', () => {
  beforeEach(() => {
    createAgent.mockClear();
    streamChat.mockReset();
    destroyAgent.mockClear();
    const store = AgentSessionStore.create();
    manager = BackgroundAgentManager.create(NOOP_LOGGER, store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager.sealAndCancelAll();
  });

  it('registers all task management tools in builtin tools', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop']),
    );
  });

  it('creates, reads, updates, lists, stops, and deletes tasks in the runtime session', async () => {
    const runtimeSessionId = SessionId(`runtime-${Date.now()}`);

    expect(taskCreateTool.staticBehavior.kind).toBe('write');
    expect(taskGetTool.staticBehavior.kind).toBe('write');
    expect(taskUpdateTool.staticBehavior.kind).toBe('write');
    expect(taskListTool.staticBehavior.kind).toBe('write');
    expect(taskStopTool.staticBehavior.kind).toBe('write');

    const created = await executeWithContext(
      taskCreateTool,
      {
        subject: 'Implement task tools',
        description: 'Add all task management tools',
        activeForm: 'Implementing task tools',
        metadata: { source: 'test' },
      },
      runtimeSessionId,
    );

    expect(created.status).toBe('success');
    expect(created.model).toEqual({
      taskId: expect.any(String),
      task: expect.objectContaining({
        subject: 'Implement task tools',
        status: 'pending',
      }),
    });

    const taskId = (created.model as { taskId: string }).taskId;

    const fetched = await executeWithContext(taskGetTool, { taskId }, runtimeSessionId);
    expect(fetched.status).toBe('success');
    expect(fetched.model).toEqual(
      expect.objectContaining({
        id: taskId,
        subject: 'Implement task tools',
      }),
    );

    const updated = await executeWithContext(
      taskUpdateTool,
      {
        taskId,
        status: 'in_progress',
        owner: 'agent-1',
        addBlockedBy: ['dependency-1'],
      },
      runtimeSessionId,
    );
    expect(updated.status).toBe('success');
    expect(updated.model).toEqual(
      expect.objectContaining({
        id: taskId,
        status: 'in_progress',
        owner: 'agent-1',
        blockedBy: ['dependency-1'],
      }),
    );

    const listed = await executeWithContext(taskListTool, {}, runtimeSessionId);
    expect(listed.status).toBe('success');
    expect(listed.model).toEqual([
      {
        id: taskId,
        subject: 'Implement task tools',
        status: 'in_progress',
        owner: 'agent-1',
        blockedBy: ['dependency-1'],
      },
    ]);

    const stopped = await executeWithContext(
      taskStopTool,
      { taskId },
      {
        sessionId: runtimeSessionId,
        backgroundAgentManager: manager,
      },
    );
    expect(stopped.status).toBe('success');
    expect(stopped.model).toEqual(
      expect.objectContaining({
        id: taskId,
        status: 'completed',
        metadata: expect.objectContaining({
          stoppedAt: expect.any(String),
        }),
      }),
    );

    const deleted = await executeWithContext(
      taskUpdateTool,
      { taskId, status: 'deleted' },
      runtimeSessionId,
    );
    expect(deleted.status).toBe('success');
    expect(deleted.model).toEqual({
      taskId,
      deleted: true,
    });

    const listedAfterDelete = await executeWithContext(taskListTool, {}, runtimeSessionId);
    expect(listedAfterDelete.model).toEqual([]);
  });

  it('stops a running background agent via TaskStop and keeps it cancelled', async () => {
    streamChat.mockImplementationOnce(async function* (
      _message: string,
      _context: AgentExecutionContext,
      options?: LoopOptions,
    ) {
      yield* [];
      return await new Promise((resolve) => {
        options?.signal?.addEventListener(
          'abort',
          () =>
            resolve({
              success: false,
              error: { type: 'aborted', message: 'aborted' },
              metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
            }),
          { once: true },
        );
      });
    });

    const agentId = AgentId(
      await manager.startBackgroundAgent({
        config: subagentConfig,
        bladeConfig,
        description: 'Inspect repository',
        prompt: 'inspect',
      }),
    );

    const stopped = await executeWithContext(taskStopTool, { taskId: agentId }, {
      sessionId: SessionId(`runtime-${Date.now()}`),
      backgroundAgentManager: manager,
    } as never);

    expect(stopped.status).toBe('success');
    expect(stopped.metadata).toEqual(
      expect.objectContaining({
        stoppedBackgroundAgent: true,
      }),
    );
    expect(stopped.model).toEqual(
      expect.objectContaining({
        id: agentId,
        status: 'cancelled',
      }),
    );

    const session = await manager.waitForCompletion(agentId, 1000);
    expect(session?.status).toBe('cancelled');
  });

  it('uses the background agent manager provided by execution context', async () => {
    const fakeManager = {
      getAgent: vi.fn(() => ({ id: AgentId('agent-1'), status: 'running' })),
      killAgent: vi.fn(async () => true),
    };

    const stopped = await executeWithContext(taskStopTool, { taskId: 'agent-1' }, {
      sessionId: SessionId(`runtime-${Date.now()}`),
      backgroundAgentManager: fakeManager,
    } as never);

    expect(stopped.status).toBe('success');
    expect(fakeManager.getAgent).toHaveBeenCalledWith('agent-1');
    expect(fakeManager.killAgent).toHaveBeenCalledWith('agent-1');
  });

  it('reports an error when a running agent belongs to another execution', async () => {
    const session = {
      id: AgentId('agent-owned-elsewhere'),
      status: 'running',
    };
    const fakeManager = {
      getAgent: vi.fn(() => session),
      killAgent: vi.fn(async () => false),
    };

    const stopped = await executeWithContext(taskStopTool, { taskId: session.id }, {
      sessionId: SessionId(`runtime-${Date.now()}`),
      backgroundAgentManager: fakeManager,
    } as never);

    expect(stopped).toMatchObject({
      status: 'error',
      metadata: {
        stoppedBackgroundAgent: false,
      },
    });
  });

  it('propagates lease loss while starting a background agent', async () => {
    const registry = new SubagentRegistry();
    registry.register(subagentConfig);
    const leaseError = new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      'worker is stale',
    );
    const fakeManager = {
      startBackgroundAgent: vi.fn(async () => {
        throw leaseError;
      }),
    };

    await expect(
      executeWithContext(
        taskTool,
        {
          subagent_type: subagentConfig.name,
          description: 'Inspect repository',
          prompt: 'inspect code',
          run_in_background: true,
        },
        {
          sessionId: SessionId('stale-task-session'),
          bladeConfig,
          subagentRegistry: registry,
          backgroundAgentManager: fakeManager,
        } as never,
      ),
    ).rejects.toBe(leaseError);
  });
});
