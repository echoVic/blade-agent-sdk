import { describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../../../logging/Logger.js';
import type { ToolMiddleware } from '../../../../middleware/ToolMiddleware.js';
import { PermissionMode } from '../../../../types/constants.js';
import type { JsonObject } from '../../../../types/json.js';
import { readTool } from '../../../builtin/file/read.js';
import { BUILTIN_TOOL_SOURCE, ToolRegistry } from '../../../registry/ToolRegistry.js';
import type { ExecutionContext } from '../../../types/execution.js';
import { completeToolExecution, ToolErrorType, type ToolExecution } from '../../../types/result.js';
import { MiddlewareBoundary } from '../MiddlewareBoundary.js';

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readTool, BUILTIN_TOOL_SOURCE);
  return registry;
}

/** Drain a boundary run and return its final outcome (progress yields ignored). */
async function drain(
  boundary: MiddlewareBoundary,
  input: Parameters<MiddlewareBoundary['run']>[0],
) {
  const execution = boundary.run(input);
  while (true) {
    const step = await execution.next();
    if (step.done) {
      return step.value;
    }
  }
}

function runBoundary(
  middleware: readonly ToolMiddleware[],
  executeCore: () => ToolExecution,
  context: ExecutionContext = { permissionMode: PermissionMode.YOLO },
  params: JsonObject = {},
) {
  const boundary = new MiddlewareBoundary(createRegistry(), middleware, NOOP_LOGGER);
  return drain(boundary, {
    toolName: 'Read',
    params,
    context: Object.freeze({ ...context }),
    executeCore,
  });
}

describe('MiddlewareBoundary', () => {
  it('rejects middleware that renames the tool', async () => {
    const rename: ToolMiddleware = async function* (request, next) {
      return yield* next({ ...request, toolName: 'Write' });
    };

    const outcome = await runBoundary([rename], () =>
      completeToolExecution({ status: 'success', model: 'x' }),
    );

    expect(outcome.result).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('cannot change the tool name') },
    });
  });

  it('rejects middleware that swaps the execution context', async () => {
    const swapContext: ToolMiddleware = async function* (request, next) {
      return yield* next({ ...request, context: { permissionMode: PermissionMode.YOLO } });
    };

    const outcome = await runBoundary([swapContext], () =>
      completeToolExecution({ status: 'success', model: 'x' }),
    );

    expect(outcome.result).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('cannot replace the execution context') },
    });
  });

  it('keeps a core failure when middleware reports success', async () => {
    const swallow: ToolMiddleware = async function* (request, next) {
      yield* next(request);
      return { status: 'success', model: 'middleware override' };
    };

    const outcome = await runBoundary([swallow], () =>
      completeToolExecution({
        status: 'error',
        model: 'core failed',
        error: { type: ToolErrorType.EXECUTION_ERROR, message: 'core failed' },
      }),
    );

    expect(outcome.result).toMatchObject({ status: 'error', error: { message: 'core failed' } });
  });

  it('preserves a core timeout even when middleware fails afterwards', async () => {
    const fails: ToolMiddleware = async function* (request, next) {
      yield* next(request);
      throw new Error('middleware exploded');
    };

    const outcome = await runBoundary([fails], () =>
      completeToolExecution({
        status: 'error',
        model: 'timed out',
        error: { type: ToolErrorType.TIMEOUT_ERROR, message: 'timed out' },
      }),
    );

    expect(outcome.result).toMatchObject({
      status: 'error',
      error: { type: ToolErrorType.TIMEOUT_ERROR },
    });
  });

  it('rethrows a core failure instead of turning it into a result', async () => {
    const boundary = new MiddlewareBoundary(createRegistry(), [], NOOP_LOGGER);
    const contractFailure = new Error('core contract broken');

    await expect(
      drain(boundary, {
        toolName: 'Read',
        params: {},
        context: Object.freeze({ permissionMode: PermissionMode.YOLO }),
        executeCore: () =>
          (async function* () {
            yield { kind: 'progress', message: 'starting' };
            throw contractFailure;
          })(),
      }),
    ).rejects.toBe(contractFailure);
  });

  it('drains a delegated core execution that middleware left unfinished', async () => {
    const drained = vi.fn();
    const skipAwait: ToolMiddleware = (request, next) => {
      // Start the delegated execution but return before it finishes.
      void next(request).next();
      return completeToolExecution({ status: 'success', model: 'early return' });
    };

    const outcome = await runBoundary([skipAwait], async function* () {
      drained();
      yield { kind: 'progress', message: 'working' };
      return { status: 'success', model: 'core result' };
    });

    expect(drained).toHaveBeenCalledTimes(1);
    expect(outcome.result).toMatchObject({ status: 'success', model: 'core result' });
  });

  it('announces a short-circuited execution without running the tool', async () => {
    const onExecutionStarted = vi.fn();
    const execute = vi.fn(() => completeToolExecution({ status: 'success', model: 'ran' }));
    const shortCircuit: ToolMiddleware = () =>
      completeToolExecution({ status: 'success', model: 'served from cache' });

    const outcome = await runBoundary([shortCircuit], () => execute(), {
      permissionMode: PermissionMode.YOLO,
      toolInvocationLifecycle: { onExecutionStarted },
    });

    expect(outcome.coreStarted).toBe(false);
    expect(outcome.result).toMatchObject({ status: 'success', model: 'served from cache' });
    expect(execute).not.toHaveBeenCalled();
    expect(onExecutionStarted).toHaveBeenCalledTimes(1);
  });
});
