import { describe, expect, it } from 'bun:test';
import { Agent } from '../Agent.js';
import type { BladeConfig } from '../../types/common.js';
import type { InternalLogger } from '../../logging/Logger.js';

function createExecutionPipeline() {
  return {
    getRegistry: () => ({
      getAll: () => [],
    }),
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
