import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Type from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../../errors/ConfigError.js';
import type { HookRuntime } from '../../../hooks/HookRuntime.js';
import { HookProcessContainmentError } from '../../../hooks/WindowsProcessJob.js';
import { DurableExecutionLeaseError } from '../../../session/events/DurableExecutionLeaseStore.js';
import { PermissionMode } from '../../../types/constants.js';
import {
  ExecutionLeaseId,
  FencingToken,
  InputId,
  PermissionRequestId,
  SessionId,
  TurnId,
} from '../../../types/identifiers.js';
import type { JsonObject } from '../../../types/json.js';
import type { PermissionHandler } from '../../../types/permissions.js';
import { ToolKind } from '../../behavior.js';
import { readTool } from '../../builtin/file/read.js';
import { createTool } from '../../core/createTool.js';
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import type { ExecutionContext } from '../../types/execution.js';
import type { ToolResult, ToolYield } from '../../types/result.js';
import { collectToolExecution, completeToolExecution, ToolErrorType } from '../../types/result.js';
import type { Tool } from '../../types/tool.js';
import { resolveAuthorizedFilesystemPath } from '../../validation/filesystemPath.js';
import { ConcurrencyScheduler } from '../ConcurrencyScheduler.js';
import { ExecutionPipeline } from '../ExecutionPipeline.js';
import { FileLockManager } from '../FileLockManager.js';

function registerTool(registry: ToolRegistry, tool: Tool): void {
  registry.register(tool);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function executePipeline(
  pipeline: ExecutionPipeline,
  toolName: string,
  params: JsonObject,
  context: ExecutionContext,
  onYield?: (event: ToolYield) => void | Promise<void>,
): Promise<ToolResult> {
  return collectToolExecution(pipeline.execute(toolName, params, context), onYield);
}

describe('ExecutionPipeline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not expose stage-pipeline management on the default execution path', () => {
    const registry = new ToolRegistry();
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    expect('on' in (pipeline as unknown as Record<string, unknown>)).toBe(false);
    expect('getStages' in (pipeline as unknown as Record<string, unknown>)).toBe(false);
    expect('addStage' in (pipeline as unknown as Record<string, unknown>)).toBe(false);
    expect('removeStage' in (pipeline as unknown as Record<string, unknown>)).toBe(false);
  });

  it('groups execution ownership capabilities under runtime for tool execution', async () => {
    const registry = new ToolRegistry();
    let observedRuntime: unknown;
    registerTool(
      registry,
      createTool({
        name: 'RuntimeContextTool',
        displayName: 'Runtime Context Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        requiresRuntime: true,
        description: { short: 'Observes runtime access' },
        schema: Type.Object({}),
        execute: (_params, context) => {
          observedRuntime = Reflect.get(context, 'runtime');
          return completeToolExecution({ status: 'success', model: 'ok' });
        },
      }),
    );

    const executionFence = {
      leaseId: ExecutionLeaseId('lease-1'),
      fencingToken: FencingToken(1),
    };
    const assertExecutionLease = vi.fn(async () => {});
    const runWithExecutionLease = async <T>(operation: () => Promise<T>): Promise<T> => operation();
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    await executePipeline(
      pipeline,
      'RuntimeContextTool',
      {},
      {
        runtime: {
          executionFence,
          assertExecutionLease,
          runWithExecutionLease,
        },
      },
    );

    expect(observedRuntime).toEqual({
      executionFence,
      assertExecutionLease,
      runWithExecutionLease,
    });
    expect(Object.isFrozen(observedRuntime)).toBe(true);
  });

  it('provides callable runtime boundaries without a durable execution lease', async () => {
    const registry = new ToolRegistry();
    let observedValue: string | undefined;
    registerTool(
      registry,
      createTool({
        name: 'InMemoryRuntimeTool',
        displayName: 'In-memory Runtime Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        requiresRuntime: true,
        description: { short: 'Uses runtime access without a durable lease' },
        schema: Type.Object({}),
        execute: async function* (_params, context) {
          const runtime = Reflect.get(context, 'runtime') as
            | {
                assertExecutionLease?: () => Promise<void>;
                runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
              }
            | undefined;
          await runtime?.assertExecutionLease?.();
          observedValue = await runtime?.runWithExecutionLease?.(async () => 'available');
          return { status: 'success', model: 'ok' };
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    await executePipeline(pipeline, 'InMemoryRuntimeTool', {}, {});

    expect(observedValue).toBe('available');
  });

  it('does not expose runtime access to tools that do not request it', async () => {
    const registry = new ToolRegistry();
    let observedRuntime: unknown = 'not-called';
    registerTool(
      registry,
      createTool({
        name: 'OrdinaryTool',
        displayName: 'Ordinary Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Does not require runtime access' },
        schema: Type.Object({}),
        execute: (_params, context) => {
          observedRuntime = Reflect.get(context, 'runtime');
          return completeToolExecution({ status: 'success', model: 'ok' });
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    await executePipeline(pipeline, 'OrdinaryTool', {}, {});

    expect(observedRuntime).toBeUndefined();
  });

  it('enforces runtime isolation for custom Tool callbacks', async () => {
    const registry = new ToolRegistry();
    let observedRuntime: unknown = 'not-called';
    let observedValidationRuntime: unknown = 'not-called';
    const baseTool = createTool({
      name: 'CustomRuntimeTool',
      displayName: 'Custom Runtime Tool',
      kind: ToolKind.ReadOnly,
      sideEffect: 'pure',
      description: { short: 'Uses a custom invocation implementation' },
      schema: Type.Object({}),
      execute: () => completeToolExecution({ status: 'success', model: 'unused' }),
    });
    registerTool(registry, {
      ...baseTool,
      async validate(params: JsonObject, context: ExecutionContext) {
        observedValidationRuntime = Reflect.get(context, 'runtime');
        return { params };
      },
      execute(_params: JsonObject, context: ExecutionContext = {}) {
        observedRuntime = Reflect.get(context, 'runtime');
        return completeToolExecution({ status: 'success', model: 'ok' });
      },
    });

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    await executePipeline(pipeline, 'CustomRuntimeTool', {}, {});

    expect(observedRuntime).toBeUndefined();
    expect(observedValidationRuntime).toBeUndefined();
  });

  it('enforces configured concurrency limits at the execution boundary', async () => {
    const registry = new ToolRegistry();
    const gates = Array.from({ length: 3 }, () => deferred());
    const started: number[] = [];

    registerTool(
      registry,
      createTool({
        name: 'LimitedRead',
        displayName: 'Limited Read',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Concurrency-limited read' },
        schema: Type.Object({
          id: Type.Number(),
        }),
        async *execute({ id }) {
          started.push(id);
          yield { kind: 'progress', data: { id } };
          yield {
            kind: 'progress',
            data: { id },
          };
          await gates[id].promise;
          return {
            status: 'success',
            model: String(id),
          };
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      concurrencyLimits: {
        readonly: 2,
      },
    });
    const executions = gates.map((_, id) =>
      executePipeline(pipeline, 'LimitedRead', { id }, { permissionMode: PermissionMode.YOLO }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1]);

    gates[0].resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(executions);
  });

  it('cancels a tool while it is queued for a concurrency slot', async () => {
    const registry = new ToolRegistry();
    const scheduler = new ConcurrencyScheduler({ execute: 1 });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const started: number[] = [];

    registerTool(
      registry,
      createTool({
        name: 'QueuedExecutionTool',
        displayName: 'Queued Execution Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Concurrency queue cancellation tool' },
        schema: Type.Object({ id: Type.Number() }),
        async *execute({ id }) {
          started.push(id);
          yield { kind: 'progress', data: { id } };
          if (id === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          return { status: 'success', model: String(id) };
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const first = executePipeline(
      pipeline,
      'QueuedExecutionTool',
      { id: 1 },
      { permissionMode: PermissionMode.YOLO },
    );
    await firstStarted.promise;

    const controller = new AbortController();
    const second = executePipeline(
      pipeline,
      'QueuedExecutionTool',
      { id: 2 },
      {
        permissionMode: PermissionMode.YOLO,
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => {
      expect(scheduler.getStats()[ToolKind.Execute].queued).toBe(1);
    });

    controller.abort({
      kind: 'steering',
      inputId: InputId('queued-steering'),
    });
    await expect(second).resolves.toMatchObject({
      status: 'error',
      error: {
        type: ToolErrorType.INTERRUPTED,
        message: '工具执行被新的用户输入中断',
      },
    });
    expect(started).toEqual([1]);
    expect(scheduler.getStats()[ToolKind.Execute]).toEqual({
      inFlight: 1,
      queued: 0,
    });

    releaseFirst.resolve();
    await expect(first).resolves.toMatchObject({
      status: 'success',
      model: '1',
    });
    expect(scheduler.getStats()[ToolKind.Execute].inFlight).toBe(0);
  });

  it('cancels a tool while it is queued for a file lock', async () => {
    const registry = new ToolRegistry();
    const scheduler = new ConcurrencyScheduler({ write: 2 });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const started: number[] = [];
    const filePath = '/tmp/file-lock-cancellation.txt';

    registerTool(
      registry,
      createTool({
        name: 'FileLockCancellationTool',
        displayName: 'File Lock Cancellation Tool',
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
        description: { short: 'File lock cancellation tool' },
        schema: Type.Object({
          id: Type.Number(),
          file_path: Type.String(),
        }),
        async *execute({ id }) {
          started.push(id);
          yield { kind: 'progress', data: { id } };
          if (id === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          return { status: 'success', model: String(id) };
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const first = executePipeline(
      pipeline,
      'FileLockCancellationTool',
      { id: 1, file_path: filePath },
      { permissionMode: PermissionMode.YOLO },
    );
    await firstStarted.promise;

    const controller = new AbortController();
    const addAbortListener = vi.spyOn(controller.signal, 'addEventListener');
    const second = executePipeline(
      pipeline,
      'FileLockCancellationTool',
      { id: 2, file_path: filePath },
      {
        permissionMode: PermissionMode.YOLO,
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => {
      expect(addAbortListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    });

    controller.abort(new Error('cancel file lock wait'));
    await expect(second).resolves.toMatchObject({
      status: 'error',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: '任务已被用户中止',
      },
    });
    expect(started).toEqual([1]);
    expect(scheduler.getStats()[ToolKind.Write]).toEqual({
      inFlight: 1,
      queued: 0,
    });
    expect(FileLockManager.getInstance().isLocked(filePath)).toBe(true);

    releaseFirst.resolve();
    await expect(first).resolves.toMatchObject({
      status: 'success',
      model: '1',
    });
    expect(scheduler.getStats()[ToolKind.Write].inFlight).toBe(0);
    expect(FileLockManager.getInstance().isLocked(filePath)).toBe(false);
  });

  it('locks canonical file targets after input validation', async () => {
    const registry = new ToolRegistry();
    const scheduler = new ConcurrencyScheduler({ write: 2 });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const started: number[] = [];
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-alias-lock-'));
    const target = path.join(workspaceRoot, 'target.txt');
    const alias = path.join(workspaceRoot, 'alias.txt');
    await fs.writeFile(target, 'original');
    await fs.symlink(target, alias);

    registerTool(
      registry,
      createTool({
        name: 'CanonicalFileLockTool',
        displayName: 'Canonical File Lock Tool',
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
        description: { short: 'Canonical file lock tool' },
        schema: Type.Object({
          id: Type.Number(),
          file_path: Type.String(),
        }),
        validateInput: async (params, context) => {
          params.file_path = await resolveAuthorizedFilesystemPath(
            params.file_path,
            context.contextSnapshot,
          );
          return undefined;
        },
        async *execute({ id }) {
          started.push(id);
          yield { kind: 'progress', data: { id } };
          if (id === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          return { status: 'success', model: String(id) };
        },
      }),
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const context: ExecutionContext = {
      permissionMode: PermissionMode.YOLO,
      contextSnapshot: {
        sessionId: SessionId('canonical-lock-session'),
        turnId: TurnId('turn-1'),
        cwd: workspaceRoot,
        environment: {},
        filesystemRoots: [workspaceRoot],
        context: {
          capabilities: {
            filesystem: {
              roots: [workspaceRoot],
              cwd: workspaceRoot,
            },
          },
        },
      },
    };

    try {
      const first = executePipeline(
        pipeline,
        'CanonicalFileLockTool',
        { id: 1, file_path: target },
        context,
      );
      await firstStarted.promise;
      const second = executePipeline(
        pipeline,
        'CanonicalFileLockTool',
        { id: 2, file_path: alias },
        context,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(started).toEqual([1]);

      releaseFirst.resolve();
      await expect(first).resolves.toMatchObject({ status: 'success', model: '1' });
      await expect(second).resolves.toMatchObject({ status: 'success', model: '2' });
    } finally {
      releaseFirst.resolve();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not start pre-tool hooks when cancellation wins during the final lease check', async () => {
    const registry = new ToolRegistry();
    const leaseCheckStarted = deferred();
    const releaseLeaseCheck = deferred();
    const preToolUse = vi.fn();
    let leaseCheckCount = 0;

    registerTool(
      registry,
      createTool({
        name: 'LeaseCheckCancellationTool',
        displayName: 'Lease Check Cancellation Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Lease check cancellation tool' },
        schema: Type.Object({}),
        execute: () =>
          completeToolExecution({
            status: 'success',
            model: 'unexpected',
          }),
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      hookRuntime: {
        applyPreToolUse: preToolUse,
      } as unknown as HookRuntime,
    });
    const controller = new AbortController();
    const resultPromise = executePipeline(
      pipeline,
      'LeaseCheckCancellationTool',
      {},
      {
        permissionMode: PermissionMode.YOLO,
        signal: controller.signal,
        runtime: {
          assertExecutionLease: async () => {
            leaseCheckCount += 1;
            if (leaseCheckCount === 3) {
              leaseCheckStarted.resolve();
              await releaseLeaseCheck.promise;
            }
          },
        },
      },
    );

    await leaseCheckStarted.promise;
    controller.abort(new Error('cancel final lease check'));
    releaseLeaseCheck.resolve();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: '任务已被用户中止',
      },
    });
    expect(preToolUse).not.toHaveBeenCalled();
  });

  it('releases execution leases when an event consumer stops the stream', async () => {
    const registry = new ToolRegistry();
    const scheduler = new ConcurrencyScheduler({ readonly: 1 });
    const filePath = '/tmp/stream-cleanup.txt';
    let finalized = false;

    registerTool(
      registry,
      createTool({
        name: 'StreamingRead',
        displayName: 'Streaming Read',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Streaming read tool' },
        schema: Type.Object({
          file_path: Type.String(),
        }),
        async *execute() {
          try {
            yield { kind: 'progress', message: 'started' };
            return { status: 'success', model: 'done' };
          } finally {
            finalized = true;
          }
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });

    await expect(
      collectToolExecution(
        pipeline.execute(
          'StreamingRead',
          { file_path: filePath },
          { permissionMode: PermissionMode.YOLO },
        ),
        () => {
          throw new Error('consumer failed');
        },
      ),
    ).rejects.toThrow('consumer failed');

    expect(finalized).toBe(true);
    expect(scheduler.getStats()[ToolKind.ReadOnly]).toEqual({
      inFlight: 0,
      queued: 0,
    });
    expect(FileLockManager.getInstance().isLocked(filePath)).toBe(false);
  });

  it('aborts and closes a streaming tool when its execution times out', async () => {
    const registry = new ToolRegistry();
    let observedAbort = false;
    let finalized = false;

    registerTool(
      registry,
      createTool({
        name: 'SlowStream',
        displayName: 'Slow Stream',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Slow streaming tool' },
        schema: Type.Object({}),
        async *execute(_params, context) {
          try {
            await new Promise<void>((_resolve, reject) => {
              context.signal?.addEventListener(
                'abort',
                () => {
                  observedAbort = true;
                  reject(context.signal?.reason);
                },
                { once: true },
              );
            });
            return { status: 'success', model: 'unexpected' };
          } finally {
            finalized = true;
          }
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      toolTimeoutMs: 10,
    });

    const result = await executePipeline(
      pipeline,
      'SlowStream',
      {},
      { permissionMode: PermissionMode.YOLO },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.status).toBe('error');
    expect(result.status === 'error' ? result.error.type : undefined).toBe('timeout_error');
    expect(observedAbort).toBe(true);
    expect(finalized).toBe(true);
  });

  it('preserves timeout precedence when a tool returns success after abort', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    const started = deferred();

    registerTool(
      registry,
      createTool({
        name: 'AbortRecovery',
        displayName: 'Abort Recovery',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Return success after abort' },
        schema: Type.Object({}),
        async *execute(_params, context) {
          started.resolve();
          await new Promise<void>((resolve) => {
            context.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return { status: 'success', model: 'recovered' };
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      toolTimeoutMs: 50,
    });
    const resultPromise = executePipeline(
      pipeline,
      'AbortRecovery',
      {},
      { permissionMode: PermissionMode.YOLO },
    );

    await started.promise;
    await vi.advanceTimersToNextTimerAsync();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      error: { type: ToolErrorType.TIMEOUT_ERROR },
    });
  });

  it('keeps the tool deadline active while the consumer pauses after progress', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    let observedSignal: AbortSignal | undefined;
    let finalized = false;

    registerTool(
      registry,
      createTool({
        name: 'PausedStream',
        displayName: 'Paused Stream',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Paused streaming tool' },
        schema: Type.Object({}),
        async *execute(_params, context) {
          observedSignal = context.signal;
          try {
            yield { kind: 'progress', message: 'started' };
            await new Promise(() => {});
            return { status: 'success', model: 'unexpected' };
          } finally {
            finalized = true;
          }
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      toolTimeoutMs: 50,
    });
    const execution = pipeline.execute('PausedStream', {}, { permissionMode: PermissionMode.YOLO });

    await expect(execution.next()).resolves.toEqual({
      done: false,
      value: { kind: 'progress', message: 'started' },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(observedSignal?.aborted).toBe(true);

    await expect(execution.next()).resolves.toMatchObject({
      done: true,
      value: {
        status: 'error',
        error: { type: ToolErrorType.TIMEOUT_ERROR },
      },
    });
    await Promise.resolve();
    expect(finalized).toBe(true);
  });

  it('waits for bounded cleanup when a timed-out tool ignores cancellation', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    const scheduler = new ConcurrencyScheduler({ execute: 1 });
    const started = deferred();
    const queuedExecute = vi.fn(
      () =>
        ({
          status: 'success',
          model: 'unexpected queued execution',
        }) as ToolResult,
    );

    registerTool(
      registry,
      createTool({
        name: 'UncooperativeTool',
        displayName: 'Uncooperative Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Ignore cancellation' },
        schema: Type.Object({}),
        async *execute() {
          started.resolve();
          await new Promise(() => {});
          return { status: 'success', model: 'unexpected' };
        },
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'QueuedTool',
        displayName: 'Queued Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Wait behind the timed-out tool' },
        schema: Type.Object({}),
        execute: () => completeToolExecution(queuedExecute()),
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      toolTimeoutMs: 50,
      scheduler,
    });
    const resultPromise = executePipeline(
      pipeline,
      'UncooperativeTool',
      {},
      { permissionMode: PermissionMode.YOLO },
    );
    let settled = false;
    void resultPromise.finally(() => {
      settled = true;
    });

    await started.promise;
    const queuedResultPromise = executePipeline(
      pipeline,
      'QueuedTool',
      {},
      { permissionMode: PermissionMode.YOLO },
    );
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }
    expect(scheduler.getStats()[ToolKind.Execute].queued).toBe(1);

    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersToNextTimerAsync();
    expect(settled).toBe(false);
    expect(pipeline.hasPendingExecutionCleanup()).toBe(true);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      error: { type: ToolErrorType.TIMEOUT_ERROR },
    });
    expect(pipeline.hasPendingExecutionCleanup()).toBe(true);
    await expect(queuedResultPromise).resolves.toMatchObject({
      status: 'error',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: expect.stringContaining('still cleaning up'),
      },
    });
    expect(queuedExecute).not.toHaveBeenCalled();

    await expect(
      executePipeline(pipeline, 'UncooperativeTool', {}, { permissionMode: PermissionMode.YOLO }),
    ).resolves.toMatchObject({
      status: 'error',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: expect.stringContaining('still cleaning up'),
      },
    });
  });

  it('uses a bounded default and rejects invalid tool timeout values', () => {
    const registry = new ToolRegistry();
    const defaultPipeline = new ExecutionPipeline(registry);
    expect((defaultPipeline as unknown as { toolTimeoutMs: number }).toolTimeoutMs).toBe(600_000);

    for (const toolTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => new ExecutionPipeline(registry, { toolTimeoutMs })).toThrow(ConfigError);
    }
  });

  it('returns a single-prefixed model message for thrown tool errors', async () => {
    const registry = new ToolRegistry();

    registerTool(
      registry,
      createTool({
        name: 'ThrowingTool',
        displayName: 'Throwing Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Throwing tool' },
        schema: Type.Object({}),
        // biome-ignore lint/correctness/useYield: exercises a terminal execution failure
        async *execute() {
          throw new Error('boom');
        },
      }),
    );

    const result = await executePipeline(
      new ExecutionPipeline(registry, {
        permissionMode: PermissionMode.YOLO,
      }),
      'ThrowingTool',
      {},
      { permissionMode: PermissionMode.YOLO },
    );

    expect(result).toMatchObject({
      status: 'error',
      model: 'Tool execution failed: boom',
      error: {
        type: 'execution_error',
        message: 'boom',
      },
    });
  });

  it('does not normalize a tool containment failure into a ToolResult', async () => {
    const registry = new ToolRegistry();
    const containmentError = new HookProcessContainmentError('Hook process cleanup failed');

    registerTool(
      registry,
      createTool({
        name: 'ContainmentFailureTool',
        displayName: 'Containment Failure Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Containment failure tool' },
        schema: Type.Object({}),
        // biome-ignore lint/correctness/useYield: exercises a terminal execution failure
        async *execute() {
          throw containmentError;
        },
      }),
    );

    await expect(
      executePipeline(
        new ExecutionPipeline(registry, {
          permissionMode: PermissionMode.YOLO,
        }),
        'ContainmentFailureTool',
        {},
        { permissionMode: PermissionMode.YOLO },
      ),
    ).rejects.toBe(containmentError);
  });

  it('preserves a late containment failure after cancellation wins the tool race', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    const controller = new AbortController();
    const started = deferred();
    const releaseCleanup = deferred();
    const containmentError = new HookProcessContainmentError('Hook process cleanup failed');

    registerTool(
      registry,
      createTool({
        name: 'LateContainmentFailureTool',
        displayName: 'Late Containment Failure Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Late containment failure tool' },
        schema: Type.Object({}),
        async *execute(_params, context) {
          started.resolve();
          await new Promise<void>((resolve) => {
            context.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          await releaseCleanup.promise;
          throw containmentError;
        },
      }),
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const execution = executePipeline(
      pipeline,
      'LateContainmentFailureTool',
      {},
      {
        permissionMode: PermissionMode.YOLO,
        signal: controller.signal,
      },
    );
    const rejection = expect(execution).rejects.toBe(containmentError);

    await started.promise;
    controller.abort(new Error('request cancelled'));
    await vi.advanceTimersByTimeAsync(0);
    releaseCleanup.resolve();

    await rejection;
    expect(pipeline.getTerminalCleanupFailure()).toBe(containmentError);
  });

  it('quarantines the pipeline after a late permission containment failure', async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    const started = deferred();
    const releaseCleanup = Promise.withResolvers<void>();
    const containmentError = new HookProcessContainmentError(
      'Permission Hook process cleanup failed',
    );
    const executeSpy = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'PermissionContainmentFailureTool',
        displayName: 'Permission Containment Failure Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Permission containment failure tool' },
        schema: Type.Object({}),
        execute: executeSpy,
      }),
    );
    const permissionHandler = vi.fn(async () => {
      started.resolve();
      await releaseCleanup.promise;
      throw containmentError;
    });
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler,
    });
    const firstExecution = executePipeline(
      pipeline,
      'PermissionContainmentFailureTool',
      {},
      {
        permissionMode: PermissionMode.YOLO,
        signal: controller.signal,
      },
    );

    await started.promise;
    controller.abort(new Error('request cancelled'));
    await expect(firstExecution).resolves.toMatchObject({
      status: 'error',
      error: { message: 'request cancelled' },
    });
    releaseCleanup.reject(containmentError);
    await vi.waitFor(() => {
      expect(pipeline.getTerminalCleanupFailure()).toBe(containmentError);
    });

    await expect(
      executePipeline(
        pipeline,
        'PermissionContainmentFailureTool',
        {},
        { permissionMode: PermissionMode.YOLO },
      ),
    ).rejects.toBe(containmentError);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('blocks an in-flight tool before its side effect after quarantine', async () => {
    const registry = new ToolRegistry();
    const firstPermissionStarted = deferred();
    const secondExecutionReady = deferred();
    const releaseFirstPermission = deferred();
    const releaseSecondExecution = deferred();
    const firstController = new AbortController();
    const containmentError = new HookProcessContainmentError(
      'Permission Hook process cleanup failed',
    );
    const executeSpy = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'ConcurrentContainmentTool',
        displayName: 'Concurrent Containment Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Concurrent containment tool' },
        schema: Type.Object({ id: Type.String() }),
        execute: executeSpy,
      }),
    );
    const permissionHandler = vi.fn(async (request) => {
      if (request.input.id === 'first') {
        firstPermissionStarted.resolve();
        await releaseFirstPermission.promise;
        throw containmentError;
      }
      return { behavior: 'allow' as const };
    });
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler,
      concurrencyLimits: { execute: 2 },
    });
    const firstExecution = executePipeline(
      pipeline,
      'ConcurrentContainmentTool',
      { id: 'first' },
      {
        permissionMode: PermissionMode.YOLO,
        signal: firstController.signal,
      },
    );
    await firstPermissionStarted.promise;

    const secondExecution = executePipeline(
      pipeline,
      'ConcurrentContainmentTool',
      { id: 'second' },
      {
        permissionMode: PermissionMode.YOLO,
        toolInvocationLifecycle: {
          onExecutionStarted: async () => {
            secondExecutionReady.resolve();
            await releaseSecondExecution.promise;
          },
        },
      },
    );
    const secondRejection = expect(secondExecution).rejects.toBe(containmentError);
    await secondExecutionReady.promise;

    firstController.abort(new Error('request cancelled'));
    await expect(firstExecution).resolves.toMatchObject({
      status: 'error',
      error: { message: 'request cancelled' },
    });
    releaseFirstPermission.resolve();
    await vi.waitFor(() => {
      expect(pipeline.getTerminalCleanupFailure()).toBe(containmentError);
    });
    releaseSecondExecution.resolve();

    await secondRejection;
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('uses resolved readonly behavior for plan-mode execution', async () => {
    const registry = new ToolRegistry();

    registerTool(
      registry,
      createTool({
        name: 'DynamicTool',
        displayName: 'Dynamic Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Dynamic behavior tool' },
        schema: Type.Object({
          mode: Type.Enum(['read', 'write']),
        }),
        resolveBehavior: (params) => {
          const mode = params?.mode ?? 'write';
          return {
            kind: mode === 'read' ? ToolKind.ReadOnly : ToolKind.Write,
            sideEffect: mode === 'read' ? 'pure' : 'idempotent',
            isReadOnly: mode === 'read',
            isConcurrencySafe: mode === 'read',
            isDestructive: mode === 'write',
          };
        },
        execute: ({ mode }) =>
          completeToolExecution({
            status: 'success',
            model: `ok:${mode}`,
          }),
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.PLAN,
    });

    const readResult = await executePipeline(
      pipeline,
      'DynamicTool',
      { mode: 'read' },
      { permissionMode: PermissionMode.PLAN },
    );
    const writeResult = await executePipeline(
      pipeline,
      'DynamicTool',
      { mode: 'write' },
      { permissionMode: PermissionMode.PLAN },
    );

    expect(readResult.status).toBe('success');
    expect(readResult.model).toBe('ok:read');
    expect(writeResult.status).toBe('error');
    expect(writeResult.error?.message).toContain('Plan mode');
  });

  it('applies plan-mode policy after custom permission handlers run', async () => {
    const registry = new ToolRegistry();
    const permissionHandler = vi.fn(async () => ({ behavior: 'allow' as const }));

    registerTool(
      registry,
      createTool({
        name: 'WriteTool',
        displayName: 'Write Tool',
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
        description: { short: 'Write tool' },
        schema: Type.Object({
          value: Type.String(),
        }),
        execute: ({ value }) =>
          completeToolExecution({
            status: 'success',
            model: value,
          }),
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.PLAN,
      permissionHandler,
    });

    const result = await executePipeline(
      pipeline,
      'WriteTool',
      { value: 'blocked' },
      { permissionMode: PermissionMode.PLAN },
    );

    expect(permissionHandler).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('Plan mode');
  });

  it('stops before execute when validateInput fails', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(({ value }: { value: string }) =>
      completeToolExecution({
        status: 'success',
        model: value,
      }),
    );

    registerTool(
      registry,
      createTool({
        name: 'ValidatedTool',
        displayName: 'Validated Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Validated tool' },
        schema: Type.Object({
          value: Type.String(),
        }),
        validateInput: ({ value }) =>
          value === 'bad'
            ? {
                message: 'Semantic validation failed',
              }
            : undefined,
        execute: executeSpy,
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const result = await executePipeline(
      pipeline,
      'ValidatedTool',
      { value: 'bad' },
      { permissionMode: PermissionMode.YOLO },
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('Semantic validation failed');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  for (const boundary of [
    'validateInput',
    'checkPermissions',
    'permissionRuleHandler',
    'pathSafetyHandler',
    'permissionHandler',
    'canUseTool',
    'confirmationHandler',
  ] as const) {
    it(`cancels and tracks an uncooperative ${boundary} callback`, async () => {
      const registry = new ToolRegistry();
      const started = deferred();
      const release = deferred();
      const controller = new AbortController();
      const cancellation = new Error(`${boundary} cancelled`);
      const executeSpy = vi.fn(() =>
        completeToolExecution({
          status: 'success',
          model: 'unexpected',
        }),
      );
      let callbackSignal: AbortSignal | undefined;

      const waitForRelease = async <T>(signal: AbortSignal | undefined, result: T): Promise<T> => {
        callbackSignal = signal;
        started.resolve();
        await release.promise;
        return result;
      };

      registerTool(
        registry,
        createTool({
          name: 'CancellationBoundaryTool',
          displayName: 'Cancellation Boundary Tool',
          kind: ToolKind.Execute,
          sideEffect: 'non_idempotent',
          description: { short: 'Permission cancellation boundary tool' },
          schema: Type.Object({}),
          ...(boundary === 'validateInput'
            ? {
                validateInput: (_params: object, context: ExecutionContext) =>
                  waitForRelease(context.signal, undefined),
              }
            : {}),
          ...(boundary === 'checkPermissions'
            ? {
                checkPermissions: (_params: object, context: ExecutionContext) =>
                  waitForRelease(context.signal, { behavior: 'allow' as const }),
              }
            : boundary === 'confirmationHandler'
              ? {
                  checkPermissions: () => ({
                    behavior: 'ask' as const,
                    message: 'Confirm cancellation boundary tool',
                  }),
                }
              : {}),
          execute: executeSpy,
        }),
      );

      const permissionHandler =
        boundary === 'permissionHandler'
          ? ((async (request) =>
              waitForRelease(request.signal, {
                behavior: 'allow' as const,
              })) satisfies PermissionHandler)
          : undefined;
      const canUseTool =
        boundary === 'canUseTool'
          ? async (_toolName: string, _input: JsonObject, options: { signal: AbortSignal }) =>
              waitForRelease(options.signal, { behavior: 'allow' as const })
          : undefined;
      const pipeline = new ExecutionPipeline(registry, {
        permissionMode: PermissionMode.YOLO,
        permissionHandler,
        canUseTool,
      });
      let cleanupWasVisibleToEarlierAbortListener = false;
      controller.signal.addEventListener(
        'abort',
        () => {
          cleanupWasVisibleToEarlierAbortListener = pipeline.hasPendingPermissionCleanup();
        },
        { once: true },
      );

      const internalHandler = (async (request) =>
        waitForRelease(request.signal, { behavior: 'allow' as const })) satisfies PermissionHandler;
      // The authorization stage owns these handlers; swap them at the stage so
      // the pipeline still routes the callback through its cancellation guard.
      const authorizationStage = (
        pipeline as unknown as {
          authorizationStage: {
            ruleHandler: PermissionHandler;
            pathSafetyHandler: PermissionHandler;
          };
        }
      ).authorizationStage;
      if (boundary === 'permissionRuleHandler') {
        authorizationStage.ruleHandler = internalHandler;
      }
      if (boundary === 'pathSafetyHandler') {
        authorizationStage.pathSafetyHandler = internalHandler;
      }

      const permissionResolutions: string[] = [];
      const resultPromise = executePipeline(
        pipeline,
        'CancellationBoundaryTool',
        {},
        {
          permissionMode: PermissionMode.YOLO,
          signal: controller.signal,
          ...(boundary === 'confirmationHandler'
            ? {
                confirmationHandler: {
                  requestConfirmation: (details: { abortSignal?: AbortSignal }) =>
                    waitForRelease(details.abortSignal, { approved: true }),
                },
                toolInvocationLifecycle: {
                  onPermissionRequested: async () =>
                    PermissionRequestId('permission-cancelled-by-request'),
                  onPermissionResolved: async ({ decision }: { decision: string }) => {
                    permissionResolutions.push(decision);
                  },
                },
              }
            : {}),
        },
      );

      await started.promise;
      expect(callbackSignal).toBe(controller.signal);
      controller.abort(cancellation);
      expect(cleanupWasVisibleToEarlierAbortListener).toBe(true);
      expect(pipeline.hasPendingPermissionCleanup()).toBe(true);

      await expect(resultPromise).resolves.toMatchObject({
        status: 'error',
        error: {
          message: `${boundary} cancelled`,
        },
      });
      if (boundary === 'confirmationHandler') {
        expect(permissionResolutions).toEqual(['cancel']);
      }

      await expect(
        executePipeline(
          pipeline,
          'CancellationBoundaryTool',
          {},
          { permissionMode: PermissionMode.YOLO },
        ),
      ).resolves.toMatchObject({
        status: 'error',
        error: {
          message: expect.stringContaining('permission callback is still cleaning up'),
        },
      });
      expect(executeSpy).not.toHaveBeenCalled();

      release.resolve();
      await vi.waitFor(() => {
        expect(pipeline.hasPendingPermissionCleanup()).toBe(false);
      });
    });
  }

  it('lets tool-level checkPermissions deny before the external permission handler runs', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(({ value }: { value: string }) =>
      completeToolExecution({
        status: 'success',
        model: value,
      }),
    );
    const permissionHandler = vi.fn(async () => ({ behavior: 'allow' as const }));

    registerTool(
      registry,
      createTool({
        name: 'GuardedTool',
        displayName: 'Guarded Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Guarded tool' },
        schema: Type.Object({
          value: Type.String(),
        }),
        checkPermissions: ({ value }) =>
          value === 'blocked'
            ? {
                behavior: 'deny',
                message: 'Denied by tool checkPermissions',
              }
            : undefined,
        execute: executeSpy,
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler,
    });

    const result = await executePipeline(
      pipeline,
      'GuardedTool',
      { value: 'blocked' },
      { permissionMode: PermissionMode.YOLO },
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('Denied by tool checkPermissions');
    expect(permissionHandler).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('uses permissionHandler instead of legacy canUseTool when both are configured', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'PermissionPrecedenceTool',
        displayName: 'Permission Precedence Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Permission precedence tool' },
        schema: Type.Object({}),
        execute: executeSpy,
      }),
    );
    const permissionHandler = vi.fn(async () => ({
      behavior: 'deny' as const,
      message: 'denied by permissionHandler',
    }));
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }));
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler,
      canUseTool,
    });

    const result = await executePipeline(
      pipeline,
      'PermissionPrecedenceTool',
      {},
      { permissionMode: PermissionMode.YOLO },
    );

    expect(result).toMatchObject({
      status: 'error',
      error: {
        message: 'denied by permissionHandler',
      },
    });
    expect(permissionHandler).toHaveBeenCalledOnce();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('rejects permission-handler updates that change authorized filesystem paths', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(({ file_path }: { file_path: string }) =>
      completeToolExecution({
        status: 'success',
        model: file_path,
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'PathMutationTool',
        displayName: 'Path Mutation Tool',
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
        description: { short: 'Path mutation tool' },
        schema: Type.Object({
          file_path: Type.String(),
        }),
        execute: executeSpy,
      }),
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler: async () => ({
        behavior: 'allow',
        updatedInput: {
          file_path: '/tmp/changed.txt',
        },
      }),
    });

    const result = await executePipeline(
      pipeline,
      'PathMutationTool',
      { file_path: '/tmp/original.txt' },
      { permissionMode: PermissionMode.YOLO },
    );

    expect(result).toMatchObject({
      status: 'error',
      error: {
        message: 'Permission handlers cannot change filesystem paths after path authorization',
      },
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('passes resolved tool metadata into permissionHandler and applies updated input', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(({ value }: { value: string }) =>
      completeToolExecution({
        status: 'success',
        model: value,
      }),
    );
    const permissionHandler = vi.fn(async () => {
      return {
        behavior: 'allow' as const,
        updatedInput: { value: 'patched' },
      };
    });

    registerTool(
      registry,
      createTool({
        name: 'DynamicPermissionTool',
        displayName: 'Dynamic Permission Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Dynamic permission tool' },
        schema: Type.Object({
          mode: Type.Enum(['read', 'write']),
          value: Type.String(),
        }),
        resolveBehavior: (params) => {
          const mode = params?.mode ?? 'write';
          return {
            kind: mode === 'read' ? ToolKind.ReadOnly : ToolKind.Execute,
            sideEffect: mode === 'read' ? 'pure' : 'non_idempotent',
            isReadOnly: mode === 'read',
            isConcurrencySafe: mode === 'read',
            isDestructive: mode === 'write',
          };
        },
        execute: executeSpy,
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler,
    });

    const result = await executePipeline(
      pipeline,
      'DynamicPermissionTool',
      { mode: 'write', value: 'original' },
      { permissionMode: PermissionMode.YOLO },
    );

    expect(result.status).toBe('success');
    expect(permissionHandler).toHaveBeenCalledTimes(1);
    expect(permissionHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { mode: 'write', value: 'patched' },
        toolMeta: {
          sideEffect: 'non_idempotent',
          isReadOnly: false,
          isConcurrencySafe: false,
          isDestructive: true,
          signature: 'DynamicPermissionTool',
          description: 'Dynamic permission tool',
        },
      }),
    );
    expect(executeSpy).toHaveBeenCalledWith({ mode: 'write', value: 'patched' }, expect.anything());
  });

  it('re-prepares permission updates without mutating the previous invocation', async () => {
    const registry = new ToolRegistry();
    let checkedParams: { value: string } | undefined;
    let permissionParams: JsonObject | undefined;
    const executeSpy = vi.fn(({ value }: { value: string }) =>
      completeToolExecution({
        status: 'success',
        model: value,
      }),
    );

    registerTool(
      registry,
      createTool({
        name: 'ImmutableInvocationTool',
        displayName: 'Immutable Invocation Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Immutable invocation tool' },
        schema: Type.Object({
          value: Type.String(),
        }),
        checkPermissions: (params) => {
          checkedParams = params;
          return { behavior: 'allow' };
        },
        execute: executeSpy,
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler: async (request) => {
        permissionParams = request.input;
        return {
          behavior: 'allow',
          updatedInput: { value: 'patched' },
        };
      },
    });

    const result = await executePipeline(
      pipeline,
      'ImmutableInvocationTool',
      { value: 'original' },
      { permissionMode: PermissionMode.YOLO },
    );

    expect(result).toMatchObject({ status: 'success', model: 'patched' });
    expect(checkedParams).toEqual({ value: 'original' });
    expect(permissionParams).toEqual({ value: 'original' });
    expect(Object.isFrozen(permissionParams)).toBe(true);
    expect(executeSpy).toHaveBeenCalledWith({ value: 'patched' }, expect.anything());
    expect(executeSpy.mock.calls[0]?.[0]).not.toBe(permissionParams);
  });

  it('uses preparePermissionMatcher to derive permission signatures after input updates', async () => {
    const registry = new ToolRegistry();
    const permissionHandler = vi.fn(async () => ({
      behavior: 'allow' as const,
      updatedInput: { value: 'patched' },
    }));

    registerTool(
      registry,
      createTool({
        name: 'PermissionMatcherTool',
        displayName: 'Permission Matcher Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Permission matcher tool' },
        schema: Type.Object({
          value: Type.String(),
        }),
        preparePermissionMatcher: ({ value }) => ({
          signatureContent: `sig:${value}`,
          abstractRule: `rule:${value}`,
        }),
        execute: ({ value }) =>
          completeToolExecution({
            status: 'success',
            model: value,
          }),
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler,
    });

    const result = await executePipeline(
      pipeline,
      'PermissionMatcherTool',
      { value: 'original' },
      { permissionMode: PermissionMode.YOLO },
    );

    expect(result.status).toBe('success');
    expect(permissionHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { value: 'patched' },
        toolMeta: expect.objectContaining({
          signature: 'PermissionMatcherTool:sig:patched',
        }),
      }),
    );
  });

  it('persists permission update effects for subsequent matching invocations', async () => {
    const registry = new ToolRegistry();
    const permissionHandler = vi.fn(async () => ({
      behavior: 'allow' as const,
      effects: [
        {
          type: 'permissionUpdates' as const,
          updates: [
            {
              type: 'addRules' as const,
              behavior: 'allow' as const,
              rules: [{ toolName: 'PermissionEffectTool', ruleContent: 'sig:patched' }],
            },
          ],
        },
      ],
      updatedInput: { value: 'patched' },
    }));
    const firstConfirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: true,
      })),
    };
    const secondConfirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: true,
      })),
    };

    registerTool(
      registry,
      createTool({
        name: 'PermissionEffectTool',
        displayName: 'Permission Effect Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Permission effect tool' },
        schema: Type.Object({
          value: Type.String(),
        }),
        preparePermissionMatcher: ({ value }) => ({
          signatureContent: `sig:${value}`,
        }),
        execute: ({ value }) =>
          completeToolExecution({
            status: 'success',
            model: value,
          }),
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.DEFAULT,
      permissionHandler,
    });

    const firstResult = await executePipeline(
      pipeline,
      'PermissionEffectTool',
      { value: 'original' },
      {
        permissionMode: PermissionMode.DEFAULT,
        confirmationHandler: firstConfirmationHandler,
      },
    );

    const secondResult = await executePipeline(
      pipeline,
      'PermissionEffectTool',
      { value: 'patched' },
      {
        permissionMode: PermissionMode.DEFAULT,
        confirmationHandler: secondConfirmationHandler,
      },
    );

    expect(firstResult.status).toBe('success');
    expect(firstConfirmationHandler.requestConfirmation).not.toHaveBeenCalled();
    expect(secondResult.status).toBe('success');
    expect(secondConfirmationHandler.requestConfirmation).not.toHaveBeenCalled();
  });

  it('preserves tool-level ask requirements even when permissionHandler allows', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(({ value }: { value: string }) =>
      completeToolExecution({
        status: 'success',
        model: value,
      }),
    );
    const confirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: false,
        reason: 'User rejected',
      })),
    };

    registerTool(
      registry,
      createTool({
        name: 'AskTool',
        displayName: 'Ask Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Tool-level ask tool' },
        schema: Type.Object({
          value: Type.String(),
        }),
        checkPermissions: () => ({
          behavior: 'ask',
          message: 'Tool requires confirmation',
        }),
        execute: executeSpy,
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler: async () => ({ behavior: 'allow' }),
    });

    const result = await executePipeline(
      pipeline,
      'AskTool',
      { value: 'pending' },
      {
        permissionMode: PermissionMode.YOLO,
        confirmationHandler,
      },
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('User rejected');
    expect(confirmationHandler.requestConfirmation).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('externalizes oversized string results using tool maxResultSizeChars', async () => {
    const registry = new ToolRegistry();
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-result-store-'));

    registerTool(
      registry,
      createTool({
        name: 'LimitedOutputTool',
        displayName: 'Limited Output Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        description: { short: 'Limited output tool' },
        schema: Type.Object({}),
        maxResultSizeChars: 32,
        execute: () =>
          completeToolExecution({
            status: 'success',
            model: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
          }),
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const result = await executePipeline(
      pipeline,
      'LimitedOutputTool',
      {},
      {
        permissionMode: PermissionMode.YOLO,
        contextSnapshot: {
          sessionId: SessionId('session-1'),
          turnId: TurnId('turn-1'),
          cwd: workspaceRoot,
          environment: {},
          filesystemRoots: [workspaceRoot],
          context: {
            capabilities: {
              filesystem: {
                roots: [workspaceRoot],
                cwd: workspaceRoot,
              },
            },
          },
        },
      },
    );

    expect(result.status).toBe('success');
    expect(typeof result.model).toBe('string');
    expect(result.model).not.toBe('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(String(result.model)).toContain('[externalized result');
    expect(result.metadata).toMatchObject({
      resultExternalized: true,
      resultSizeLimit: 32,
      modelContentOriginalLength: 52,
    });
    const artifactPath = String(result.metadata?.resultArtifactPath);
    expect(artifactPath).toContain('.blade-tool-results');
    const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8')) as {
      modelContent: string;
    };
    expect(artifact.modelContent).toBe('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it('forwards runtime effects through the execution stream', async () => {
    const registry = new ToolRegistry();
    const events: ToolYield[] = [];

    registerTool(
      registry,
      createTool({
        name: 'LegacyEffectTool',
        displayName: 'Legacy Effect Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'idempotent',
        description: { short: 'Legacy runtime effect tool' },
        schema: Type.Object({}),
        async *execute() {
          yield {
            kind: 'effect',
            effect: {
              type: 'runtimePatch',
              patch: {
                scope: 'turn',
                source: 'tool',
                toolDiscovery: {
                  discover: ['HeavyInspect'],
                },
              },
            },
          };
          yield {
            kind: 'effect',
            effect: {
              type: 'contextPatch',
              patch: {
                scope: 'turn',
                context: {
                  metadata: {
                    mode: 'debug',
                  },
                },
              },
            },
          };
          yield {
            kind: 'effect',
            effect: {
              type: 'newMessages',
              messages: [
                {
                  role: 'assistant',
                  content: 'injected',
                },
              ],
            },
          };
          return {
            status: 'success',
            model: 'ok',
          };
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const result = await executePipeline(
      pipeline,
      'LegacyEffectTool',
      {},
      { permissionMode: PermissionMode.YOLO },
      (event) => {
        events.push(event);
      },
    );

    expect(result.status).toBe('success');
    expect(events).toEqual([
      {
        kind: 'effect',
        effect: {
          type: 'runtimePatch',
          patch: {
            scope: 'turn',
            source: 'tool',
            toolDiscovery: {
              discover: ['HeavyInspect'],
            },
          },
        },
      },
      {
        kind: 'effect',
        effect: {
          type: 'contextPatch',
          patch: {
            scope: 'turn',
            context: {
              metadata: {
                mode: 'debug',
              },
            },
          },
        },
      },
      {
        kind: 'effect',
        effect: {
          type: 'newMessages',
          messages: [
            {
              role: 'assistant',
              content: 'injected',
            },
          ],
        },
      },
    ]);
  });

  it('uses dynamic invocation descriptions in confirmation titles', async () => {
    const registry = new ToolRegistry();
    const confirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: false,
        reason: 'User rejected',
      })),
    };

    registerTool(
      registry,
      createTool({
        name: 'DangerousTool',
        displayName: 'Dangerous Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Dangerous tool' },
        describe: (params) => ({
          short: params?.target ? `Delete file: ${params.target}` : 'Dangerous tool',
        }),
        schema: Type.Object({
          target: Type.String(),
        }),
        checkPermissions: () => ({
          behavior: 'ask',
          message: 'Needs confirmation',
        }),
        execute: ({ target }) =>
          completeToolExecution({
            status: 'success',
            model: target,
          }),
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler: async () => ({ behavior: 'allow' }),
    });

    const result = await executePipeline(
      pipeline,
      'DangerousTool',
      { target: '/tmp/secret.txt' },
      {
        permissionMode: PermissionMode.YOLO,
        confirmationHandler,
      },
    );

    expect(result.status).toBe('error');
    expect(confirmationHandler.requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '权限确认: Delete file: /tmp/secret.txt',
      }),
    );
  });

  it('denies dangerous paths before tool execution', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(({ file_path }: { file_path: string }) =>
      completeToolExecution({
        status: 'success',
        model: file_path,
      }),
    );

    registerTool(
      registry,
      createTool({
        name: 'DangerousPathTool',
        displayName: 'Dangerous Path Tool',
        kind: ToolKind.Write,
        sideEffect: 'non_idempotent',
        description: { short: 'Writes to a file' },
        schema: Type.Object({
          file_path: Type.String(),
        }),
        execute: executeSpy,
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const result = await executePipeline(
      pipeline,
      'DangerousPathTool',
      { file_path: '/etc/passwd' },
      { permissionMode: PermissionMode.YOLO },
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('Access to dangerous system paths denied');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('applies path safety to the canonical target before locking and execution', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-canonical-path-'));
    const sshDirectory = path.join(workspaceRoot, '.ssh');
    const sensitiveFile = path.join(sshDirectory, 'id_rsa');
    const alias = path.join(workspaceRoot, 'safe.txt');
    await fs.mkdir(sshDirectory);
    await fs.writeFile(sensitiveFile, 'private-key');
    await fs.symlink(sensitiveFile, alias);
    const registry = new ToolRegistry();
    registerTool(registry, readTool);
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    try {
      const result = await executePipeline(
        pipeline,
        'Read',
        { file_path: alias, encoding: 'utf8' },
        {
          permissionMode: PermissionMode.YOLO,
          contextSnapshot: {
            sessionId: SessionId('canonical-path-session'),
            turnId: TurnId('turn-1'),
            cwd: workspaceRoot,
            environment: {},
            filesystemRoots: [workspaceRoot],
            context: {
              capabilities: {
                filesystem: {
                  roots: [workspaceRoot],
                  cwd: workspaceRoot,
                },
              },
            },
          },
        },
      );

      expect(result.status).toBe('error');
      expect(result.error?.message).toContain('highly sensitive files denied');
      expect(result.model).not.toContain('private-key');
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps explicit sensitive-path confirmation even after downstream permission allows', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(({ file_path }: { file_path: string }) =>
      completeToolExecution({
        status: 'success',
        model: file_path,
      }),
    );
    const confirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: false,
        reason: 'User rejected sensitive file access',
      })),
    };

    registerTool(
      registry,
      createTool({
        name: 'SensitiveReadTool',
        displayName: 'Sensitive Read Tool',
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        preparePermissionMatcher: ({ file_path }) => ({
          signatureContent: file_path,
        }),
        description: { short: 'Reads a sensitive file' },
        schema: Type.Object({
          file_path: Type.String(),
        }),
        execute: executeSpy,
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionConfig: {
        allow: ['SensitiveReadTool:/tmp/id_rsa'],
      },
      permissionHandler: async () => ({ behavior: 'allow' }),
    });

    const result = await executePipeline(
      pipeline,
      'SensitiveReadTool',
      { file_path: '/tmp/id_rsa' },
      {
        permissionMode: PermissionMode.YOLO,
        confirmationHandler,
      },
    );

    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('User rejected sensitive file access');
    expect(confirmationHandler.requestConfirmation).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('awaits permission and execution lifecycle boundaries before invoking a tool', async () => {
    const registry = new ToolRegistry();
    const events: string[] = [];

    registerTool(
      registry,
      createTool({
        name: 'LifecycleTool',
        displayName: 'Lifecycle Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Lifecycle tool' },
        schema: Type.Object({ value: Type.String() }),
        checkPermissions: () => ({
          behavior: 'ask',
          message: 'Confirm lifecycle tool',
        }),
        execute: ({ value }) => {
          events.push(`execute:${value}`);
          return completeToolExecution({
            status: 'success',
            model: value,
          });
        },
      }),
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler: async () => ({
        behavior: 'allow',
        updatedInput: { value: 'updated' },
      }),
    });
    const result = await executePipeline(
      pipeline,
      'LifecycleTool',
      { value: 'ok' },
      {
        permissionMode: PermissionMode.YOLO,
        confirmationHandler: {
          requestConfirmation: async () => {
            events.push('permission-handler');
            return { approved: true };
          },
        },
        toolInvocationLifecycle: {
          onPermissionRequested: async (_details, input) => {
            events.push('permission-requested');
            input.value = 'mutated';
            return PermissionRequestId('permission-1');
          },
          onPermissionResolved: async ({ decision }) => {
            events.push(`permission-resolved:${decision}`);
          },
          onExecutionStarted: async ({ input, sideEffect }) => {
            events.push(`execution-started:${String(input.value)}:${sideEffect}`);
          },
        },
      },
    );

    expect(result.status).toBe('success');
    expect(events).toEqual([
      'permission-requested',
      'permission-handler',
      'permission-resolved:allow',
      'execution-started:updated:non_idempotent',
      'execute:updated',
    ]);
  });

  it('records denied and cancelled permission decisions without starting execution', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'PermissionLifecycleTool',
        displayName: 'Permission Lifecycle Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Permission lifecycle tool' },
        schema: Type.Object({}),
        checkPermissions: () => ({ behavior: 'ask', message: 'Confirm' }),
        execute: executeSpy,
      }),
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler: async () => ({ behavior: 'allow' }),
    });

    const denied: string[] = [];
    const deniedResult = await executePipeline(
      pipeline,
      'PermissionLifecycleTool',
      {},
      {
        permissionMode: PermissionMode.YOLO,
        confirmationHandler: {
          requestConfirmation: async () => ({ approved: false, reason: 'no' }),
        },
        toolInvocationLifecycle: {
          onPermissionRequested: async () => PermissionRequestId('permission-denied'),
          onPermissionResolved: async ({ decision }) => {
            denied.push(decision);
          },
          onExecutionStarted: async () => {
            denied.push('started');
          },
        },
      },
    );

    const cancelled: string[] = [];
    const cancelledResult = await executePipeline(
      pipeline,
      'PermissionLifecycleTool',
      {},
      {
        permissionMode: PermissionMode.YOLO,
        confirmationHandler: {
          requestConfirmation: async () => {
            throw new Error('prompt closed');
          },
        },
        toolInvocationLifecycle: {
          onPermissionRequested: async () => PermissionRequestId('permission-cancelled'),
          onPermissionResolved: async ({ decision }) => {
            cancelled.push(decision);
          },
          onExecutionStarted: async () => {
            cancelled.push('started');
          },
        },
      },
    );

    expect(deniedResult.status).toBe('error');
    expect(cancelledResult.status).toBe('error');
    expect(denied).toEqual(['deny']);
    expect(cancelled).toEqual(['cancel']);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('blocks the side effect when an execution-start lifecycle boundary fails', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'BlockedLifecycleTool',
        displayName: 'Blocked Lifecycle Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Blocked lifecycle tool' },
        schema: Type.Object({}),
        execute: executeSpy,
      }),
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const result = await executePipeline(
      pipeline,
      'BlockedLifecycleTool',
      {},
      {
        permissionMode: PermissionMode.YOLO,
        toolInvocationLifecycle: {
          onExecutionStarted: async () => {
            throw new Error('durable write failed');
          },
        },
      },
    );

    expect(result).toMatchObject({
      status: 'error',
      error: {
        message: 'durable write failed',
      },
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('checks the execution fence immediately before the tool side effect', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'FencedTool',
        displayName: 'Fenced Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Fenced tool' },
        schema: Type.Object({}),
        execute: executeSpy,
      }),
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const leaseError = new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      'execution lease lost',
    );
    const assertExecutionLease = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(leaseError);

    await expect(
      executePipeline(
        pipeline,
        'FencedTool',
        {},
        {
          permissionMode: PermissionMode.YOLO,
          runtime: { assertExecutionLease },
          toolInvocationLifecycle: {
            onExecutionStarted: async () => {},
          },
        },
      ),
    ).rejects.toBe(leaseError);
    expect(assertExecutionLease).toHaveBeenCalledTimes(3);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('rechecks the execution fence after lock acquisition and before hooks', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'QueuedFencedTool',
        displayName: 'Queued Fenced Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Queued fenced tool' },
        schema: Type.Object({}),
        execute: executeSpy,
      }),
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const assertExecutionLease = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('execution lease lost while queued'));
    const onExecutionStarted = vi.fn(async () => {});

    await expect(
      executePipeline(
        pipeline,
        'QueuedFencedTool',
        {},
        {
          permissionMode: PermissionMode.YOLO,
          runtime: { assertExecutionLease },
          toolInvocationLifecycle: { onExecutionStarted },
        },
      ),
    ).rejects.toThrow('execution lease lost while queued');

    expect(assertExecutionLease).toHaveBeenCalledTimes(2);
    expect(onExecutionStarted).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('blocks the side effect when cancellation wins during the execution-start boundary', async () => {
    const registry = new ToolRegistry();
    const boundary = deferred();
    const boundaryStarted = deferred();
    const executeSpy = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'CancelledBoundaryTool',
        displayName: 'Cancelled Boundary Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Cancellation boundary tool' },
        schema: Type.Object({}),
        execute: executeSpy,
      }),
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const controller = new AbortController();
    const resultPromise = executePipeline(
      pipeline,
      'CancelledBoundaryTool',
      {},
      {
        permissionMode: PermissionMode.YOLO,
        signal: controller.signal,
        toolInvocationLifecycle: {
          onExecutionStarted: async () => {
            boundaryStarted.resolve();
            await boundary.promise;
          },
        },
      },
    );

    await boundaryStarted.promise;
    controller.abort();
    boundary.resolve();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      error: {
        message: 'Task was aborted before tool execution',
      },
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('blocks the side effect when permission resolution cannot be persisted', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    registerTool(
      registry,
      createTool({
        name: 'PermissionResolutionTool',
        displayName: 'Permission Resolution Tool',
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        description: { short: 'Permission resolution tool' },
        schema: Type.Object({}),
        checkPermissions: () => ({ behavior: 'ask', message: 'Confirm' }),
        execute: executeSpy,
      }),
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      permissionHandler: async () => ({ behavior: 'allow' }),
    });

    const result = await executePipeline(
      pipeline,
      'PermissionResolutionTool',
      {},
      {
        permissionMode: PermissionMode.YOLO,
        confirmationHandler: {
          requestConfirmation: async () => ({ approved: true }),
        },
        toolInvocationLifecycle: {
          onPermissionRequested: async () => PermissionRequestId('permission-1'),
          onPermissionResolved: async () => {
            throw new Error('resolution write failed');
          },
          onExecutionStarted: async () => {
            throw new Error('must not start');
          },
        },
      },
    );

    expect(result).toMatchObject({
      status: 'error',
      error: {
        message: expect.stringContaining('resolution write failed'),
      },
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
