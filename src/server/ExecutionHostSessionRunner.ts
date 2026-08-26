import type {
  ExecutionCheckpoint,
  ExecutionExecRequest,
  ExecutionExecResult,
  ExecutionHandle,
  ExecutionProvisionRequest,
} from '../execution/ExecutionHost.js';
import { ExecutionCheckpointId } from '../types/identifiers.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type { SessionRunner, SessionRunnerContext, SessionRunResult } from './SessionRunner.js';

export const EXECUTION_HOST_ROUTE_METADATA_KEY = 'bladeExecution' as const;
export const EXECUTION_HOST_ROUTE_METADATA_VERSION = 1 as const;

export type ExecutionCheckpointPolicy = 'none' | 'suspend' | 'park';

export interface ExecutionHostSessionPlan {
  readonly provision: Omit<ExecutionProvisionRequest, 'executionId' | 'signal'>;
  readonly command: Omit<ExecutionExecRequest, 'signal'>;
  readonly checkpoint?: ExecutionCheckpointPolicy;
  readonly checkpointMetadata?: JsonObject;
  readonly completeSession?: boolean;
}

export interface ExecutionHostSessionRunnerOptions {
  readonly resolvePlan: (
    context: SessionRunnerContext,
  ) => ExecutionHostSessionPlan | Promise<ExecutionHostSessionPlan>;
}

interface ExecutionRouteMetadata {
  readonly version: typeof EXECUTION_HOST_ROUTE_METADATA_VERSION;
  readonly executionId?: string;
  readonly checkpointId?: string;
  readonly sourceExecutionId?: string;
  readonly checkpointCreatedAt?: string;
  readonly checkpointSizeBytes?: number;
  readonly lastExitCode?: number;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function executionMetadata(routeMetadata: JsonObject): ExecutionRouteMetadata | null {
  const value = routeMetadata[EXECUTION_HOST_ROUTE_METADATA_KEY];
  if (!isJsonObject(value) || value.version !== EXECUTION_HOST_ROUTE_METADATA_VERSION) {
    return null;
  }
  if (
    (value.executionId !== undefined && typeof value.executionId !== 'string') ||
    (value.checkpointId !== undefined && typeof value.checkpointId !== 'string') ||
    (value.sourceExecutionId !== undefined && typeof value.sourceExecutionId !== 'string') ||
    (value.checkpointCreatedAt !== undefined && typeof value.checkpointCreatedAt !== 'string') ||
    (value.checkpointSizeBytes !== undefined &&
      (typeof value.checkpointSizeBytes !== 'number' ||
        !Number.isSafeInteger(value.checkpointSizeBytes) ||
        value.checkpointSizeBytes < 0)) ||
    (value.lastExitCode !== undefined &&
      (typeof value.lastExitCode !== 'number' || !Number.isSafeInteger(value.lastExitCode)))
  ) {
    return null;
  }
  return value as unknown as ExecutionRouteMetadata;
}

function withExecutionMetadata(
  routeMetadata: JsonObject,
  execution: ExecutionHandle,
  result: ExecutionExecResult,
  checkpoint?: ExecutionCheckpoint,
): JsonObject {
  const previous = executionMetadata(routeMetadata);
  const {
    checkpointId: _checkpointId,
    checkpointCreatedAt: _checkpointCreatedAt,
    checkpointSizeBytes: _checkpointSizeBytes,
    ...carried
  } = previous ?? {};
  return {
    ...routeMetadata,
    [EXECUTION_HOST_ROUTE_METADATA_KEY]: {
      ...carried,
      version: EXECUTION_HOST_ROUTE_METADATA_VERSION,
      executionId: execution.executionId,
      sourceExecutionId: execution.executionId,
      lastExitCode: result.exitCode,
      ...(checkpoint
        ? {
            checkpointId: checkpoint.checkpointId,
            checkpointCreatedAt: checkpoint.createdAt,
            checkpointSizeBytes: checkpoint.sizeBytes,
          }
        : {}),
    },
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Runs one Session workload in an isolated ExecutionHost.
 *
 * A checkpoint reference is stored in route metadata before a parked runner
 * waits. If that worker dies, lease recovery keeps the metadata so a successor
 * can restore the workspace under a higher fencing token.
 */
export class ExecutionHostSessionRunner implements SessionRunner {
  constructor(private readonly options: ExecutionHostSessionRunnerOptions) {}

  async run(context: SessionRunnerContext): Promise<SessionRunResult> {
    const host = context.executionHost;
    if (!host) {
      throw new TypeError('ExecutionHostSessionRunner requires an ExecutionHost');
    }
    const plan = await this.options.resolvePlan(context);
    context.signal.throwIfAborted();
    const persisted = executionMetadata(context.claim.route.metadata);
    const execution = persisted?.checkpointId
      ? await host.restore({
          checkpointId: ExecutionCheckpointId(persisted.checkpointId),
          signal: context.signal,
        })
      : await host.provision({
          ...plan.provision,
          signal: context.signal,
        });
    let terminated = false;
    const terminate = async (): Promise<void> => {
      if (terminated) {
        return;
      }
      terminated = true;
      await host.terminate(execution.executionId);
    };
    try {
      await context.transition('running', {
        ...context.claim.route.metadata,
        [EXECUTION_HOST_ROUTE_METADATA_KEY]: {
          ...persisted,
          version: EXECUTION_HOST_ROUTE_METADATA_VERSION,
          executionId: execution.executionId,
        },
      });
      const result = await host.exec(execution.executionId, {
        ...plan.command,
        signal: context.signal,
      });
      if (result.exitCode !== 0) {
        await terminate();
        return {
          status: 'failed',
          failure: {
            message: `Execution exited with code ${result.exitCode}`,
            exitCode: result.exitCode,
          },
          metadata: withExecutionMetadata(context.claim.route.metadata, execution, result),
        };
      }
      if (!plan.checkpoint || plan.checkpoint === 'none') {
        await terminate();
        return {
          status: plan.completeSession === false ? 'idle' : 'completed',
          metadata: withExecutionMetadata(context.claim.route.metadata, execution, result),
        };
      }

      const checkpoint = await host.checkpoint(execution.executionId, plan.checkpointMetadata);
      const metadata = withExecutionMetadata(
        context.claim.route.metadata,
        execution,
        result,
        checkpoint,
      );
      if (plan.checkpoint === 'park') {
        await context.transition('running', metadata);
        await waitForAbort(context.signal);
      }
      await terminate();
      return {
        status: 'suspended',
        metadata,
      };
    } catch (error) {
      await terminate().catch((cleanupError) => {
        throw new AggregateError(
          [error, cleanupError],
          `Execution ${execution.executionId} failed and cleanup was incomplete`,
        );
      });
      throw error;
    }
  }
}
