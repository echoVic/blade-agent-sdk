import { describe, expect, it } from 'vitest';
import {
  handleAgentLoopRunTurnWithRecovery,
  type AgentLoopRunTurnInput,
} from '../loop/index.js';
import { createAgentRecoveryAttemptTracker } from '../recovery/index.js';

describe('agent loop run-turn recovery orchestration', () => {
  it('builds run-turn input, forwards stream events, and returns the successful turn result', async () => {
    const operations: unknown[] = [];
    const response = {
      content: 'done',
      usage: { totalTokens: 7 },
    };
    const streamingExecutionResults = [
      {
        toolCall: {
          id: 'read-call',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        },
        result: { success: true, llmContent: 'read complete' },
        toolUseUuid: 'tool-use-1',
      },
    ];

    const generator = handleAgentLoopRunTurnWithRecovery({
      turnStateProjection: {
        turnState: {
          maxContextTokens: 128000,
          executionContext: { cwd: '/tmp/project' },
          permissionMode: 'default',
        },
        maxContextTokens: 128000,
        executionContext: { cwd: '/tmp/project' },
        permissionMode: 'default',
      },
      conversation: {
        toArray: () => [{ role: 'user', content: 'hello' }],
      },
      executionPipeline: { id: 'pipeline' },
      streaming: true,
      signal: undefined,
      epoch: { invalidate: () => undefined },
      logger: { debug: () => undefined },
      hooks: {
        tool: {
          beforeExec: async () => null,
        },
      },
      tracker: createAgentRecoveryAttemptTracker(),
      turn: 2,
      counter: {
        requestRetry: () => {
          operations.push({ type: 'retry' });
        },
      },
      runTurn: async function* (input: AgentLoopRunTurnInput<
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown
      >) {
        operations.push({ type: 'runTurn', input });
        yield { type: 'model_event', turn: 2 };
        return {
          chatResponse: response,
          streamingExecutionResults,
        };
      },
    });

    expect(await generator.next()).toEqual({
      done: false,
      value: { type: 'model_event', turn: 2 },
    });
    expect(operations).toEqual([
      {
        type: 'runTurn',
        input: {
          turnState: {
            maxContextTokens: 128000,
            executionContext: { cwd: '/tmp/project' },
            permissionMode: 'default',
          },
          messages: [{ role: 'user', content: 'hello' }],
          executionPipeline: { id: 'pipeline' },
          streaming: true,
          signal: undefined,
          epoch: { invalidate: expect.any(Function) },
          executionContext: { cwd: '/tmp/project' },
          permissionMode: 'default',
          logger: { debug: expect.any(Function) },
          toolHooks: {
            onBeforeExec: expect.any(Function),
            onAfterExec: undefined,
            onAfterExecEpochDiscard: undefined,
            onUpdate: undefined,
          },
        },
      },
    ]);

    expect(await generator.next()).toEqual({
      done: true,
      value: {
        action: 'continue',
        turnResult: response,
        streamingExecutionResults,
      },
    });
  });
});
