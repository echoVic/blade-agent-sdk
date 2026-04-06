import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../../../logging/Logger.js';
import { getBuiltinTools } from '../../index.js';
import type { ChatContext, LoopOptions } from '../../../../agent/types.js';
import { AgentSessionStore } from '../../../../agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../../agent/subagents/BackgroundAgentManager.js';
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
  tool: {
    build: (params: TParams) => {
      execute: (
        signal: AbortSignal,
        updateOutput?: (output: string) => void,
        context?: { sessionId?: string }
      ) => Promise<Awaited<ReturnType<ReturnType<typeof createTaskCreateTool>['execute']>>>;
    };
  },
  params: TParams,
  sessionId: string
) {
  return tool.build(params).execute(new AbortController().signal, undefined, {
    sessionId,
  });
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
    const tools = await getBuiltinTools({ sessionId: `builtin-${Date.now()}` });
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
    const runtimeSessionId = `runtime-${Date.now()}`;
    const factorySessionId = `factory-${Date.now()}`;
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

    expect(created.success).toBe(true);
    expect(created.llmContent).toEqual({
      taskId: expect.any(String),
      task: expect.objectContaining({
        subject: 'Implement task tools',
        status: 'pending',
      }),
    });

    const taskId = (created.llmContent as { taskId: string }).taskId;

    const fetched = await executeWithContext(getTool, { taskId }, runtimeSessionId);
    expect(fetched.success).toBe(true);
    expect(fetched.llmContent).toEqual(
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
    expect(updated.success).toBe(true);
    expect(updated.llmContent).toEqual(
      expect.objectContaining({
        id: taskId,
        status: 'in_progress',
        owner: 'agent-1',
        blockedBy: ['dependency-1'],
      })
    );

    const listed = await executeWithContext(listTool, {}, runtimeSessionId);
    expect(listed.success).toBe(true);
    expect(listed.llmContent).toEqual([
      {
        id: taskId,
        subject: 'Implement task tools',
        status: 'in_progress',
        owner: 'agent-1',
        blockedBy: ['dependency-1'],
      },
    ]);

    const stopped = await executeWithContext(stopTool, { taskId }, runtimeSessionId);
    expect(stopped.success).toBe(true);
    expect(stopped.llmContent).toEqual(
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
    expect(deleted.success).toBe(true);
    expect(deleted.llmContent).toEqual({
      taskId,
      deleted: true,
    });

    const listedAfterDelete = await executeWithContext(listTool, {}, runtimeSessionId);
    expect(listedAfterDelete.llmContent).toEqual([]);
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

    const agentId = manager.startBackgroundAgent({
      config: subagentConfig,
      bladeConfig,
      description: 'Inspect repository',
      prompt: 'inspect',
    });

    const stopTool = createTaskStopTool({ sessionId: `factory-${Date.now()}` });
    const stopped = await stopTool.build({ taskId: agentId }).execute(
      new AbortController().signal,
      undefined,
      {
        sessionId: `runtime-${Date.now()}`,
        backgroundAgentManager: manager,
      } as never,
    );

    expect(stopped.success).toBe(true);
    expect(stopped.metadata).toEqual(
      expect.objectContaining({
        stoppedBackgroundAgent: true,
      }),
    );
    expect(stopped.llmContent).toEqual(
      expect.objectContaining({
        id: agentId,
        status: 'cancelled',
      }),
    );

    const session = await manager.waitForCompletion(agentId, 1000);
    expect(session?.status).toBe('cancelled');
  });

  it('uses the background agent manager provided by execution context', async () => {
    const stopTool = createTaskStopTool({ sessionId: `factory-${Date.now()}` });
    const fakeManager = {
      getAgent: vi.fn(() => ({ id: 'agent-1', status: 'running' })),
      killAgent: vi.fn(() => true),
    };

    const stopped = await stopTool.build({ taskId: 'agent-1' }).execute(
      new AbortController().signal,
      undefined,
      {
        sessionId: `runtime-${Date.now()}`,
        backgroundAgentManager: fakeManager,
      } as never,
    );

    expect(stopped.success).toBe(true);
    expect(fakeManager.getAgent).toHaveBeenCalledWith('agent-1');
    expect(fakeManager.killAgent).toHaveBeenCalledWith('agent-1');
  });
});
