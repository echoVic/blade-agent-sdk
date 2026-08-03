import { describe, expect, it, vi } from 'vitest';
import type { SubagentBladeConfig } from '@blade-ai/agent-sdk/subagents';
import { createContextSnapshot } from '../../../runtime/index.js';
import { SessionId } from '../../../types/branded.js';

const { SubagentExecutor } = await import('../SubagentExecutor.js');

function createBladeConfig(): SubagentBladeConfig {
  return {
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
  };
}

describe('SubagentExecutor', () => {
  it('delegates execution to the injected runner with config and context', async () => {
    const runner = vi.fn(async () => ({
      success: true,
      message: 'done',
      agentId: 'agent-1',
    }));

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
      { name: 'research', description: 'Research subagent' },
      createBladeConfig(),
      undefined,
      runner,
    );

    const result = await executor.execute({
      prompt: 'inspect',
      parentSessionId: 'parent-session',
      snapshot,
    });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { name: 'research', description: 'Research subagent' },
        bladeConfig: createBladeConfig(),
        context: expect.objectContaining({
          prompt: 'inspect',
          parentSessionId: 'parent-session',
          snapshot,
        }),
        agentId: expect.any(String),
        systemPrompt: expect.any(String),
      }),
    );
    expect(result).toEqual({
      success: true,
      message: 'done',
      agentId: 'agent-1',
    });
  });

  it('wraps runner failures into a failed result', async () => {
    const runner = vi.fn(async () => {
      throw new Error('subagent crashed');
    });

    const executor = new SubagentExecutor(
      { name: 'research', description: 'Research subagent' },
      createBladeConfig(),
      undefined,
      runner,
    );

    const result = await executor.execute({
      prompt: 'inspect',
      parentSessionId: 'parent-session',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('subagent crashed');
  });
});
