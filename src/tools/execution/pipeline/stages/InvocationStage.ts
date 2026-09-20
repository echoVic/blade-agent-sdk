import { isSteeringInterruptSignal } from '../../../../types/abort.js';
import { getErrorMessage, getErrorName } from '../../../../utils/errorUtils.js';
import { executePreparedTool } from '../../../core/createTool.js';
import { getRuntimeAccess } from '../../../types/execution.js';
import type { ToolExecution, ToolResult, ToolYield } from '../../../types/result.js';
import { ToolErrorType } from '../../../types/result.js';
import { createAbortedResult, createExecutionFailureResult } from '../results.js';
import type { PipelineExecutionState } from '../state.js';
import { isTerminalCleanupFailure, type TerminalCleanupGuard } from '../TerminalCleanupGuard.js';
import { getToolContext } from '../toolContext.js';

/** Hard ceiling on how long a caller waits for a tool generator to close. */
export const MAX_TOOL_CLEANUP_WAIT_MS = 5_000;

/**
 * Invocation stage: runs the tool under a deadline and owns its cleanup.
 *
 * The tool generator is drained step by step so progress events can be yielded
 * while the deadline stays active even if the consumer pauses. A tool that
 * ignores cancellation is closed in the background and tracked by the guard:
 * the pipeline refuses further tools until that cleanup settles.
 */
export class InvocationStage {
  constructor(
    private readonly toolTimeoutMs: number,
    private readonly guard: TerminalCleanupGuard,
  ) {}

  async *run(state: PipelineExecutionState): AsyncGenerator<ToolYield, void, void> {
    const invocation = state.invocation;
    if (!invocation) {
      state.result = createAbortedResult('Pre-execution stage failed; cannot run tool');
      return;
    }
    if (this.guard.hasPendingCleanup()) {
      state.result = this.guard.createPendingResult();
      return;
    }

    await state.context.toolInvocationLifecycle?.onExecutionStarted?.({
      input: structuredClone(invocation.params),
      sideEffect: invocation.behavior.sideEffect,
    });
    await getRuntimeAccess(state.context).assertExecutionLease();
    this.guard.throwIfFailed();
    if (this.guard.hasPendingCleanup()) {
      state.result = this.guard.createPendingResult();
      return;
    }
    if (state.context.signal?.aborted) {
      state.result = createAbortedResult('Task was aborted before tool execution');
      return;
    }

    let completed = false;
    let lateCriticalFailure: unknown;
    let timedOut = false;
    const timeoutController = new AbortController();
    const timeoutError = this.createTimeoutError(state.toolName);
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort(timeoutError);
    }, this.toolTimeoutMs);
    const executionSignal = state.context.signal
      ? AbortSignal.any([state.context.signal, timeoutController.signal])
      : timeoutController.signal;
    const execution = executePreparedTool(state.tool, invocation.params, {
      ...getToolContext(state.tool, state.context, state.services),
      signal: executionSignal,
    });

    try {
      while (true) {
        const step = await this.nextExecutionStep(execution, executionSignal, (error) => {
          if (isTerminalCleanupFailure(error)) {
            lateCriticalFailure ??= error;
            this.guard.remember(error);
          }
        });
        timeoutController.signal.throwIfAborted();
        if (step.done) {
          let finalResult = step.value;
          if (finalResult.status === 'error' && isSteeringInterruptSignal(executionSignal)) {
            state.interrupted = true;
            finalResult = {
              ...finalResult,
              error: {
                ...finalResult.error,
                type: ToolErrorType.INTERRUPTED,
              },
            };
          }
          state.result = finalResult;
          completed = true;
          break;
        }
        yield step.value;
      }
    } catch (error) {
      if (isTerminalCleanupFailure(error)) {
        throw error;
      }
      timedOut = timeoutController.signal.aborted || getErrorName(error) === 'TimeoutError';
      state.interrupted = !timedOut && isSteeringInterruptSignal(executionSignal);
      // A steering-aborted signal does not guarantee the caught error IS the
      // interruption: nextExecutionStep can also surface a genuine error the
      // tool threw in the same tick, before the abort rejection wins the race.
      // Only the abort reason itself gets the generic sentence; any other
      // error keeps its own message even though the result is still
      // classified as interrupted, since the signal really was aborted for
      // that reason.
      const isTheAbortReason = state.interrupted && error === executionSignal.reason;
      state.result = createExecutionFailureResult(
        timedOut
          ? `Tool execution timeout after ${this.toolTimeoutMs}ms`
          : isTheAbortReason
            ? 'Interrupted by a new instruction'
            : getErrorMessage(error),
        timedOut
          ? ToolErrorType.TIMEOUT_ERROR
          : state.interrupted
            ? ToolErrorType.INTERRUPTED
            : ToolErrorType.EXECUTION_ERROR,
      );
    } finally {
      clearTimeout(timeout);
      if (!completed) {
        if (!executionSignal.aborted) {
          timeoutController.abort(new Error('Tool execution closed before completion'));
        }
        const closing = Promise.resolve(execution.return(undefined as never)).then(
          () => undefined,
          (error) => {
            if (isTerminalCleanupFailure(error)) {
              lateCriticalFailure ??= error;
              this.guard.remember(error);
              throw error;
            }
          },
        );
        this.guard.trackExecutionCleanup(closing);
        await this.waitForExecutionClose(closing);
      }
    }
    if (lateCriticalFailure) {
      throw lateCriticalFailure;
    }
  }

  private async nextExecutionStep(
    execution: ToolExecution,
    signal: AbortSignal,
    onLateFailure: (error: unknown) => void,
  ): Promise<IteratorResult<ToolYield, ToolResult>> {
    if (signal.aborted) {
      throw signal.reason;
    }

    return new Promise<IteratorResult<ToolYield, ToolResult>>((resolve, reject) => {
      let settled = false;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (abortTimer !== undefined) {
          clearTimeout(abortTimer);
        }
        signal.removeEventListener('abort', onAbort);
      };
      const resolveOnce = (step: IteratorResult<ToolYield, ToolResult>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(step);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        // Preserve a terminal result produced in the same turn as cancellation.
        abortTimer = setTimeout(() => rejectOnce(signal.reason), 0);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      execution.next().then(resolveOnce, (error) => {
        if (settled) {
          onLateFailure(error);
          return;
        }
        rejectOnce(error);
      });
    });
  }

  private async waitForExecutionClose(closing: PromiseLike<unknown>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(finish, MAX_TOOL_CLEANUP_WAIT_MS);
      closing.then(finish, fail);
    });
  }

  private createTimeoutError(toolName: string): Error {
    const error = new Error(`Tool "${toolName}" timed out after ${this.toolTimeoutMs}ms`);
    error.name = 'TimeoutError';
    return error;
  }
}
