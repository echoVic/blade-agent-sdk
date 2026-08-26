import type { WorkerId } from '../types/identifiers.js';
import type { AgentWorkerSnapshot, AgentWorkerStatus } from './AgentWorker.js';

export interface AgentWorkerErrorMetric {
  readonly workerId: WorkerId;
  readonly workerStatus: AgentWorkerStatus;
  readonly errorCode?: string;
}

/**
 * Observational worker telemetry. Implementations must not throw into the
 * worker lifecycle or retain Session input, effect payload, or credentials.
 */
export interface AgentWorkerTelemetry {
  recordSnapshot(snapshot: AgentWorkerSnapshot): void;
  recordError(metric: AgentWorkerErrorMetric): void;
}
