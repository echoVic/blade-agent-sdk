import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import type { InternalLogger } from '../../logging/Logger.js';
import { McpRegistry } from '../../mcp/McpRegistry.js';
import { FileLockManager } from '../../tools/execution/FileLockManager.js';
import { SessionId, TurnId } from '../../types/identifiers.js';
import { Agent } from '../Agent.js';
import type { BladeConfig } from '../config.js';
import { RECONCILED_INITIAL_INPUT } from '../InitialInputPreparation.js';
import { BackgroundAgentManager } from '../subagents/BackgroundAgentManager.js';
import type { ChatContext, LoopOptions, UserMessageContent } from '../types.js';

function createExecutionPipeline() {
  return {
    getRegistry: () => ({
      getAll: () => [],
    }),
    getCatalog: () => undefined,
  };
}

function createLogger(): InternalLogger & { messages: string[] } {
  const messages: string[] = [];

  return {
    messages,
    child() {
      return this;
    },
    debug(...args: unknown[]) {
      messages.push(args.map((arg) => String(arg)).join(' '));
    },
    info() {},
    warn() {},
    error() {},
  };
}

describe('Agent.create', () => {
  it('throws an SDK-facing ConfigError when no model is configured', async () => {
    const creation = Agent.create({
      models: [],
      language: 'en-US',
    } as unknown as BladeConfig);

    await expect(creation).rejects.toBeInstanceOf(ConfigError);
    await expect(creation).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      message: 'No model configuration found. Provide at least one entry in config.models.',
    });
  });
});

describe('Agent lifecycle', () => {
  it('reports a clear error when initialized runtime methods are used before initialize()', async () => {
    const agent = new Agent(
      { models: [], language: 'en-US' } as unknown as BladeConfig,
      {},
      {
        executionPipeline: createExecutionPipeline() as never,
        runtimeManaged: true,
      },
    );
    const message = 'Agent is not initialized. Call initialize() before using this method.';
    const context: ChatContext = {
      messages: [],
      userId: 'test-user',
      sessionId: SessionId('test-session'),
    };

    await expect(agent.chat('test', context)).rejects.toThrow(message);
    expect(() => agent.streamChat('test', context)).toThrow(message);
    await expect(agent.runAgenticLoop('test', context)).rejects.toThrow(message);
    await expect(agent.chatWithSystem('system', 'test')).rejects.toThrow(message);
    expect(() => agent.clearSkillContext()).toThrow(message);
    expect(() => agent.getModelService()).toThrow(message);
    expect(() => agent.getTokenBudgetSnapshot()).toThrow(message);
    expect(() => agent.applyToolWhitelist([])).toThrow(message);
    await expect(agent.setModel('test')).rejects.toThrow(message);
    await expect(agent.getSystemPrompt()).rejects.toThrow(message);
  });

  it('closes resources created by the Agent exactly once', async () => {
    const disconnectAll = vi.spyOn(McpRegistry.prototype, 'disconnectAll').mockResolvedValue();
    const sealCancelAndWait = vi
      .spyOn(BackgroundAgentManager.prototype, 'sealCancelAndWait')
      .mockResolvedValue([]);
    const agent = new Agent(
      { models: [], language: 'en-US' } as unknown as BladeConfig,
      {},
      { executionPipeline: createExecutionPipeline() as never },
    );

    try {
      await Promise.all([agent.destroy(), agent.destroy()]);

      expect(disconnectAll).toHaveBeenCalledOnce();
      expect(sealCancelAndWait).toHaveBeenCalledOnce();
    } finally {
      disconnectAll.mockRestore();
      sealCancelAndWait.mockRestore();
    }
  });

  it('does not close caller-owned resources', async () => {
    const mcpRegistry = {
      disconnectAll: vi.fn(async () => {}),
    } as unknown as McpRegistry;
    const backgroundAgentManager = {
      sealCancelAndWait: vi.fn(async () => []),
    } as unknown as BackgroundAgentManager;
    const agent = new Agent(
      { models: [], language: 'en-US' } as unknown as BladeConfig,
      {},
      {
        executionPipeline: createExecutionPipeline() as never,
        mcpRegistry,
        backgroundAgentManager,
      },
    );

    await agent.destroy();

    expect(mcpRegistry.disconnectAll).not.toHaveBeenCalled();
    expect(backgroundAgentManager.sealCancelAndWait).not.toHaveBeenCalled();
  });

  it('aborts active runs so their file lock leases are released before destroy resolves', async () => {
    FileLockManager.resetInstance();
    const lockManager = FileLockManager.getInstance();
    const filePath = '/tmp/agent-destroy-lock';
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const runLoop = vi.fn(
      async (_message: string, _context: ChatContext, options?: LoopOptions) => {
        const lease = await lockManager.acquire(filePath);
        notifyStarted();
        return new Promise<{
          success: false;
          error: { type: 'aborted'; message: string };
        }>((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              lease.release();
              resolve({
                success: false,
                error: { type: 'aborted', message: 'Agent was destroyed' },
              });
            },
            { once: true },
          );
        });
      },
    );
    const backgroundAgentManager = {} as BackgroundAgentManager;
    const agent = new Agent(
      { models: [], language: 'en-US' } as unknown as BladeConfig,
      {},
      {
        executionPipeline: createExecutionPipeline() as never,
        runtimeManaged: true,
        backgroundAgentManager,
      },
    );
    Object.assign(agent as unknown as Record<string, unknown>, {
      isInitialized: true,
      loopRunner: { runLoop },
    });

    try {
      const run = agent.runAgenticLoop('test', {
        messages: [],
        userId: 'test-user',
        sessionId: SessionId('test-session'),
      });
      await started;
      expect(lockManager.isLocked(filePath)).toBe(true);

      await agent.destroy();

      expect(lockManager.isLocked(filePath)).toBe(false);
      await expect(run).resolves.toMatchObject({
        success: false,
        error: { type: 'aborted' },
      });
    } finally {
      FileLockManager.resetInstance();
    }
  });

  it('closes paused streams so their file lock leases are released before destroy resolves', async () => {
    FileLockManager.resetInstance();
    const lockManager = FileLockManager.getInstance();
    const filePath = '/tmp/agent-destroy-stream-lock';
    const runLoopStream = vi.fn(async function* () {
      const lease = await lockManager.acquire(filePath);
      try {
        yield { type: 'text_delta', text: 'started' };
        return {
          success: true,
          finalMessage: 'done',
        };
      } finally {
        lease.release();
      }
    });
    const agent = new Agent(
      { models: [], language: 'en-US' } as unknown as BladeConfig,
      { localDiscovery: false },
      {
        executionPipeline: createExecutionPipeline() as never,
        runtimeManaged: true,
        backgroundAgentManager: {} as BackgroundAgentManager,
      },
    );
    Object.assign(agent as unknown as Record<string, unknown>, {
      isInitialized: true,
      loopRunner: { runLoopStream },
    });

    try {
      const stream = agent.streamChat('test', {
        messages: [],
        userId: 'test-user',
        sessionId: SessionId('test-session'),
      });
      await stream.next();
      expect(lockManager.isLocked(filePath)).toBe(true);

      await agent.destroy();

      expect(lockManager.isLocked(filePath)).toBe(false);
    } finally {
      FileLockManager.resetInstance();
    }
  });
});

describe('Agent.initializeSystemPrompt', () => {
  it('logs prompt sources for runtime base prompt and append content', async () => {
    const logger = createLogger();
    const agent = new Agent(
      { models: [], language: 'en-US' } as unknown as BladeConfig,
      {
        systemPrompt: 'BASE PROMPT',
        appendSystemPrompt: 'APPEND PROMPT',
      },
      {
        executionPipeline: createExecutionPipeline() as never,
        runtimeManaged: true,
        logger,
        defaultContext: {
          capabilities: {
            filesystem: {
              roots: ['/workspace'],
              cwd: '/workspace',
            },
          },
        },
      },
    );

    await (
      agent as unknown as { initializeSystemPrompt(): Promise<void> }
    ).initializeSystemPrompt();

    expect(
      logger.messages.some((message) =>
        message.includes('[SystemPrompt] 可用来源: base_prompt, append'),
      ),
    ).toBe(true);
  });
});

describe('Agent input preparation', () => {
  it('does not repeat initial preparation for a reconciled recovery input', async () => {
    const agent = new Agent(
      { models: [], language: 'en-US' } as unknown as BladeConfig,
      {},
      {
        executionPipeline: createExecutionPipeline() as never,
        runtimeManaged: true,
      },
    );
    const testable = agent as unknown as {
      isInitialized: boolean;
      prepareMessageForContext(
        message: UserMessageContent,
        context: ChatContext,
      ): Promise<UserMessageContent>;
      discoverSkillsForCwd(cwd?: string): Promise<void>;
      prepareContext(
        message: UserMessageContent,
        context: ChatContext,
        options?: LoopOptions,
      ): Promise<{ enhancedMessage: UserMessageContent }>;
    };
    testable.isInitialized = true;
    const prepare = vi
      .spyOn(testable, 'prepareMessageForContext')
      .mockResolvedValue('prepared again');
    const discover = vi.spyOn(testable, 'discoverSkillsForCwd').mockResolvedValue();
    const context: ChatContext = {
      messages: [],
      userId: 'test-user',
      sessionId: SessionId('recovered-session'),
      snapshot: {
        sessionId: SessionId('recovered-session'),
        turnId: TurnId('recovered-turn'),
        context: {
          capabilities: {
            filesystem: {
              roots: ['/recovered/workspace'],
              cwd: '/recovered/workspace',
            },
          },
        },
        filesystemRoots: ['/recovered/workspace'],
        cwd: '/recovered/workspace',
        environment: {},
      },
    };

    const recovered = await testable.prepareContext('already prepared', context, {
      initialInputPreparation: RECONCILED_INITIAL_INPUT,
    });
    const ordinary = await testable.prepareContext('needs preparation', context);

    expect(recovered.enhancedMessage).toBe('already prepared');
    expect(ordinary.enhancedMessage).toBe('prepared again');
    expect(discover).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledWith('/recovered/workspace');
    expect(prepare).toHaveBeenCalledOnce();
  });
});
