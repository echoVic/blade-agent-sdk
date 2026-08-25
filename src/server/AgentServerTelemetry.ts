import type { AgentCommandType, AgentProtocolErrorCode } from '../protocol/index.js';

export interface AgentServerCommandMetric {
  readonly commandType: AgentCommandType;
  readonly tenantId: string;
  readonly subject: string;
  readonly durationMs: number;
  readonly outcome: 'success' | 'error';
  readonly errorCode?: AgentProtocolErrorCode;
}

export interface AgentServerEventMetric {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly eventType: string;
}

export interface AgentServerAuditRecord {
  readonly occurredAt: string;
  readonly tenantId: string;
  readonly subject: string;
  readonly commandId: string;
  readonly commandType: AgentCommandType;
  readonly sessionId?: string;
  readonly outcome: 'success' | 'error';
  readonly errorCode?: AgentProtocolErrorCode;
}

export interface AgentServerTelemetry {
  recordCommand?(metric: AgentServerCommandMetric): void | Promise<void>;
  recordEvent?(metric: AgentServerEventMetric): void | Promise<void>;
  writeAudit?(record: AgentServerAuditRecord): void | Promise<void>;
}

export const NOOP_AGENT_SERVER_TELEMETRY: AgentServerTelemetry = Object.freeze({});
