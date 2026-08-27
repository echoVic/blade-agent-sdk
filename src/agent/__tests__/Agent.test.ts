import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import type { InternalLogger } from '../../logging/Logger.js';
import { SessionId, TurnId } from '../../types/identifiers.js';
import { Agent } from '../Agent.js';
import type { BladeConfig } from '../config.js';
import { RECONCILED_INITIAL_INPUT } from '../InitialInputPreparation.js';
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
