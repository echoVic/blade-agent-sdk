import type { AgentCommandType, AgentProtocolErrorCode } from '../protocol/index.js';
import type { CommandId, SessionId } from '../types/identifiers.js';

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
  readonly sessionId: SessionId;
  readonly eventType: string;
}

export interface AgentServerAuditRecord {
  readonly occurredAt: string;
  readonly tenantId: string;
  readonly subject: string;
  readonly commandId: CommandId;
  readonly commandType: AgentCommandType;
  readonly sessionId?: SessionId;
  readonly outcome: 'success' | 'error';
  readonly errorCode?: AgentProtocolErrorCode;
}

export interface AgentServerTelemetry {
  recordCommand?(metric: AgentServerCommandMetric): void | Promise<void>;
  recordEvent?(metric: AgentServerEventMetric): void | Promise<void>;
  writeAudit?(record: AgentServerAuditRecord): void | Promise<void>;
}

export const NOOP_AGENT_SERVER_TELEMETRY: AgentServerTelemetry = Object.freeze({});
