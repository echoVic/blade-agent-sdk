import type { InternalLogger } from '../../../../logging/Logger.js';
import { FileLockManager } from '../../FileLockManager.js';
import { createSignalAbortResult } from '../signalAbort.js';
import { getFileLockPath, type PipelineExecutionState } from '../state.js';
import type { TerminalCleanupGuard } from '../TerminalCleanupGuard.js';

/**
 * File-lock stage: serializes writers against readers of the same target.
 *
 * The lock is acquired only after validation and approval, so permissions are
 * decided on canonical paths before any queueing happens, and the lease stays on
 * the state until the orchestrator releases it after post-execution hooks.
 */
export class FileLockStage {
  constructor(
    private readonly logger: InternalLogger,
    private readonly guard: TerminalCleanupGuard,
  ) {}

  async acquire(state: PipelineExecutionState): Promise<void> {
    const filePath = getFileLockPath(state.params);
    const lockMode =
      state.resolvedBehavior?.isReadOnly === true && state.resolvedBehavior.isConcurrencySafe
        ? 'read'
        : 'write';
    try {
      state.fileLease = filePath
        ? await FileLockManager.getInstance(this.logger).acquire(
            filePath,
            lockMode,
            state.context.signal,
          )
        : undefined;
    } catch (error) {
      if (state.context.signal?.aborted) {
        state.result = createSignalAbortResult(state.context.signal);
      } else {
        throw error;
      }
    }
    this.guard.throwIfFailed();
    if (!state.result) {
      state.context.signal?.throwIfAborted();
    }
    if (this.guard.hasPendingCleanup()) {
      state.result = this.guard.createPendingResult();
    }
  }
}
