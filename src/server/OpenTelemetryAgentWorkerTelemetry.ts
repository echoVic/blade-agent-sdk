import { metrics, type Attributes, type Meter } from '@opentelemetry/api';
import type { AgentWorkerSnapshot } from './AgentWorker.js';
import type { AgentWorkerErrorMetric, AgentWorkerTelemetry } from './AgentWorkerTelemetry.js';

export interface OpenTelemetryAgentWorkerOptions {
  readonly meter?: Meter;
  readonly meterName?: string;
  readonly includeWorkerIdAttribute?: boolean;
}

interface WorkerMetricSnapshot {
  readonly workerId?: string;
  readonly status: AgentWorkerSnapshot['status'];
  readonly ready: boolean;
  readonly activeSessions: number;
  readonly sessionClaims: number;
  readonly sessionsCompleted: number;
  readonly sessionsFailed: number;
  readonly recoveryDurationMs: number;
  readonly uncertainEffects: number;
}

/**
 * Payload-free OpenTelemetry adapter for AgentWorker lifecycle and throughput.
 */
export class OpenTelemetryAgentWorkerTelemetry implements AgentWorkerTelemetry {
  private readonly meter: Meter;
  private readonly includeWorkerIdAttribute: boolean;
  private readonly snapshots = new Map<string, WorkerMetricSnapshot>();
  private readonly errorCounter;

  constructor(options: OpenTelemetryAgentWorkerOptions = {}) {
    this.meter =
      options.meter ?? metrics.getMeter(options.meterName ?? '@blade-ai/agent-sdk/worker');
    this.includeWorkerIdAttribute = options.includeWorkerIdAttribute ?? false;
    this.errorCounter = this.meter.createCounter('blade.agent.worker.errors', {
      description: 'Agent worker background and execution errors',
    });

    this.observe(
      'blade.agent.worker.ready',
      'Whether the worker is ready to claim Sessions',
      (snapshot) => (snapshot.ready ? 1 : 0),
    );
    this.observe(
      'blade.agent.worker.active_sessions',
      'Sessions currently owned by the worker',
      (snapshot) => snapshot.activeSessions,
    );
    this.observe(
      'blade.agent.worker.session.claims',
      'Cumulative Session claims by the worker',
      (snapshot) => snapshot.sessionClaims,
    );
    this.observe(
      'blade.agent.worker.session.completed',
      'Cumulative idle or terminal successful Session runs',
      (snapshot) => snapshot.sessionsCompleted,
    );
    this.observe(
      'blade.agent.worker.session.failed',
      'Cumulative failed Session runs',
      (snapshot) => snapshot.sessionsFailed,
    );
    this.observe(
      'blade.agent.worker.recovery.duration',
      'Cumulative worker recovery scan duration',
      (snapshot) => snapshot.recoveryDurationMs,
      'ms',
    );
    this.observe(
      'blade.agent.worker.effect.uncertain',
      'Cumulative effects with an uncertain outcome',
      (snapshot) => snapshot.uncertainEffects,
    );
  }

  recordSnapshot(snapshot: AgentWorkerSnapshot): void {
    this.snapshots.set(String(snapshot.workerId), {
      ...(this.includeWorkerIdAttribute ? { workerId: snapshot.workerId } : {}),
      status: snapshot.status,
      ready: snapshot.health?.ready ?? false,
      activeSessions: snapshot.metrics.activeSessions,
      sessionClaims: snapshot.metrics.sessionClaims,
      sessionsCompleted: snapshot.metrics.sessionsIdle + snapshot.metrics.sessionsCompleted,
      sessionsFailed: snapshot.metrics.sessionsFailed,
      recoveryDurationMs: snapshot.metrics.recoveryDurationMs,
      uncertainEffects: snapshot.effectMetrics?.uncertain ?? 0,
    });
  }

  recordError(metric: AgentWorkerErrorMetric): void {
    this.errorCounter.add(1, {
      'blade.agent.worker.status': metric.workerStatus,
      ...(metric.errorCode ? { 'error.type': metric.errorCode } : {}),
      ...(this.includeWorkerIdAttribute ? { 'blade.agent.worker.id': metric.workerId } : {}),
    });
  }

  private observe(
    name: string,
    description: string,
    value: (snapshot: WorkerMetricSnapshot) => number,
    unit?: string,
  ): void {
    const gauge = this.meter.createObservableGauge(name, {
      description,
      ...(unit ? { unit } : {}),
    });
    gauge.addCallback((result) => {
      for (const snapshot of this.snapshots.values()) {
        result.observe(value(snapshot), this.attributes(snapshot));
      }
    });
  }

  private attributes(snapshot: WorkerMetricSnapshot): Attributes {
    return {
      'blade.agent.worker.status': snapshot.status,
      ...(snapshot.workerId ? { 'blade.agent.worker.id': snapshot.workerId } : {}),
    };
  }
}
