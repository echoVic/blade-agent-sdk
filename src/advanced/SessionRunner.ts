import type { ExecutionHost } from '../execution/ExecutionHost.js';
import type { RuntimeStore } from '../server/RuntimeStore.js';
import type { RuntimeSessionClaim, RuntimeSessionRoute } from '../server/WorkerRuntime.js';
import type { DurableExecutionLease } from '../session/events/DurableExecutionLeaseStore.js';
import type { JsonObject } from '../types/json.js';

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

/**
 * The requested route outcome.
 *
 * Contract every runner shares:
 *
 * - `finalize` runs only after the fenced settlement or handoff succeeds, and is
 *   skipped when that transition fails. Do not put required cleanup in it; finish
 *   cleanup before `run()` resolves.
 * - Publish the terminal result from `finalize`, not while streaming. A client
 *   that observes a finished request while the route still reads `running` gets
 *   refused when it immediately sends the next input, so the route must settle
 *   first.
 * - `idle` means the route is ready for another input. Return it only when the
 *   Session is safe to continue without reconciliation.
 * - `failed` means the route is terminal and the Session needs reconciliation
 *   before further input. A runner that cannot prove its recovery boundaries were
 *   respected must report `failed` rather than assume `idle` is safe.
 */
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
