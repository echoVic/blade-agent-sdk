import type { QueryResultRow } from 'pg';
import { SessionId } from '../types/identifiers.js';
import type { AgentServerSessionRecord } from './AgentServerStore.js';
import { postgresJsonObject, postgresTimestamp } from './PostgresContext.js';

export interface PostgresSessionRow extends QueryResultRow {
  tenant_id: string;
  session_id: string;
  created_by: string;
  status: 'active' | 'closed';
  created_at: Date | string;
  updated_at: Date | string;
  metadata: unknown;
}

export function postgresSessionRecord(row: PostgresSessionRow): AgentServerSessionRecord {
  const metadata = postgresJsonObject(row.metadata);
  return {
    tenantId: row.tenant_id,
    createdBy: row.created_by,
    sessionId: SessionId(row.session_id),
    status: row.status,
    createdAt: postgresTimestamp(row.created_at),
    updatedAt: postgresTimestamp(row.updated_at),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}
