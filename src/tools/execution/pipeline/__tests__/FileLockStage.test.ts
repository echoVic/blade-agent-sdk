import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../../../logging/Logger.js';
import { PermissionMode } from '../../../../types/constants.js';
import type { JsonObject } from '../../../../types/json.js';
import { ToolKind, ToolSideEffect } from '../../../behavior.js';
import { ToolErrorType } from '../../../types/result.js';
import { FileLockManager } from '../../FileLockManager.js';
import { FileLockStage } from '../stages/FileLockStage.js';
import type { PipelineExecutionState } from '../state.js';
import { TerminalCleanupGuard } from '../TerminalCleanupGuard.js';

function createState(params: JsonObject): PipelineExecutionState {
  return {
    toolName: 'Write',
    tool: {
      name: 'Write',
      kind: ToolKind.Write,
      sideEffect: ToolSideEffect.NON_IDEMPOTENT,
    } as unknown as PipelineExecutionState['tool'],
    params,
    context: { permissionMode: PermissionMode.DEFAULT },
    services: {},
    affectedPaths: [],
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

    const readState = createState({ file_path: '/tmp/read.txt' });
    readState.resolvedBehavior = {
      kind: ToolKind.ReadOnly,
      sideEffect: ToolSideEffect.PURE,
      isReadOnly: true,
      isConcurrencySafe: true,
      isDestructive: false,
    } as PipelineExecutionState['resolvedBehavior'];
    await stage.acquire(readState);
    expect(acquire).toHaveBeenLastCalledWith('/tmp/read.txt', 'read', undefined);

    const writeState = createState({ notebook_path: '/tmp/notebook.ipynb' });
    writeState.resolvedBehavior = {
      kind: ToolKind.Write,
      sideEffect: ToolSideEffect.NON_IDEMPOTENT,
      isReadOnly: false,
      isConcurrencySafe: false,
      isDestructive: true,
    } as PipelineExecutionState['resolvedBehavior'];
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
