import type { InternalLogger } from '../../../logging/Logger.js';
import { composeMiddleware } from '../../../middleware/composeMiddleware.js';
import type { ToolMiddleware, ToolMiddlewareRequest } from '../../../middleware/ToolMiddleware.js';
import type { JsonObject } from '../../../types/json.js';
import { getErrorMessage } from '../../../utils/errorUtils.js';
import { resolveBehavior, ToolSideEffect } from '../../behavior.js';
import type { ToolRegistry } from '../../registry/ToolRegistry.js';
import { type ExecutionContext, getRuntimeAccess } from '../../types/execution.js';
import {
  ToolErrorType,
  type ToolExecution,
  type ToolResult,
  type ToolYield,
} from '../../types/result.js';
import { createExecutionFailureResult, preserveTimeoutFailure } from './results.js';
import { createSignalAbortResult } from './signalAbort.js';
import { isTerminalCleanupFailure } from './TerminalCleanupGuard.js';

/**
 * Raised when the tool's own execution (below the middleware chain) fails, so
 * the boundary can tell a core failure apart from a middleware failure.
 */
class ToolCoreExecutionError extends Error {
  constructor(readonly cause: unknown) {
    super('Tool core execution failed', { cause });
    this.name = 'ToolCoreExecutionError';
  }
}

export interface MiddlewareBoundaryInput {
  toolName: string;
  params: JsonObject;
  /** Frozen, lease-asserted context shared by every middleware and the core. */
  context: ExecutionContext;
  /** Runs the tool itself; called by the innermost middleware or by the chain end. */
  executeCore: (request: ToolMiddlewareRequest) => ToolExecution;
}

export interface MiddlewareBoundaryOutcome {
  result: ToolResult;
  effectiveRequest: ToolMiddlewareRequest;
  coreStarted: boolean;
}

/**
 * Outermost boundary: the middleware chain.
 *
 * Middleware may rewrite input, short-circuit a call, or delegate to the core
 * execution. This boundary pins the invariants (middleware cannot swap the tool
 * name, the frozen context, or the interrupt behavior) and reconciles the
 * middleware's result with the core result, so a middleware can never mask a
 * core failure or a timeout.
 */
export class MiddlewareBoundary {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly middleware: readonly ToolMiddleware[],
    private readonly logger: InternalLogger,
  ) {}

  async *run(
    input: MiddlewareBoundaryInput,
  ): AsyncGenerator<ToolYield, MiddlewareBoundaryOutcome, void> {
    const { toolName, context: protectedContext } = input;
    const initialRequest: ToolMiddlewareRequest = {
      toolName,
      input: { ...input.params },
      context: protectedContext,
    };
    const initialBehavior = resolveBehavior(this.registry.get(toolName), initialRequest.input);
    let effectiveRequest = initialRequest;
    let delegatedExecution: ToolExecution | undefined;
    let coreStarted = false;
    let coreCompleted = false;
    let coreResult: ToolResult | undefined;
    let coreFailure: ToolCoreExecutionError | undefined;
    let result: ToolResult | undefined;

    const captureRequest = (request: ToolMiddlewareRequest): ToolMiddlewareRequest => {
      if (request.toolName !== toolName) {
        throw new Error('Tool middleware cannot change the tool name');
      }
      if (request.context !== protectedContext) {
        throw new Error('Tool middleware cannot replace the execution context');
      }
      const effectiveBehavior = resolveBehavior(this.registry.get(toolName), request.input);
      if (
        initialBehavior &&
        effectiveBehavior &&
        initialBehavior.interruptBehavior !== effectiveBehavior.interruptBehavior
      ) {
        throw new Error('Tool middleware cannot change the tool interrupt behavior');
      }
      effectiveRequest = Object.freeze({
        toolName: request.toolName,
        input: { ...request.input },
        context: request.context,
      });
      return effectiveRequest;
    };

    const trackedCore = async function* (request: ToolMiddlewareRequest): ToolExecution {
      coreStarted = true;
      try {
        const coreValue = yield* input.executeCore(request);
        coreCompleted = true;
        coreResult = coreValue;
        return coreValue;
      } catch (error) {
        const failure = new ToolCoreExecutionError(error);
        coreFailure = failure;
        throw failure;
      }
    };

    const guardedMiddleware = this.middleware.map<ToolMiddleware>(
      (middleware) => (request, next) => {
        const capturedRequest = captureRequest(request);
        return middleware(capturedRequest, (nextRequest = capturedRequest) => next(nextRequest));
      },
    );
    const execute = composeMiddleware(
      guardedMiddleware,
      (request: ToolMiddlewareRequest): ToolExecution => {
        const coreRequest = captureRequest(request);
        delegatedExecution = trackedCore(coreRequest);
        return delegatedExecution;
      },
    );

    if (protectedContext.signal?.aborted) {
      result = createSignalAbortResult(protectedContext.signal);
    } else {
      try {
        result = yield* execute(initialRequest);
        if (coreFailure) {
          throw coreFailure;
        }
        if (coreStarted && !coreCompleted && delegatedExecution) {
          this.logger.warn(
            `Tool middleware returned before delegated ${toolName} execution completed; draining the core execution`,
          );
          result = yield* delegatedExecution;
        }
        if (
          coreResult?.status === 'error' &&
          coreResult.error.type === ToolErrorType.TIMEOUT_ERROR
        ) {
          result = preserveTimeoutFailure(
            this.logger,
            coreResult,
            result,
            `Tool middleware for ${toolName}`,
          );
        } else if (coreResult?.status === 'error' && result.status === 'success') {
          this.logger.warn(
            `Tool middleware attempted to replace failed ${toolName} core execution with success; preserving the core failure`,
          );
          result = coreResult;
        }
      } catch (error) {
        if (coreFailure) {
          throw coreFailure.cause;
        }
        if (error instanceof ToolCoreExecutionError) {
          throw error.cause;
        }
        if (isTerminalCleanupFailure(error)) {
          throw error;
        }
        const signalReason = protectedContext.signal?.reason;
        if (isTerminalCleanupFailure(signalReason)) {
          throw signalReason;
        }
        if (
          coreCompleted &&
          coreResult?.status === 'error' &&
          coreResult.error.type === ToolErrorType.TIMEOUT_ERROR
        ) {
          this.logger.warn(
            `Tool middleware failed after ${toolName} timed out; preserving the core timeout`,
          );
          result = coreResult;
        } else if (protectedContext.signal?.aborted) {
          result = createSignalAbortResult(protectedContext.signal);
        } else {
          result = createExecutionFailureResult(
            `Tool middleware failed: ${getErrorMessage(error)}`,
          );
        }
      }
    }

    if (protectedContext.signal?.aborted) {
      if (coreCompleted && coreResult) {
        result = coreResult;
      } else {
        result = createSignalAbortResult(protectedContext.signal);
      }
    }
    if (!coreStarted && result.status === 'success') {
      effectiveRequest = captureRequest(effectiveRequest);
      await this.recordMiddlewareShortCircuit(effectiveRequest);
    }

    return { result, effectiveRequest, coreStarted };
  }

  /**
   * A short-circuited call never reaches the tool, but observers still need to
   * know that a side effect was announced and that the fence still holds.
   */
  private async recordMiddlewareShortCircuit(request: ToolMiddlewareRequest): Promise<void> {
    const tool = this.registry.get(request.toolName);
    const sideEffect =
      resolveBehavior(tool, request.input)?.sideEffect ??
      tool?.staticBehavior.sideEffect ??
      ToolSideEffect.NON_IDEMPOTENT;
    await getRuntimeAccess(request.context).assertExecutionLease();
    await request.context.toolInvocationLifecycle?.onExecutionStarted?.({
      input: structuredClone(request.input),
      sideEffect,
    });
  }
}
