import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../../../logging/Logger.js';
import { getBuiltinTools } from '../../index.js';
import type { ChatContext, LoopOptions } from '../../../../agent/types.js';
import { AgentSessionStore } from '../../../../agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../../agent/subagents/BackgroundAgentManager.js';
import { AgentId, SessionId } from '../../../../types/branded.js';
import {
  collectToolExecution,
  type ExecutionContext,
  type Tool,
} from '../../../types/index.js';
import { createTaskCreateTool } from '../taskCreate.js';
import { createTaskGetTool } from '../taskGet.js';
import { createTaskListTool } from '../taskList.js';
import { createTaskStopTool } from '../taskStop.js';
import { createTaskUpdateTool } from '../taskUpdate.js';

const { runAgenticLoop, createAgent } = vi.hoisted(() => ({
  runAgenticLoop: vi.fn<
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
  >(),
  createAgent: vi.fn(),
}));

createAgent.mockImplementation(async () => ({
  runAgenticLoop,
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

async function executeWithContext<TParams>(
  tool: Tool<TParams>,
  params: TParams,
  context: SessionId | Partial<ExecutionContext>,
) {
  return collectToolExecution(
    tool.build(params).execute(
      new AbortController().signal,
      typeof context === 'string' ? { sessionId: context } : context,
    ),
  );
}

let manager: InstanceType<typeof BackgroundAgentManager>;

describe('task tools', () => {
  beforeEach(() => {
    createAgent.mockClear();
    runAgenticLoop.mockReset();
    const store = AgentSessionStore.create();
    manager = BackgroundAgentManager.create(NOOP_LOGGER, store);
  });

  afterEach(() => {
    manager.killAll();
  });

  it('registers all task management tools in builtin tools', async () => {
    const tools = await getBuiltinTools({ sessionId: SessionId(`builtin-${Date.now()}`) });
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'TaskCreate',
        'TaskGet',
        'TaskUpdate',
        'TaskList',
        'TaskStop',
      ])
    );
  });

  it('creates, reads, updates, lists, stops, and deletes tasks in the runtime session', async () => {
    const runtimeSessionId = SessionId(`runtime-${Date.now()}`);
    const factorySessionId = SessionId(`factory-${Date.now()}`);
    const createTool = createTaskCreateTool({ sessionId: factorySessionId });
    const getTool = createTaskGetTool({ sessionId: factorySessionId });
    const updateTool = createTaskUpdateTool({ sessionId: factorySessionId });
    const listTool = createTaskListTool({ sessionId: factorySessionId });
    const stopTool = createTaskStopTool({ sessionId: factorySessionId });

    expect(createTool.kind).toBe('write');
    expect(getTool.kind).toBe('write');
    expect(updateTool.kind).toBe('write');
    expect(listTool.kind).toBe('write');
    expect(stopTool.kind).toBe('write');

    const created = await executeWithContext(
      createTool,
      {
        subject: 'Implement task tools',
        description: 'Add all task management tools',
        activeForm: 'Implementing task tools',
        metadata: { source: 'test' },
      },
      runtimeSessionId
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

    const fetched = await executeWithContext(getTool, { taskId }, runtimeSessionId);
    expect(fetched.status).toBe('success');
    expect(fetched.model).toEqual(
      expect.objectContaining({
        id: taskId,
        subject: 'Implement task tools',
      })
    );

    const updated = await executeWithContext(
      updateTool,
      {
        taskId,
        status: 'in_progress',
        owner: 'agent-1',
        addBlockedBy: ['dependency-1'],
      },
      runtimeSessionId
    );
    expect(updated.status).toBe('success');
    expect(updated.model).toEqual(
      expect.objectContaining({
        id: taskId,
        status: 'in_progress',
        owner: 'agent-1',
        blockedBy: ['dependency-1'],
      })
    );

    const listed = await executeWithContext(listTool, {}, runtimeSessionId);
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

    const stopped = await executeWithContext(stopTool, { taskId }, runtimeSessionId);
    expect(stopped.status).toBe('success');
    expect(stopped.model).toEqual(
      expect.objectContaining({
        id: taskId,
        status: 'completed',
        metadata: expect.objectContaining({
          stoppedAt: expect.any(String),
        }),
      })
    );

    const deleted = await executeWithContext(
      updateTool,
      { taskId, status: 'deleted' },
      runtimeSessionId
    );
    expect(deleted.status).toBe('success');
    expect(deleted.model).toEqual({
      taskId,
      deleted: true,
    });

    const listedAfterDelete = await executeWithContext(listTool, {}, runtimeSessionId);
    expect(listedAfterDelete.model).toEqual([]);
  });

  it('stops a running background agent via TaskStop and keeps it cancelled', async () => {
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

    const agentId = AgentId(manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Inspect repository',
      prompt: 'inspect',
    }));

    const stopTool = createTaskStopTool({ sessionId: SessionId(`factory-${Date.now()}`) });
    const stopped = await executeWithContext(
      stopTool,
      { taskId: agentId },
      {
        sessionId: SessionId(`runtime-${Date.now()}`),
        backgroundAgentManager: manager,
      } as never,
    );

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
    const stopTool = createTaskStopTool({ sessionId: SessionId(`factory-${Date.now()}`) });
    const fakeManager = {
      getAgent: vi.fn(() => ({ id: AgentId('agent-1'), status: 'running' })),
      killAgent: vi.fn(() => true),
    };

    const stopped = await executeWithContext(
      stopTool,
      { taskId: 'agent-1' },
      {
        sessionId: SessionId(`runtime-${Date.now()}`),
        backgroundAgentManager: fakeManager,
      } as never,
    );

    expect(stopped.status).toBe('success');
    expect(fakeManager.getAgent).toHaveBeenCalledWith('agent-1');
    expect(fakeManager.killAgent).toHaveBeenCalledWith('agent-1');
  });
});
