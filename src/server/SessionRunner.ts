import type { ExecutionHost } from '../execution/ExecutionHost.js';
import type { DurableExecutionLease } from '../session/events/DurableExecutionLeaseStore.js';
import type { JsonObject } from '../types/json.js';
import type { RuntimeStore } from './RuntimeStore.js';
import type { RuntimeSessionClaim, RuntimeSessionRoute } from './WorkerRuntime.js';

export type ActiveRuntimeSessionState = 'provisioning' | 'running' | 'waiting_approval';

export interface SessionRunnerContext {
  readonly workerId: DurableExecutionLease['ownerId'];
  readonly store: RuntimeStore;
  readonly claim: RuntimeSessionClaim;
  readonly signal: AbortSignal;
  readonly executionHost?: ExecutionHost;
  /**
   * Moves the currently fenced route between non-terminal execution states.
   * Metadata replaces the previous route metadata, so callers should preserve
   * fields they still need.
   */
  transition(
    state: Extract<ActiveRuntimeSessionState, 'running' | 'waiting_approval'>,
    metadata?: JsonObject,
  ): Promise<RuntimeSessionRoute>;
}

export type SessionRunResult =
  | {
      readonly status: 'idle';
      readonly metadata?: JsonObject;
      readonly finalize?: () => Promise<void>;
    }
  | {
      readonly status: 'completed';
      readonly metadata?: JsonObject;
      readonly finalize?: () => Promise<void>;
    }
  | {
      readonly status: 'suspended';
      readonly metadata?: JsonObject;
      readonly finalize?: () => Promise<void>;
    }
  | {
      readonly status: 'failed';
      readonly failure: JsonObject;
      readonly metadata?: JsonObject;
      readonly finalize?: () => Promise<void>;
    };

/**
 * Executes one fenced Session claim.
 *
 * The runner owns Session-specific preparation and cleanup. AgentWorker owns
 * worker registration, lease renewal, route transitions, and crash recovery.
 */
export interface SessionRunner {
  /**
   * Set when the runner installs its own heartbeat for the claimed lease.
   * AgentWorker otherwise renews the lease while run() is pending.
   */
  readonly managesLease?: boolean;
  run(context: SessionRunnerContext): Promise<SessionRunResult>;
}
