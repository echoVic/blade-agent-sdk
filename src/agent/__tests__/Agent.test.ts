import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../Agent.js';
import type {
  ChatContext,
  LoopOptions,
  UserMessageContent,
} from '../types.js';
import type { BladeConfig } from '../../types/common.js';
import type { InternalLogger } from '../../logging/Logger.js';
import { SessionId } from '../../types/branded.js';

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

    await (agent as unknown as { initializeSystemPrompt(): Promise<void> }).initializeSystemPrompt();

    expect(
      logger.messages.some((message) => message.includes('[SystemPrompt] 可用来源: base_prompt, append'))
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
    const context: ChatContext = {
      messages: [],
      userId: 'test-user',
      sessionId: SessionId('recovered-session'),
    };

    const recovered = await testable.prepareContext('already prepared', context, {
      initialInputPreparation: 'reconciled',
    });
    const ordinary = await testable.prepareContext('needs preparation', context);

    expect(recovered.enhancedMessage).toBe('already prepared');
    expect(ordinary.enhancedMessage).toBe('prepared again');
    expect(prepare).toHaveBeenCalledOnce();
  });
});
