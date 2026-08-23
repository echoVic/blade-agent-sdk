import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runToolCall } from '../../agent/loop/runToolCall.js';
import { DurableExecutionLeaseError } from '../../session/events/DurableExecutionLeaseStore.js';
import { createTool } from '../../tools/core/createTool.js';
import { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import {
  collectToolExecution,
  completeToolExecution,
  type Tool,
  ToolErrorType,
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

  it('unwinds middleware and omits history when the consumer closes early', async () => {
    let middlewareClosed = false;
    const pipeline = new ExecutionPipeline(
      createRegistry((value) => ({ status: 'success', model: value })),
      {
        permissionMode: PermissionMode.YOLO,
        middleware: [
          async function* (request, next) {
            try {
              return yield* next(request);
            } finally {
              middlewareClosed = true;
            }
          },
        ],
      },
    );
    const execution = pipeline.execute('Echo', { value: 'partial' }, {});

    await expect(execution.next()).resolves.toEqual({
      done: false,
      value: { kind: 'progress', message: 'partial' },
    });
    await execution.return(undefined as never);

    expect(middlewareClosed).toBe(true);
    expect(pipeline.getExecutionHistory()).toEqual([]);
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

  it('persists a synthetic execution boundary before settling a successful short circuit', async () => {
    const lifecycle: string[] = [];
    const execute = vi.fn();
    const pipeline = new ExecutionPipeline(createRegistry(execute), {
      permissionMode: PermissionMode.YOLO,
      middleware: [
        (request, next) => {
          lifecycle.push('middleware:transform');
          return next({
            ...request,
            input: { ...request.input, value: 'cached-input' },
          });
        },
        () => {
          lifecycle.push('middleware:short-circuit');
          return completeToolExecution({
            status: 'success',
            model: 'cached',
          });
        },
      ],
    });

    const outcome = await runToolCall({
      toolCall: {
        id: 'tool-short-circuit',
        type: 'function',
        function: {
          name: 'Echo',
          arguments: '{"value":"model"}',
        },
      },
      executionPipeline: pipeline,
      executionContext: {
        sessionId: SessionId('session-short-circuit'),
        userId: 'user-1',
        modelAttemptId: ModelAttemptId('attempt-short-circuit'),
        lifecycle: {
          async onToolScheduled() {
            lifecycle.push('scheduled');
            return {
              async onExecutionStarted({ input, sideEffect }) {
                lifecycle.push(
                  `started:${String(input.value)}:${sideEffect}`,
                );
              },
            };
          },
          async onToolSettled({ result }) {
            lifecycle.push(`settled:${String(result.model)}`);
          },
        },
      },
      permissionMode: PermissionMode.YOLO,
    });

    expect(outcome.result).toMatchObject({
      status: 'success',
      model: 'cached',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(lifecycle).toEqual([
      'scheduled',
      'middleware:transform',
      'middleware:short-circuit',
      'started:cached-input:pure',
      'settled:cached',
    ]);
    expect(pipeline.getExecutionHistory()).toEqual([
      expect.objectContaining({
        params: { value: 'cached-input' },
      }),
    ]);
  });

  it('fails closed when middleware replaces identity before a nested short circuit', async () => {
    const execute = vi.fn(() => ({ status: 'success', model: 'tool' }) as ToolResult);
    const replaceContext: ToolMiddleware = (request, next) =>
      next({ ...request, context: { ...request.context } });
    const replaceTool: ToolMiddleware = (request, next) =>
      next({ ...request, toolName: 'Other' });

    for (const middleware of [replaceContext, replaceTool]) {
      const pipeline = new ExecutionPipeline(createRegistry(execute), {
        permissionMode: PermissionMode.YOLO,
        middleware: [
          middleware,
          () =>
            completeToolExecution({
              status: 'success',
              model: 'short-circuit',
            }),
        ],
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

  it('rejects input transforms that change steering interrupt behavior', async () => {
    const execute = vi.fn();
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'DynamicInterrupt',
        displayName: 'Dynamic Interrupt',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Dynamic interrupt behavior' },
        schema: z.object({ mode: z.enum(['block', 'cancel']) }),
        resolveBehavior: ({ mode }) => ({
          interruptBehavior: mode,
        }),
        execute() {
          execute();
          return completeToolExecution({
            status: 'success',
            model: 'unexpected',
          });
        },
      }) as unknown as Tool,
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      middleware: [
        (request, next) =>
          next({
            ...request,
            input: { ...request.input, mode: 'cancel' },
          }),
        () =>
          completeToolExecution({
            status: 'success',
            model: 'short-circuit',
          }),
      ],
    });

    await expect(
      collectToolExecution(
        pipeline.execute(
          'DynamicInterrupt',
          { mode: 'block' },
          {},
        ),
      ),
    ).resolves.toMatchObject({
      status: 'error',
      error: {
        message: expect.stringContaining(
          'cannot change the tool interrupt behavior',
        ),
      },
    });
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

  it('checks execution ownership before entering middleware', async () => {
    const leaseError = new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      'worker is stale',
    );
    const middleware = vi.fn(() =>
      completeToolExecution({ status: 'success', model: 'unexpected' }),
    );
    const pipeline = new ExecutionPipeline(createRegistry(() => ({
      status: 'success',
      model: 'unexpected',
    })), {
      permissionMode: PermissionMode.YOLO,
      middleware: [middleware],
    });

    await expect(
      collectToolExecution(
        pipeline.execute(
          'Echo',
          { value: 'original' },
          {
            assertExecutionLease: async () => {
              throw leaseError;
            },
          },
        ),
      ),
    ).rejects.toBe(leaseError);
    expect(middleware).not.toHaveBeenCalled();
    expect(pipeline.getExecutionHistory()).toEqual([]);
  });

  it('does not commit middleware output after ownership is lost while unwinding', async () => {
    const leaseError = new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      'worker lost ownership while middleware unwound',
    );
    let middlewareUnwound = false;
    const execute = vi.fn(() => ({
      status: 'success',
      model: 'tool',
    }) as ToolResult);
    const pipeline = new ExecutionPipeline(createRegistry(execute), {
      permissionMode: PermissionMode.YOLO,
      middleware: [
        async function* (_request, next) {
          const result = yield* next();
          middlewareUnwound = true;
          return { ...result, model: 'wrapped' };
        },
      ],
    });

    await expect(
      collectToolExecution(
        pipeline.execute(
          'Echo',
          { value: 'original' },
          {
            assertExecutionLease: async () => {
              if (middlewareUnwound) {
                throw leaseError;
              }
            },
          },
        ),
      ),
    ).rejects.toBe(leaseError);
    expect(execute).toHaveBeenCalledOnce();
    expect(pipeline.getExecutionHistory()).toEqual([]);
  });

  it('propagates a lease failure thrown directly by middleware', async () => {
    const leaseError = new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      'middleware observed stale ownership',
    );
    const pipeline = new ExecutionPipeline(createRegistry(() => ({
      status: 'success',
      model: 'unexpected',
    })), {
      permissionMode: PermissionMode.YOLO,
      middleware: [
        () => {
          throw leaseError;
        },
      ],
    });

    await expect(
      collectToolExecution(
        pipeline.execute('Echo', { value: 'original' }, {}),
      ),
    ).rejects.toBe(leaseError);
    expect(pipeline.getExecutionHistory()).toEqual([]);
  });

  it('does not let middleware swallow a fatal core boundary error', async () => {
    const boundaryError = new Error('ownership check failed after queueing');
    let checks = 0;
    const pipeline = new ExecutionPipeline(createRegistry(() => ({
      status: 'success',
      model: 'unexpected',
    })), {
      permissionMode: PermissionMode.YOLO,
      middleware: [
        async function* (_request, next) {
          try {
            return yield* next();
          } catch {
            return {
              status: 'success',
              model: 'swallowed',
            };
          }
        },
      ],
    });

    await expect(
      collectToolExecution(
        pipeline.execute(
          'Echo',
          { value: 'original' },
          {
            assertExecutionLease: async () => {
              checks += 1;
              if (checks === 3) {
                throw boundaryError;
              }
            },
          },
        ),
      ),
    ).rejects.toBe(boundaryError);
    expect(pipeline.getExecutionHistory()).toEqual([]);
  });

  it('does not let middleware replace a core failure with success', async () => {
    const coreFailure: ToolResult = {
      status: 'error',
      model: 'core failed',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'core failed',
      },
    };
    const pipeline = new ExecutionPipeline(
      createRegistry(() => coreFailure),
      {
        permissionMode: PermissionMode.YOLO,
        middleware: [
          async function* (_request, next) {
            yield* next();
            return {
              status: 'success',
              model: 'middleware success',
            };
          },
        ],
      },
    );

    await expect(
      collectToolExecution(
        pipeline.execute('Echo', { value: 'original' }, {}),
      ),
    ).resolves.toEqual(coreFailure);
  });

  it('preserves the core cancellation result after middleware unwinds', async () => {
    const controller = new AbortController();
    const coreCancellation: ToolResult = {
      status: 'error',
      model: 'core cancellation',
      error: {
        type: ToolErrorType.INTERRUPTED,
        message: 'precise cancellation reason',
      },
    };
    const pipeline = new ExecutionPipeline(
      createRegistry(() => {
        controller.abort(new Error('cancelled'));
        return coreCancellation;
      }),
      {
        permissionMode: PermissionMode.YOLO,
        middleware: [
          async function* (_request, next) {
            yield* next();
            return {
              status: 'error',
              model: 'rewritten cancellation',
              error: {
                type: ToolErrorType.EXECUTION_ERROR,
                message: 'rewritten cancellation',
              },
            };
          },
        ],
      },
    );

    await expect(
      collectToolExecution(
        pipeline.execute(
          'Echo',
          { value: 'original' },
          { signal: controller.signal },
        ),
      ),
    ).resolves.toEqual(coreCancellation);
  });

  it('drains a delegated core execution that middleware abandons after starting', async () => {
    const pipeline = new ExecutionPipeline(
      createRegistry((value) => ({
        status: 'success',
        model: `core:${value}`,
      })),
      {
        permissionMode: PermissionMode.YOLO,
        middleware: [
          async function* (_request, next) {
            const delegated = next();
            const first = await delegated.next();
            if (!first.done) {
              yield first.value;
            }
            return {
              status: 'success',
              model: 'middleware-returned-too-early',
            };
          },
        ],
      },
    );
    const yields: ToolYield[] = [];

    const result = await collectToolExecution(
      pipeline.execute('Echo', { value: 'partial' }, {}),
      (event) => {
        yields.push(event);
      },
    );

    expect(yields).toEqual([{ kind: 'progress', message: 'partial' }]);
    expect(result).toMatchObject({
      status: 'success',
      model: 'core:partial',
    });
    expect(pipeline.getExecutionHistory()).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ model: 'core:partial' }),
      }),
    ]);
  });
});
