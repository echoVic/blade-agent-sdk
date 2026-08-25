import {
  metrics,
  SpanStatusCode,
  trace,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';
import type {
  AgentServerAuditRecord,
  AgentServerCommandMetric,
  AgentServerEventMetric,
  AgentServerTelemetry,
} from './AgentServerTelemetry.js';

export interface OpenTelemetryAgentServerOptions {
  readonly tracerName?: string;
  readonly meterName?: string;
  readonly includeTenantAttributes?: boolean;
  readonly auditSink?: (
    record: AgentServerAuditRecord,
  ) => void | Promise<void>;
}

/**
 * Payload-free OpenTelemetry adapter. Prompt content, tool arguments, provider
 * credentials, subject IDs, and tenant IDs are never emitted by default.
 */
export class OpenTelemetryAgentServerTelemetry implements AgentServerTelemetry {
  private readonly tracer: Tracer;
  private readonly meter: Meter;
  private readonly includeTenantAttributes: boolean;
  private readonly commandCounter;
  private readonly commandDuration;
  private readonly eventCounter;

  constructor(private readonly options: OpenTelemetryAgentServerOptions = {}) {
    this.tracer = trace.getTracer(options.tracerName ?? '@blade-ai/agent-sdk/server');
    this.meter = metrics.getMeter(options.meterName ?? '@blade-ai/agent-sdk/server');
    this.includeTenantAttributes = options.includeTenantAttributes ?? false;
    this.commandCounter = this.meter.createCounter('blade.agent.server.commands', {
      description: 'Agent server commands by type and outcome',
    });
    this.commandDuration = this.meter.createHistogram(
      'blade.agent.server.command.duration',
      {
        description: 'Agent server command duration',
        unit: 'ms',
      },
    );
    this.eventCounter = this.meter.createCounter('blade.agent.server.events', {
      description: 'Agent server events by type',
    });
  }

  recordCommand(metric: AgentServerCommandMetric): void {
    const attributes = {
      'blade.agent.command.type': metric.commandType,
      'blade.agent.command.outcome': metric.outcome,
      ...(metric.errorCode
        ? { 'error.type': metric.errorCode }
        : {}),
      ...(this.includeTenantAttributes
        ? { 'blade.agent.tenant.id': metric.tenantId }
        : {}),
    };
    this.commandCounter.add(1, attributes);
    this.commandDuration.record(metric.durationMs, attributes);
    const span = this.tracer.startSpan('blade.agent.server.command', {
      startTime: Date.now() - metric.durationMs,
      attributes,
    });
    span.setStatus(
      metric.outcome === 'success'
        ? { code: SpanStatusCode.OK }
        : {
            code: SpanStatusCode.ERROR,
            message: metric.errorCode,
          },
    );
    span.end();
  }

  recordEvent(metric: AgentServerEventMetric): void {
    this.eventCounter.add(1, {
      'blade.agent.event.type': metric.eventType,
      ...(this.includeTenantAttributes
        ? { 'blade.agent.tenant.id': metric.tenantId }
        : {}),
    });
  }

  writeAudit(record: AgentServerAuditRecord): void | Promise<void> {
    return this.options.auditSink?.(record);
  }
}
