import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runToolCall } from '../../agent/loop/runToolCall.js';
import { createTool } from '../../tools/core/createTool.js';
import { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import {
  collectToolExecution,
  completeToolExecution,
  type Tool,
  type ToolResult,
  type ToolYield,
} from '../../tools/types/index.js';
import { ToolKind } from '../../tools/types/ToolKind.js';
import { ModelAttemptId, SessionId } from '../../types/branded.js';
import { PermissionMode } from '../../types/common.js';
import type { ToolMiddleware } from '../ToolMiddleware.js';

function createRegistry(execute: (value: string) => ToolResult): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    createTool({
      name: 'Echo',
      displayName: 'Echo',
      kind: ToolKind.ReadOnly,
      sideEffect: 'pure',
      description: { short: 'Echo a value' },
      schema: z.object({ value: z.string() }),
      async *execute({ value }) {
        yield { kind: 'progress', message: value };
        return execute(value);
      },
    }) as unknown as Tool,
  );
  return registry;
}

describe('ToolMiddleware', () => {
  it('wraps streamed execution in onion order and records the final result', async () => {
    const calls: string[] = [];
    const middleware: ToolMiddleware[] = [
      async function* (request, next) {
        calls.push('first:before');
        const result = yield* next({
          ...request,
          input: { ...request.input, value: 'transformed' },
        });
        calls.push('first:after');
        return { ...result, model: `${result.model}:first` };
      },
      async function* (_request, next) {
        calls.push('second:before');
        const result = yield* next();
        calls.push('second:after');
        return { ...result, model: `${result.model}:second` };
      },
    ];
    const pipeline = new ExecutionPipeline(
      createRegistry((value) => {
        calls.push(`tool:${value}`);
        return { status: 'success', model: value };
      }),
      {
        permissionMode: PermissionMode.YOLO,
        middleware,
      },
    );
    const yields: ToolYield[] = [];

    const result = await collectToolExecution(
      pipeline.execute('Echo', { value: 'original' }, {}),
      (event) => {
        yields.push(event);
      },
    );

    expect(result).toMatchObject({
      status: 'success',
      model: 'transformed:second:first',
    });
    expect(yields).toEqual([{ kind: 'progress', message: 'transformed' }]);
    expect(calls).toEqual([
      'first:before',
      'second:before',
      'tool:transformed',
      'second:after',
      'first:after',
    ]);
    expect(pipeline.getExecutionHistory()).toEqual([
      expect.objectContaining({
        toolName: 'Echo',
        params: { value: 'transformed' },
        result: expect.objectContaining({
          model: 'transformed:second:first',
        }),
      }),
    ]);
  });

  it('allows middleware to short-circuit before permissions and tool execution', async () => {
    const execute = vi.fn(() => ({ status: 'success', model: 'tool' }) as ToolResult);
    const middleware: ToolMiddleware = () =>
      completeToolExecution({ status: 'success', model: 'short-circuit' });
    const pipeline = new ExecutionPipeline(createRegistry(execute), {
      permissionMode: PermissionMode.YOLO,
      middleware: [middleware],
    });

    await expect(
      collectToolExecution(pipeline.execute('Echo', { value: 'original' }, {})),
    ).resolves.toMatchObject({
      status: 'success',
      model: 'short-circuit',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when middleware replaces protected execution identity', async () => {
    const execute = vi.fn(() => ({ status: 'success', model: 'tool' }) as ToolResult);
    const replaceContext: ToolMiddleware = (request, next) =>
      next({ ...request, context: { ...request.context } });
    const replaceTool: ToolMiddleware = (request, next) =>
      next({ ...request, toolName: 'Other' });

    for (const middleware of [replaceContext, replaceTool]) {
      const pipeline = new ExecutionPipeline(createRegistry(execute), {
        permissionMode: PermissionMode.YOLO,
        middleware: [middleware],
      });
      const result = await collectToolExecution(
        pipeline.execute('Echo', { value: 'original' }, {}),
      );

      expect(result.status).toBe('error');
      expect(result.error?.message).toMatch(
        /cannot (replace the execution context|change the tool name)/,
      );
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps durable lifecycle boundaries around middleware-transformed execution', async () => {
    const lifecycle: string[] = [];
    const pipeline = new ExecutionPipeline(
      createRegistry((value) => {
        lifecycle.push(`tool:${value}`);
        return { status: 'success', model: value };
      }),
      {
        permissionMode: PermissionMode.YOLO,
        middleware: [
          async function* (request, next) {
            lifecycle.push('middleware:before');
            const result = yield* next({
              ...request,
              input: { ...request.input, value: 'transformed' },
            });
            lifecycle.push('middleware:after');
            return { ...result, model: `${result.model}:wrapped` };
          },
        ],
      },
    );

    const outcome = await runToolCall({
      toolCall: {
        id: 'tool-1',
        type: 'function',
        function: {
          name: 'Echo',
          arguments: '{"value":"model"}',
        },
      },
      executionPipeline: pipeline,
      executionContext: {
        sessionId: SessionId('session-1'),
        userId: 'user-1',
        modelAttemptId: ModelAttemptId('attempt-1'),
        lifecycle: {
          async onToolScheduled(event) {
            lifecycle.push(`scheduled:${String(event.input.value)}`);
            return {
              async onExecutionStarted(started) {
                lifecycle.push(`started:${String(started.input.value)}`);
              },
            };
          },
          async onToolSettled(event) {
            lifecycle.push(`settled:${String(event.result.model)}`);
          },
        },
      },
      permissionMode: PermissionMode.YOLO,
    });

    expect(outcome.result).toMatchObject({
      status: 'success',
      model: 'transformed:wrapped',
    });
    expect(lifecycle).toEqual([
      'scheduled:model',
      'middleware:before',
      'started:transformed',
      'tool:transformed',
      'middleware:after',
      'settled:transformed:wrapped',
    ]);
  });
});
