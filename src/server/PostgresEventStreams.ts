import { nanoid } from 'nanoid';
import type { PoolClient, QueryResultRow } from 'pg';
import { EventId, EventSequence, type SessionId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import { type PostgresContext, postgresInteger, postgresJsonObject } from './PostgresContext.js';
import { RuntimeStoreError } from './RuntimeStore.js';

interface HeadRow extends QueryResultRow {
  first_sequence: string | number;
  next_sequence: string | number;
}

interface PayloadRow extends QueryResultRow {
  payload: unknown;
}

export interface StreamPage {
  readonly payloads: JsonObject[];
  readonly headSequence: number | null;
  readonly hasMore: boolean;
}

export class PostgresEventStreams {
  constructor(
    private readonly db: PostgresContext,
    private readonly initialize: () => Promise<void>,
  ) {}

  async range(
    tenantId: string,
    sessionId: SessionId,
    stream: string,
  ): Promise<{ firstSequence: number; headSequence: number } | null> {
    await this.initialize();
    const result = await this.db.client().query<HeadRow>(
      `SELECT first_sequence, next_sequence FROM ${this.db.table('stream_heads')}
        WHERE tenant_id = $1 AND session_id = $2 AND stream_name = $3`,
      [tenantId, sessionId, stream],
    );
    const row = result.rows[0];
    if (!row) return null;
    const firstSequence = postgresInteger(row.first_sequence);
    const nextSequence = postgresInteger(row.next_sequence);
    return nextSequence > firstSequence ? { firstSequence, headSequence: nextSequence - 1 } : null;
  }

  async head(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    stream: string,
  ): Promise<number | null> {
    await this.db.lock(client, `stream:${tenantId}:${sessionId}:${stream}`);
    const result = await client.query<HeadRow>(
      `SELECT first_sequence, next_sequence FROM ${this.db.table('stream_heads')}
        WHERE tenant_id = $1 AND session_id = $2 AND stream_name = $3 FOR UPDATE`,
      [tenantId, sessionId, stream],
    );
    return result.rows[0] ? postgresInteger(result.rows[0].next_sequence) - 1 : null;
  }

  async append<
    T extends {
      readonly eventId: EventId;
      readonly sequence: EventSequence;
      readonly type: string;
      readonly occurredAt: string;
    },
  >(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    stream: string,
    knownHead: number | null | undefined,
    factories: readonly ((fields: {
      sequence: EventSequence;
      eventId: EventId;
      recordedAt: string;
    }) => T)[],
    retention?: number,
    quota?: number,
  ): Promise<T[]> {
    const current = knownHead ?? (await this.head(client, tenantId, sessionId, stream));
    const first = (current ?? 0) + 1;
    if (quota !== undefined && first - 1 + factories.length > quota) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_QUOTA_EXCEEDED',
        `Event quota exceeded for ${stream} stream ${tenantId}/${sessionId}`,
      );
    }
    const recordedAt = new Date().toISOString();
    const payloads = factories.map((factory, index) =>
      factory({
        sequence: EventSequence(first + index),
        eventId: EventId(nanoid()),
        recordedAt,
      }),
    );
    if (!payloads.length) return [];
    const rows = payloads.map((payload) => ({
      tenant_id: tenantId,
      session_id: sessionId,
      stream_name: stream,
      sequence: Number(payload.sequence),
      event_id: String(payload.eventId),
      event_type: payload.type,
      payload,
      occurred_at: payload.occurredAt,
      recorded_at: recordedAt,
    }));
    await client.query(
      `INSERT INTO ${this.db.table('events')} (
         tenant_id, session_id, stream_name, sequence, event_id,
         event_type, payload, occurred_at, recorded_at
       ) SELECT * FROM jsonb_to_recordset($1::jsonb) AS entry(
         tenant_id TEXT, session_id TEXT, stream_name TEXT, sequence BIGINT,
         event_id TEXT, event_type TEXT, payload JSONB,
         occurred_at TIMESTAMPTZ, recorded_at TIMESTAMPTZ
       )`,
      [JSON.stringify(rows)],
    );
    const next = first + payloads.length;
    const retainedFirst = retention ? Math.max(1, next - retention) : 1;
    await client.query(
      `INSERT INTO ${this.db.table('stream_heads')} (
         tenant_id, session_id, stream_name, first_sequence, next_sequence
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, session_id, stream_name) DO UPDATE
       SET first_sequence = EXCLUDED.first_sequence, next_sequence = EXCLUDED.next_sequence`,
      [tenantId, sessionId, stream, retainedFirst, next],
    );
    if (retention) {
      await client.query(
        `DELETE FROM ${this.db.table('events')}
          WHERE tenant_id = $1 AND session_id = $2 AND stream_name = $3 AND sequence < $4`,
        [tenantId, sessionId, stream, retainedFirst],
      );
    }
    return payloads;
  }

  async read(
    tenantId: string,
    sessionId: SessionId,
    stream: string,
    after = 0,
    limit = 100,
  ): Promise<StreamPage> {
    await this.initialize();
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError('Event cursor is invalid');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('Event page limit must be between 1 and 1000');
    }
    return this.db.transaction(async (client) => {
      await this.db.lock(client, `stream:${tenantId}:${sessionId}:${stream}`);
      const range = await this.range(tenantId, sessionId, stream);
      if (!range) {
        if (after > 0) throw new RangeError('Event cursor is ahead of the session head');
        return { payloads: [], headSequence: null, hasMore: false };
      }
      if (after < range.firstSequence - 1) throw new RangeError('Event cursor is stale');
      if (after > range.headSequence)
        throw new RangeError('Event cursor is ahead of the session head');
      const result = await client.query<PayloadRow>(
        `SELECT payload FROM ${this.db.table('events')}
          WHERE tenant_id = $1 AND session_id = $2 AND stream_name = $3 AND sequence > $4
          ORDER BY sequence LIMIT $5`,
        [tenantId, sessionId, stream, after, limit + 1],
      );
      return {
        payloads: result.rows.slice(0, limit).map((row) => postgresJsonObject(row.payload)),
        headSequence: range.headSequence,
        hasMore: result.rows.length > limit,
      };
    });
  }
}
