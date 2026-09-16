import { nanoid } from 'nanoid';
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import {
  AGENT_PROTOCOL_VERSION,
  type AgentCommandResult,
  type AgentEventPage,
  type AgentServerEvent,
  parseAgentCommandResult,
  parseAgentServerEvent,
} from '../protocol/index.js';
import {
  DurableEventSequenceConflictError,
  DurableEventStoreError,
} from '../session/events/DurableEventStore.js';
import { parseDurableEventDraft, parseDurableEventEnvelope } from '../session/events/schemas.js';
import {
  DURABLE_EVENT_SCHEMA_VERSION,
  type DurableEventAppendOptions,
  type DurableEventAppendResult,
  type DurableEventDraft,
  type DurableEventEnvelope,
  type DurableEventPage,
  type DurableEventReadOptions,
  DurableEventType,
} from '../session/events/types.js';
import type { SessionRepositoryStorageStats } from '../session/SessionRepository.js';
import type { SessionState, SessionStateMutation } from '../session/SessionStore.js';
import {
  type CommandId,
  type EventId,
  EventSequence,
  ExecutionLeaseId,
  SessionId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { AgentCommandClaim, AgentServerSessionRecord } from './AgentServerStore.js';
import { PostgresContext, postgresAdvisoryLockKey, postgresJsonObject } from './PostgresContext.js';
import { PostgresEventStreams } from './PostgresEventStreams.js';
import { type PostgresSessionRow, postgresSessionRecord } from './PostgresRows.js';
import { PostgresTenantRuntimeStore } from './PostgresTenantRuntimeStore.js';
import { PostgresWorkerRuntime } from './PostgresWorkerRuntime.js';
import {
  RUNTIME_STORE_SCHEMA_VERSION,
  type RuntimeStore,
  RuntimeStoreError,
  type RuntimeTenantStore,
} from './RuntimeStore.js';

const DEFAULT_MAX_EVENTS_PER_SESSION = 10_000;
const DEFAULT_MAX_DURABLE_EVENTS_PER_SESSION = 100_000;
const DEFAULT_MAX_SESSIONS_PER_TENANT = 10_000;

export interface PostgresRuntimeStoreOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  readonly schema?: string;
  readonly tablePrefix?: string;
  readonly maxAgentEventsPerSession?: number;
  readonly maxDurableEventsPerSession?: number;
  readonly maxSessionsPerTenant?: number;
}

interface PayloadRow extends QueryResultRow {
  payload: unknown;
}

interface CommandRow extends QueryResultRow {
  command_fingerprint: string;
  lease_id: string;
  status: 'claimed' | 'sealed' | 'completed' | 'abandoned';
  expires_at: Date | string;
  result: unknown | null;
  abandon_reason?: string | null;
}

interface StateRow extends QueryResultRow {
  state: unknown;
}

function asSessionState(value: unknown): SessionState {
  return structuredClone(value) as SessionState;
}

export class PostgresRuntimeStore extends PostgresWorkerRuntime implements RuntimeStore {
  private readonly ownsPool: boolean;
  private readonly maxAgentEventsPerSession: number;
  private readonly maxDurableEventsPerSession: number;
  private readonly maxSessionsPerTenant: number;
  private readonly streams: PostgresEventStreams;
  private initialization?: Promise<void>;

  constructor(options: PostgresRuntimeStoreOptions = {}) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new TypeError('PostgresRuntimeStore requires pool, connectionString, or poolConfig');
    }
    const pool =
      options.pool ??
      new Pool({
        ...options.poolConfig,
        connectionString: options.connectionString ?? options.poolConfig?.connectionString,
      });
    const db = new PostgresContext(
      pool,
      options.schema ?? 'public',
      options.tablePrefix ?? 'blade_runtime',
    );
    super(db);
    this.streams = new PostgresEventStreams(db, () => this.initialize());
    this.ownsPool = !options.pool;
    this.maxAgentEventsPerSession =
      options.maxAgentEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION;
    this.maxDurableEventsPerSession =
      options.maxDurableEventsPerSession ?? DEFAULT_MAX_DURABLE_EVENTS_PER_SESSION;
    this.maxSessionsPerTenant = options.maxSessionsPerTenant ?? DEFAULT_MAX_SESSIONS_PER_TENANT;
    for (const [name, value] of [
      ['maxAgentEventsPerSession', this.maxAgentEventsPerSession],
      ['maxDurableEventsPerSession', this.maxDurableEventsPerSession],
      ['maxSessionsPerTenant', this.maxSessionsPerTenant],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      const initializing = this.createSchema();
      this.initialization = initializing;
      void initializing.catch(() => {
        if (this.initialization === initializing) {
          this.initialization = undefined;
        }
      });
    }
    return this.initialization;
  }

  forTenant(tenantId: string): RuntimeTenantStore {
    if (!tenantId.trim()) {
      throw new TypeError('tenantId must not be empty');
    }
    return new PostgresTenantRuntimeStore(this, tenantId);
  }

  async healthCheck(): Promise<{
    readonly ready: boolean;
    readonly details?: JsonObject;
  }> {
    try {
      await this.initialize();
      await this.db.client().query('SELECT 1');
      return {
        ready: true,
        details: {
          backend: 'postgresql',
          schemaVersion: RUNTIME_STORE_SCHEMA_VERSION,
        },
      };
    } catch (error) {
      return {
        ready: false,
        details: {
          backend: 'postgresql',
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async claimCommand(
    tenantId: string,
    commandId: CommandId,
    commandFingerprint: string,
    ttlMs: number,
  ): Promise<AgentCommandClaim> {
    if (
      !tenantId.trim() ||
      !commandId.trim() ||
      !commandFingerprint.trim() ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1
    ) {
      throw new RangeError('Command claim parameters are invalid');
    }
    await this.initialize();
    return this.db.transaction(async (client) => {
      await this.db.lock(client, `command:${tenantId}:${commandId}`);
      const existing = await client.query<CommandRow>(
        `SELECT command_fingerprint, lease_id, status, expires_at, result, abandon_reason
           FROM ${this.db.table('commands')}
          WHERE tenant_id = $1 AND command_id = $2
          FOR UPDATE`,
        [tenantId, commandId],
      );
      const row = existing.rows[0];
      if (row && row.command_fingerprint !== commandFingerprint) {
        return { status: 'conflict' };
      }
      if (row?.result !== null && row?.result !== undefined) {
        return {
          status: 'completed',
          result: parseAgentCommandResult(row.result),
        };
      }
      if (row?.status === 'abandoned') {
        return {
          status: 'abandoned',
          reason:
            typeof row.abandon_reason === 'string'
              ? row.abandon_reason
              : 'This command was abandoned after sealing',
        };
      }
      const now = Date.now();
      if (row && (row.status === 'sealed' || new Date(row.expires_at).getTime() > now)) {
        return {
          status: 'in_progress',
          retryAfterMs:
            row.status === 'sealed' ? 1000 : Math.max(1, new Date(row.expires_at).getTime() - now),
        };
      }
      const leaseId = ExecutionLeaseId(nanoid());
      const expiresAt = new Date(now + ttlMs);
      await client.query(
        `INSERT INTO ${this.db.table('commands')} (
           tenant_id, command_id, command_fingerprint, lease_id,
           status, expires_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'claimed', $5, NOW(), NOW())
         ON CONFLICT (tenant_id, command_id) DO UPDATE SET
           command_fingerprint = EXCLUDED.command_fingerprint,
           lease_id = EXCLUDED.lease_id,
           status = 'claimed',
           expires_at = EXCLUDED.expires_at,
           result = NULL,
           updated_at = NOW()`,
        [tenantId, commandId, commandFingerprint, leaseId, expiresAt],
      );
      return { status: 'claimed', leaseId };
    });
  }

  async sealCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
  ): Promise<void> {
    await this.initialize();
    const result = await this.db.client().query<PostgresSessionRow>(
      `UPDATE ${this.db.table('commands')}
          SET status = 'sealed', expires_at = 'infinity', updated_at = NOW()
        WHERE tenant_id = $1 AND command_id = $2 AND lease_id = $3
          AND status = 'claimed' AND result IS NULL`,
      [tenantId, commandId, leaseId],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Command lease ${commandId}/${leaseId} is no longer active`);
    }
  }

  async completeCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
    result: AgentCommandResult,
  ): Promise<void> {
    await this.initialize();
    const updated = await this.db.client().query(
      `UPDATE ${this.db.table('commands')}
          SET status = 'completed', expires_at = 'infinity',
              result = $4::jsonb, updated_at = NOW()
        WHERE tenant_id = $1 AND command_id = $2 AND lease_id = $3
          AND status IN ('claimed', 'sealed')`,
      [tenantId, commandId, leaseId, JSON.stringify(result)],
    );
    if (updated.rowCount !== 1) {
      throw new Error(`Command lease ${commandId}/${leaseId} is no longer active`);
    }
  }

  async releaseCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
  ): Promise<void> {
    await this.initialize();
    await this.db.client().query(
      `DELETE FROM ${this.db.table('commands')}
        WHERE tenant_id = $1 AND command_id = $2 AND lease_id = $3
          AND status = 'claimed'`,
      [tenantId, commandId, leaseId],
    );
  }

  /**
   * Resolve a sealed command terminally. Only a sealed command can be abandoned:
   * a claimed one can still be released for retry, and a completed one already has
   * its result.
   */
  async abandonCommand(tenantId: string, commandId: CommandId, reason: string): Promise<boolean> {
    if (!reason.trim()) {
      throw new RangeError('An abandoned command requires a reason');
    }
    await this.initialize();
    const result = await this.db.client().query(
      `UPDATE ${this.db.table('commands')}
          SET status = 'abandoned', abandon_reason = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND command_id = $2
          AND status = 'sealed' AND result IS NULL`,
      [tenantId, commandId, reason],
    );
    return result.rowCount === 1;
  }

  async putSession(record: AgentServerSessionRecord): Promise<void> {
    await this.initialize();
    await this.db.client().query(
      `INSERT INTO ${this.db.table('sessions')} (
         tenant_id, session_id, created_by, status,
         created_at, updated_at, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (tenant_id, session_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         metadata = EXCLUDED.metadata`,
      [
        record.tenantId,
        record.sessionId,
        record.createdBy,
        record.status,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record.metadata ?? {}),
      ],
    );
  }

  async getSession(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<AgentServerSessionRecord | null> {
    await this.initialize();
    const result = await this.db.client().query(
      `SELECT tenant_id, session_id, created_by, status,
              created_at, updated_at, metadata
         FROM ${this.db.table('sessions')}
        WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    );
    return result.rows[0] ? postgresSessionRecord(result.rows[0]) : null;
  }

  async listSessions(
    tenantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ sessions: AgentServerSessionRecord[]; nextCursor?: string }> {
    await this.initialize();
    const limit = options.limit ?? 50;
    const offset = options.cursor ? Number(options.cursor) : 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new RangeError('Session list pagination is invalid');
    }
    const result = await this.db.client().query<PostgresSessionRow>(
      `SELECT tenant_id, session_id, created_by, status,
              created_at, updated_at, metadata
         FROM ${this.db.table('sessions')}
        WHERE tenant_id = $1
        ORDER BY updated_at DESC, session_id ASC
        OFFSET $2 LIMIT $3`,
      [tenantId, offset, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    return {
      sessions: result.rows.slice(0, limit).map(postgresSessionRecord),
      ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  async appendEvent(
    tenantId: string,
    sessionId: SessionId,
    event: Omit<AgentServerEvent, 'eventId' | 'sequence'>,
    options: { readonly idempotencyKey?: string } = {},
  ): Promise<AgentServerEvent> {
    if (event.sessionId !== sessionId) {
      throw new RangeError('Event Session does not match the target event log');
    }
    await this.initialize();
    const idempotencyKey = options.idempotencyKey;
    return this.db.transaction(async (client) => {
      if (idempotencyKey !== undefined) {
        // Serialised against other appends to this stream, so the check cannot
        // race a concurrent publisher of the same key.
        await this.db.lock(client, `stream:${tenantId}:${sessionId}:agent`);
        const existing = await this.readIdempotencyRecord(
          client,
          tenantId,
          sessionId,
          idempotencyKey,
        );
        if (existing) {
          return parseAgentServerEvent(existing);
        }
      }
      const [stored] = await this.streams.append(
        client,
        tenantId,
        sessionId,
        'agent',
        undefined,
        [
          ({ sequence, eventId, recordedAt }) => ({
            ...event,
            protocolVersion: AGENT_PROTOCOL_VERSION,
            eventId,
            sequence,
            occurredAt: event.occurredAt ?? recordedAt,
          }),
        ],
        this.maxAgentEventsPerSession,
      );
      if (idempotencyKey !== undefined) {
        await this.writeIdempotencyRecord(client, tenantId, sessionId, idempotencyKey, stored);
      }
      return parseAgentServerEvent(stored);
    });
  }

  private async readIdempotencyRecord(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    idempotencyKey: string,
  ): Promise<JsonObject | null> {
    const result = await client.query<PayloadRow>(
      `SELECT payload
         FROM ${this.db.table('event_keys')}
        WHERE tenant_id = $1 AND session_id = $2 AND idempotency_key = $3`,
      [tenantId, sessionId, idempotencyKey],
    );
    const row = result.rows[0];
    if (row) {
      return postgresJsonObject(row.payload);
    }
    return null;
  }

  private async writeIdempotencyRecord(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    idempotencyKey: string,
    event: { readonly eventId: EventId; readonly sequence: EventSequence },
    payload: unknown = event,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${this.db.table('event_keys')} (
         tenant_id, session_id, idempotency_key, sequence, event_id, payload
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (tenant_id, session_id, idempotency_key) DO NOTHING`,
      [
        tenantId,
        sessionId,
        idempotencyKey,
        Number(event.sequence),
        String(event.eventId),
        JSON.stringify(payload),
      ],
    );
  }

  async getEventStreamRange(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<{ firstSequence: number; headSequence: number } | null> {
    await this.initialize();
    return this.streams.range(tenantId, sessionId, 'agent');
  }

  async getEventByIdempotencyKey(
    tenantId: string,
    sessionId: SessionId,
    idempotencyKey: string,
  ): Promise<AgentServerEvent | null> {
    await this.initialize();
    return this.db.transaction(async (client) => {
      const payload = await this.readIdempotencyRecord(client, tenantId, sessionId, idempotencyKey);
      return payload ? parseAgentServerEvent(payload) : null;
    });
  }

  async readEvents(
    tenantId: string,
    sessionId: SessionId,
    options: { after?: number; limit?: number } = {},
  ): Promise<AgentEventPage> {
    const page = await this.streams.read(
      tenantId,
      sessionId,
      'agent',
      options.after,
      options.limit,
    );
    const events = page.payloads.map((payload) => parseAgentServerEvent(payload));
    const last = events.at(-1);
    return {
      events,
      nextCursor: last
        ? {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            sessionId,
            sequence: last.sequence,
            eventId: last.eventId,
          }
        : null,
      hasMore: page.hasMore,
    };
  }

  async getLatestEventSequence(tenantId: string, sessionId: SessionId): Promise<number | null> {
    return (await this.streams.range(tenantId, sessionId, 'agent'))?.headSequence ?? null;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.db.pool.end();
    }
  }

  async appendDurableEvents(
    tenantId: string,
    sessionId: SessionId,
    drafts: readonly DurableEventDraft[],
    options: DurableEventAppendOptions = {},
  ): Promise<DurableEventAppendResult> {
    await this.initialize();
    if (drafts.length === 0) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_INVALID_APPEND',
        'A durable event append requires at least one event',
      );
    }
    const parsed = drafts.map((draft, index) => {
      try {
        return parseDurableEventDraft(draft);
      } catch (error) {
        throw new DurableEventStoreError(
          'DURABLE_EVENT_INVALID_APPEND',
          `Invalid durable event draft at index ${index}`,
          { cause: error },
        );
      }
    });
    options.signal?.throwIfAborted();
    const appended = await this.db.transaction(async (client) => {
      await this.assertExecutionFenceWithClient(
        client,
        tenantId,
        sessionId,
        options.executionFence,
      );
      const previousSequence = await this.streams.head(client, tenantId, sessionId, 'durable');
      if (
        options.expectedLastSequence !== undefined &&
        options.expectedLastSequence !== previousSequence
      ) {
        throw new DurableEventSequenceConflictError(
          options.expectedLastSequence,
          previousSequence === null ? null : EventSequence(previousSequence),
        );
      }
      const events = await this.streams.append(
        client,
        tenantId,
        sessionId,
        'durable',
        previousSequence,
        parsed.map((draft) => ({ sequence, eventId, recordedAt }) => ({
          ...draft,
          schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
          eventId,
          sequence: EventSequence(sequence),
          sessionId,
          recordedAt,
          occurredAt: draft.occurredAt ?? recordedAt,
        })),
        undefined,
        this.maxDurableEventsPerSession,
      );
      const durableEvents = events.map((value) => parseDurableEventEnvelope(value));
      const last = durableEvents.at(-1);
      if (!last) {
        throw new DurableEventStoreError(
          'DURABLE_EVENT_INVALID_APPEND',
          'A durable event append produced no events',
        );
      }
      return {
        events: durableEvents,
        previousSequence: previousSequence === null ? null : EventSequence(previousSequence),
        lastSequence: last.sequence,
      };
    });
    await this.advanceHistoryCoverage(tenantId, sessionId, appended.events);
    return appended;
  }

  /**
   * Advance the projection's coverage boundary to a request that is fully
   * materialised.
   *
   * The transcript and the durable journal are separate stores that share no
   * sequence, so the Request is the only identity both of them carry. A request's
   * messages are written before its terminal event is appended, so once
   * `request_completed` is durable the projection may claim that request. The
   * merge rule refuses to advance while a gap is open, so a failed message write
   * keeps the older boundary and the recovery cursor stays behind the hole.
   */
  private async advanceHistoryCoverage(
    tenantId: string,
    sessionId: SessionId,
    events: readonly DurableEventEnvelope[],
  ): Promise<void> {
    const completed = events.find((event) => event.type === DurableEventType.REQUEST_COMPLETED);
    if (!completed) {
      return;
    }
    const requestId = 'requestId' in completed ? completed.requestId : undefined;
    if (!requestId) {
      return;
    }
    try {
      await this.forTenant(tenantId).saveHistoryProgress?.(sessionId, {
        state: 'complete',
        requestId,
        coveredRequestId: requestId,
        updatedAt: Date.now(),
      });
    } catch {
      // Coverage turns the conservative replay-everything fallback into an exact
      // boundary. Losing it costs a wider replay, so it must never invalidate a
      // durable append that already committed.
    }
  }

  async readDurableEvents(
    tenantId: string,
    sessionId: SessionId,
    options: DurableEventReadOptions = {},
  ): Promise<DurableEventPage> {
    options.signal?.throwIfAborted();
    const page = await this.streams.read(
      tenantId,
      sessionId,
      'durable',
      options.after === undefined ? undefined : Number(options.after),
      options.limit,
    );
    const events = page.payloads.map((value) => parseDurableEventEnvelope(value));
    const last = events.at(-1);
    return {
      events,
      headSequence: page.headSequence === null ? null : EventSequence(page.headSequence),
      nextCursor: last?.sequence ?? null,
      hasMore: page.hasMore,
    };
  }

  async getDurableHead(tenantId: string, sessionId: SessionId): Promise<EventSequence | null> {
    const head = (await this.streams.range(tenantId, sessionId, 'durable'))?.headSequence;
    return head === undefined ? null : EventSequence(head);
  }

  async loadSessionState(tenantId: string, sessionId: SessionId): Promise<SessionState | null> {
    await this.initialize();
    const result = await this.db.client().query<StateRow>(
      `SELECT state FROM ${this.db.table('session_states')}
        WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    );
    return result.rows[0] ? asSessionState(result.rows[0].state) : null;
  }

  async mutateSessionState<T>(
    tenantId: string,
    sessionId: SessionId,
    create: () => SessionState,
    mutate: SessionStateMutation<T>,
  ): Promise<T> {
    await this.initialize();
    return this.db.transaction(async (client) => {
      await this.db.lock(client, `session-state:${tenantId}:${sessionId}`);
      const stored = await client.query<StateRow>(
        `SELECT state FROM ${this.db.table('session_states')}
          WHERE tenant_id = $1 AND session_id = $2 FOR UPDATE`,
        [tenantId, sessionId],
      );
      const now = Date.now();
      const state = stored.rows[0] ? asSessionState(stored.rows[0].state) : create();
      const historyProgress = state.historyProgress;
      const result = mutate(state, now);
      if (state.historyProgress === historyProgress) {
        state.historyProgress = {
          ...historyProgress,
          state: historyProgress?.state === 'failed' ? 'failed' : 'in_progress',
          updatedAt: now,
        };
      }
      await client.query(
        `INSERT INTO ${this.db.table('session_states')} (tenant_id, session_id, state, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET state = EXCLUDED.state, updated_at = NOW()`,
        [tenantId, sessionId, JSON.stringify(state)],
      );
      return result;
    });
  }

  async deleteSessionProjection(tenantId: string, sessionId: SessionId): Promise<void> {
    await this.initialize();
    await this.db
      .client()
      .query(
        `DELETE FROM ${this.db.table('session_states')} WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId],
      );
  }

  async listSessionProjectionIds(tenantId: string): Promise<SessionId[]> {
    await this.initialize();
    const result = await this.db.client().query(
      `SELECT session_id FROM ${this.db.table('session_states')}
        WHERE tenant_id = $1 ORDER BY session_id ASC`,
      [tenantId],
    );
    return result.rows.map((row) => SessionId(String(row.session_id)));
  }

  async cleanupSessionProjections(tenantId: string): Promise<void> {
    await this.initialize();
    await this.db.client().query(
      `DELETE FROM ${this.db.table('session_states')}
        WHERE tenant_id = $1 AND session_id IN (
          SELECT session_id FROM ${this.db.table('session_states')}
          WHERE tenant_id = $1
          ORDER BY (state->>'lastActivity')::bigint DESC, session_id ASC OFFSET $2
        )`,
      [tenantId, this.maxSessionsPerTenant],
    );
  }

  async sessionStorageStats(tenantId: string): Promise<SessionRepositoryStorageStats> {
    await this.initialize();
    const result = await this.db.client().query(
      `SELECT COUNT(*)::int AS total_sessions,
              COALESCE(SUM(octet_length(state::text)), 0)::bigint AS total_size
         FROM ${this.db.table('session_states')} WHERE tenant_id = $1`,
      [tenantId],
    );
    return {
      totalSessions: Number(result.rows[0]?.total_sessions ?? 0),
      totalSize: Number(result.rows[0]?.total_size ?? 0),
    };
  }

  private async createSchema(): Promise<void> {
    const client = await this.db.pool.connect();
    const lockKey = postgresAdvisoryLockKey(
      `runtime-store-schema:${this.db.schema}:${this.db.prefix}`,
    );
    let lockAcquired = false;
    try {
      await client.query('SELECT pg_advisory_lock($1, $2)', [lockKey[0], lockKey[1]]);
      lockAcquired = true;
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.db.schema}`);
      await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.db.table('metadata')} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${this.db.table('commands')} (
        tenant_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        command_fingerprint TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed', 'sealed', 'completed', 'abandoned')),
        expires_at TIMESTAMPTZ NOT NULL,
        result JSONB,
        abandon_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, command_id)
      );

      CREATE TABLE IF NOT EXISTS ${this.db.table('sessions')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (tenant_id, session_id)
      );

      CREATE INDEX IF NOT EXISTS ${this.db.prefix}_sessions_listing_idx
        ON ${this.db.table('sessions')} (
          tenant_id, updated_at DESC, session_id ASC
        );

      CREATE TABLE IF NOT EXISTS ${this.db.table('stream_heads')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        stream_name TEXT NOT NULL,
        first_sequence BIGINT NOT NULL DEFAULT 1,
        next_sequence BIGINT NOT NULL DEFAULT 1,
        PRIMARY KEY (tenant_id, session_id, stream_name)
      );

      CREATE TABLE IF NOT EXISTS ${this.db.table('events')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        stream_name TEXT NOT NULL,
        sequence BIGINT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, session_id, stream_name, sequence),
        UNIQUE (tenant_id, event_id)
      );

      -- Idempotency records live outside the trimmable event log: a retry that
      -- outlives event retention must still be recognised as a repeat, and the
      -- stored payload lets the repeat return the original event either way.
      CREATE TABLE IF NOT EXISTS ${this.db.table('event_keys')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        sequence BIGINT NOT NULL,
        event_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, session_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS ${this.db.table('session_states')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, session_id)
      );
    `);
      const storedVersion = await client.query(
        `SELECT value
           FROM ${this.db.table('metadata')}
          WHERE key = 'schema_version'`,
      );
      const previousSchemaVersion = storedVersion.rows[0]
        ? Number(storedVersion.rows[0].value)
        : RUNTIME_STORE_SCHEMA_VERSION;
      if (previousSchemaVersion !== RUNTIME_STORE_SCHEMA_VERSION) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          `Unsupported Runtime Store schema version: ${String(storedVersion.rows[0]?.value)}`,
        );
      }
      await this.createWorkerSchema(client);
      await client.query(
        `INSERT INTO ${this.db.table('metadata')} (key, value)
         VALUES ('schema_version', $1)
         ON CONFLICT (key) DO NOTHING`,
        [String(RUNTIME_STORE_SCHEMA_VERSION)],
      );
    } finally {
      if (lockAcquired) {
        await client
          .query('SELECT pg_advisory_unlock($1, $2)', [lockKey[0], lockKey[1]])
          .catch(() => undefined);
      }
      client.release();
    }
  }
}
