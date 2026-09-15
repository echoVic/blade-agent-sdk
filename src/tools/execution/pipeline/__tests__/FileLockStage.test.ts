import Type from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../../../logging/Logger.js';
import { PermissionMode } from '../../../../types/constants.js';
import type { JsonObject } from '../../../../types/json.js';
import { ToolKind, ToolSideEffect } from '../../../behavior.js';
import { createTool } from '../../../core/createTool.js';
import { completeToolExecution, ToolErrorType } from '../../../types/result.js';
import { FileLockManager } from '../../FileLockManager.js';
import { FileLockStage } from '../stages/FileLockStage.js';
import type { PipelineExecutionState } from '../state.js';
import { TerminalCleanupGuard } from '../TerminalCleanupGuard.js';

function createState(params: JsonObject, kind: ToolKind = ToolKind.Write): PipelineExecutionState {
  const tool = createTool({
    name: 'Write',
    displayName: 'Write',
    kind,
    sideEffect: kind === ToolKind.ReadOnly ? ToolSideEffect.PURE : ToolSideEffect.NON_IDEMPOTENT,
    description: { short: 'Test tool' },
    schema: Type.Unsafe<JsonObject>({
      type: 'object',
      additionalProperties: true,
    }),
    execute: () =>
      completeToolExecution({
        status: 'success',
        model: 'ok',
      }),
  });
  return {
    toolName: 'Write',
    tool,
    params,
    invocation: tool.prepare(params),
    context: { permissionMode: PermissionMode.DEFAULT },
    services: {},
    needsConfirmation: false,
    confirmationReasons: [],
    interrupted: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FileLockStage', () => {
  it('takes a read lease only for read-only concurrency-safe invocations', async () => {
    const acquire = vi
      .spyOn(FileLockManager.prototype, 'acquire')
      .mockResolvedValue({ release: vi.fn() } as never);
    const stage = new FileLockStage(NOOP_LOGGER, new TerminalCleanupGuard());

    const readState = createState({ file_path: '/tmp/read.txt' }, ToolKind.ReadOnly);
    await stage.acquire(readState);
    expect(acquire).toHaveBeenLastCalledWith('/tmp/read.txt', 'read', undefined);

    const writeState = createState({ notebook_path: '/tmp/notebook.ipynb' });
    await stage.acquire(writeState);
    expect(acquire).toHaveBeenLastCalledWith('/tmp/notebook.ipynb', 'write', undefined);
  });

  it('does not take a lease when the invocation has no file target', async () => {
    const acquire = vi.spyOn(FileLockManager.prototype, 'acquire');
    const stage = new FileLockStage(NOOP_LOGGER, new TerminalCleanupGuard());

    const state = createState({ command: 'ls' });
    await stage.acquire(state);

    expect(acquire).not.toHaveBeenCalled();
    expect(state.fileLease).toBeUndefined();
    expect(state.result).toBeUndefined();
  });

  it('turns a lock rejection caused by cancellation into an aborted result', async () => {
    vi.spyOn(FileLockManager.prototype, 'acquire').mockRejectedValue(
      new Error('lock wait aborted'),
    );
    const stage = new FileLockStage(NOOP_LOGGER, new TerminalCleanupGuard());

    const controller = new AbortController();
    const state = createState({ file_path: '/tmp/held.txt' });
    state.context.signal = controller.signal;
    controller.abort(new Error('user cancelled'));

    await stage.acquire(state);

    expect(state.result).toMatchObject({
      status: 'error',
      error: { type: ToolErrorType.EXECUTION_ERROR, message: '任务已被用户中止' },
    });
  });

  it('rethrows a lock failure that is not caused by cancellation', async () => {
    const failure = new Error('lock manager exploded');
    vi.spyOn(FileLockManager.prototype, 'acquire').mockRejectedValue(failure);
    const stage = new FileLockStage(NOOP_LOGGER, new TerminalCleanupGuard());

    const state = createState({ file_path: '/tmp/held.txt' });
    await expect(stage.acquire(state)).rejects.toBe(failure);
    expect(state.result).toBeUndefined();
  });
});
