import { isHookProcessContainmentError } from '../../../hooks/WindowsProcessJob.js';
import { isExecutionLeaseFailure } from '../../../session/events/DurableExecutionLeaseStore.js';
import { awaitWithAbortSignal, getAbortSignalReason } from '../../../utils/abortPromise.js';
import type { ToolResult } from '../../types/result.js';
import { createPendingCleanupResult } from './results.js';

/**
 * A failure that leaves execution ownership or process containment unprovable.
 * Once observed, the owning pipeline instance must stop executing tools.
 */
export function isTerminalCleanupFailure(error: unknown): boolean {
  return isExecutionLeaseFailure(error) || isHookProcessContainmentError(error);
}

/**
 * Owns everything that outlives a single tool call: terminal quarantines, tool
 * generators that are still closing, and permission callbacks that were
 * cancelled but have not settled yet.
 *
 * Stages report through this guard instead of tracking cleanup locally, so the
 * quarantine decision (and the refusal to start new work) has exactly one owner.
 */
export class TerminalCleanupGuard {
  private terminalFailure: unknown;
  private readonly pendingExecutionCleanups = new Set<Promise<void>>();
  private readonly activePermissionCallbacks = new Map<Promise<void>, AbortSignal>();

  hasPendingExecutionCleanup(): boolean {
    return this.pendingExecutionCleanups.size > 0;
  }

  hasPendingPermissionCleanup(): boolean {
    for (const signal of this.activePermissionCallbacks.values()) {
      if (signal.aborted) {
        return true;
      }
    }
    return false;
  }

  hasPendingCleanup(): boolean {
    return this.hasPendingExecutionCleanup() || this.hasPendingPermissionCleanup();
  }

  getTerminalFailure(): unknown {
    return this.terminalFailure;
  }

  /** Record the first terminal failure; later failures cannot replace it. */
  remember(error: unknown): void {
    if (this.terminalFailure === undefined && isTerminalCleanupFailure(error)) {
      this.terminalFailure = error;
    }
  }

  throwIfFailed(): void {
    if (this.terminalFailure !== undefined) {
      throw this.terminalFailure;
    }
  }

  createPendingResult(): ToolResult {
    return createPendingCleanupResult(
      this.hasPendingPermissionCleanup() ? 'permission callback' : 'tool execution',
    );
  }

  /** Track a tool generator that is closing in the background. */
  trackExecutionCleanup(closing: Promise<void>): void {
    this.pendingExecutionCleanups.add(closing);
    void closing.then(
      () => {
        this.pendingExecutionCleanups.delete(closing);
      },
      (error) => {
        this.pendingExecutionCleanups.delete(closing);
        this.remember(error);
      },
    );
  }

  /**
   * Run a permission/validation callback that may outlive its abort signal.
   *
   * The callback is attached to the guard *before* awaiting, so a cancelled
   * callback that rejects later still quarantines the pipeline instead of
   * becoming an unhandled rejection.
   */
  async awaitPermissionCallback<T>(
    operation: () => T | PromiseLike<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (!signal) {
      return await operation();
    }

    signal.throwIfAborted();
    const callback = Promise.resolve().then(operation);
    const cleanup = callback.then(
      () => undefined,
      (error) => {
        this.remember(error);
      },
    );
    this.activePermissionCallbacks.set(cleanup, signal);
    void cleanup.finally(() => {
      this.activePermissionCallbacks.delete(cleanup);
    });

    try {
      const result = await awaitWithAbortSignal(() => callback, signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (isTerminalCleanupFailure(error)) {
        throw error;
      }
      if (signal.aborted) {
        throw getAbortSignalReason(signal);
      }
      throw error;
    }
  }
}
