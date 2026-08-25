import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from 'pg';
import {
  AGENT_PROTOCOL_VERSION,
  parseAgentCommandResult,
  parseAgentServerEvent,
  type AgentCommandResult,
  type AgentEventPage,
  type AgentServerEvent,
} from '../protocol/index.js';
import type { ContentPart, Message } from '../services/ChatServiceInterface.js';
import {
  DurableEventSequenceConflictError,
  DurableEventStoreError,
} from '../session/events/DurableEventStore.js';
import {
  parseDurableEventDraft,
  parseDurableEventEnvelope,
} from '../session/events/schemas.js';
import {
  DURABLE_EVENT_SCHEMA_VERSION,
  type DurableEventAppendOptions,
  type DurableEventAppendResult,
  type DurableEventDraft,
  type DurableEventPage,
  type DurableEventReadOptions,
} from '../session/events/types.js';
import type {
  PersistedToolUse,
  SessionRepositoryCompactionMetadata,
  SessionRepositoryHealth,
  SessionRepositoryMessageMetadata,
  SessionRepositoryStorageStats,
  SessionRepositorySubagentInfo,
  SessionRepositorySubagentRef,
} from '../session/SessionRepository.js';
import type {
  SessionSnapshot,
  SessionState,
  SessionSummary,
} from '../session/SessionStore.js';
import type {
  ContextData,
  PendingInputInfo,
  SessionInfo,
} from '../context/types.js';
import {
  EventSequence,
  MessageId,
  type InputId,
  type RequestId,
  type SessionId,
} from '../types/branded.js';
import type {
  JsonObject,
  JsonValue,
  MessageRole,
} from '../types/common.js';
import {
  cloneJsonValue,
  cloneMessage,
} from '../services/messageUtils.js';
import { toJsonValue } from '../utils/jsonValue.js';
import type {
  AgentCommandClaim,
  AgentServerSessionRecord,
} from './AgentServerStore.js';
import {
  RUNTIME_STORE_SCHEMA_VERSION,
  RuntimeStoreError,
  type RuntimeCommandCommit,
  type RuntimeCommitResult,
  type RuntimeDomainEvent,
  type RuntimeDomainEventPage,
  type RuntimeEffectRecord,
  type RuntimeEffectStatus,
  type RuntimeProjectionRecord,
  type RuntimeStore,
  type RuntimeTenantStore,
} from './RuntimeStore.js';

const DEFAULT_MAX_EVENTS_PER_SESSION = 10_000;
const DEFAULT_MAX_SESSIONS_PER_TENANT = 10_000;
const SESSION_PROJECTION = 'session';

export interface PostgresRuntimeStoreOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  readonly schema?: string;
  readonly tablePrefix?: string;
  readonly maxAgentEventsPerSession?: number;
  readonly maxSessionsPerTenant?: number;
}

interface StreamHeadRow extends QueryResultRow {
  first_sequence: string | number;
  next_sequence: string | number;
}

interface PayloadRow extends QueryResultRow {
  payload: unknown;
}

interface CommandRow extends QueryResultRow {
  command_fingerprint: string;
  lease_id: string;
  status: 'claimed' | 'sealed' | 'completed';
  expires_at: Date | string;
  result: unknown | null;
}

interface ProjectionRow extends QueryResultRow {
  projection_offset: string | number;
  state: unknown;
  updated_at: Date | string;
}

interface EffectRow extends QueryResultRow {
  tenant_id: string;
  session_id: string;
  command_id: string;
  effect_id: string;
  effect_type: string;
  payload: unknown;
  idempotency_key: string;
  status: RuntimeEffectStatus;
  attempts: number;
  available_at: Date | string;
  created_at: Date | string;
  result: unknown | null;
  error: unknown | null;
}

function quoteIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new RangeError(`${label} must be a PostgreSQL identifier`);
  }
  return `"${value}"`;
}

function asNumber(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RuntimeStoreError(
      'RUNTIME_STORE_INVALID_TRANSACTION',
      `PostgreSQL returned an unsafe integer: ${String(value)}`,
    );
  }
  return parsed;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asJsonObject(value: unknown): JsonObject {
  return structuredClone(value) as JsonObject;
}

function asSessionState(value: unknown): SessionState {
  return structuredClone(value) as SessionState;
}

function advisoryLockKey(key: string): readonly [number, number] {
  const digest = createHash('sha256').update(key).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505'
  );
}

function assertStrictJsonValue(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
): void {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_INVALID_TRANSACTION',
        `${label} contains a non-finite number`,
      );
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new RuntimeStoreError(
      'RUNTIME_STORE_INVALID_TRANSACTION',
      `${label} contains a non-JSON value`,
    );
  }
  if (seen.has(value)) {
    throw new RuntimeStoreError(
      'RUNTIME_STORE_INVALID_TRANSACTION',
      `${label} contains a circular reference`,
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertStrictJsonValue(item, `${label}[${index}]`, seen);
    });
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RuntimeStoreError(
      'RUNTIME_STORE_INVALID_TRANSACTION',
      `${label} contains a non-plain object`,
    );
  }
  for (const [key, item] of Object.entries(value)) {
    assertStrictJsonValue(item, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function assertJsonObject(value: unknown, label: string): void {
  assertStrictJsonValue(value, label);
  let converted: JsonValue;
  try {
    converted = toJsonValue(value);
  } catch (error) {
    throw new RuntimeStoreError(
      'RUNTIME_STORE_INVALID_TRANSACTION',
      `${label} is not JSON serializable`,
      { cause: error },
    );
  }
  if (
    converted === null
    || Array.isArray(converted)
    || typeof converted !== 'object'
  ) {
    throw new RuntimeStoreError(
      'RUNTIME_STORE_INVALID_TRANSACTION',
      `${label} must be a JSON object`,
    );
  }
}

function initialSessionState(
  sessionId: SessionId,
  now: number,
  subagentInfo?: SessionRepositorySubagentInfo,
): SessionState {
  const timestamp = new Date(now).toISOString();
  const sessionInfo: Partial<SessionInfo> = {
    sessionId,
    rootId: subagentInfo?.parentSessionId ?? sessionId,
    parentId: subagentInfo?.parentSessionId,
    relationType: subagentInfo ? 'subagent' : undefined,
    status: 'running',
    agentType: subagentInfo?.subagentType,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    sessionId,
    createdAt: now,
    lastActivity: now,
    sessionInfo,
    timeline: [],
    messages: [],
    messageIds: [],
    summaryMessageIds: [],
    toolCalls: [],
    subagentRefs: [],
    pendingInputs: [],
  };
}

function appendMessage(
  state: SessionState,
  messageId: string,
  message: Message,
  createdAt: number,
  parentMessageId?: string,
): void {
  state.timeline.push({
    id: messageId,
    parentMessageId,
    createdAt,
    message: cloneMessage(message),
  });
  state.messages.push(cloneMessage(message));
  state.messageIds.push(messageId);
  state.lastActivity = createdAt;
}

function messageMetadata(
  metadata?: SessionRepositoryMessageMetadata,
): JsonValue | undefined {
  if (!metadata) {
    return undefined;
  }
  const result: JsonObject = {
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(metadata.usage ? { usage: metadata.usage } : {}),
    ...(metadata.customMetadata ?? {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

export class PostgresRuntimeStore implements RuntimeStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly schema: string;
  private readonly prefix: string;
  private readonly maxAgentEventsPerSession: number;
  private readonly maxSessionsPerTenant: number;
  private initialization?: Promise<void>;

  constructor(options: PostgresRuntimeStoreOptions = {}) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new TypeError(
        'PostgresRuntimeStore requires pool, connectionString, or poolConfig',
      );
    }
    this.pool = options.pool ?? new Pool({
      ...options.poolConfig,
      connectionString:
        options.connectionString ?? options.poolConfig?.connectionString,
    });
    this.ownsPool = !options.pool;
    this.schema = quoteIdentifier(options.schema ?? 'public', 'schema');
    this.prefix = quoteIdentifier(
      options.tablePrefix ?? 'blade_runtime',
      'tablePrefix',
    ).slice(1, -1);
    this.maxAgentEventsPerSession =
      options.maxAgentEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION;
    this.maxSessionsPerTenant =
      options.maxSessionsPerTenant ?? DEFAULT_MAX_SESSIONS_PER_TENANT;
    for (const [name, value] of [
      ['maxAgentEventsPerSession', this.maxAgentEventsPerSession],
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
      await this.pool.query('SELECT 1');
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
    commandId: string,
    commandFingerprint: string,
    ttlMs: number,
  ): Promise<AgentCommandClaim> {
    if (
      !tenantId.trim()
      || !commandId.trim()
      || !commandFingerprint.trim()
      || !Number.isSafeInteger(ttlMs)
      || ttlMs < 1
    ) {
      throw new RangeError('Command claim parameters are invalid');
    }
    await this.initialize();
    return this.transaction(async (client) => {
      await this.lock(client, `command:${tenantId}:${commandId}`);
      const existing = await client.query<CommandRow>(
        `SELECT command_fingerprint, lease_id, status, expires_at, result
           FROM ${this.table('commands')}
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
      const now = Date.now();
      if (
        row
        && (
          row.status === 'sealed'
          || new Date(row.expires_at).getTime() > now
        )
      ) {
        return {
          status: 'in_progress',
          retryAfterMs: row.status === 'sealed'
            ? 1000
            : Math.max(1, new Date(row.expires_at).getTime() - now),
        };
      }
      const leaseId = nanoid();
      const expiresAt = new Date(now + ttlMs);
      await client.query(
        `INSERT INTO ${this.table('commands')} (
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
    commandId: string,
    leaseId: string,
  ): Promise<void> {
    await this.initialize();
    const result = await this.pool.query(
      `UPDATE ${this.table('commands')}
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
    commandId: string,
    leaseId: string,
    result: AgentCommandResult,
  ): Promise<void> {
    await this.initialize();
    const updated = await this.pool.query(
      `UPDATE ${this.table('commands')}
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
    commandId: string,
    leaseId: string,
  ): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `DELETE FROM ${this.table('commands')}
        WHERE tenant_id = $1 AND command_id = $2 AND lease_id = $3
          AND status = 'claimed'`,
      [tenantId, commandId, leaseId],
    );
  }

  async putSession(record: AgentServerSessionRecord): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO ${this.table('sessions')} (
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
    const result = await this.pool.query(
      `SELECT tenant_id, session_id, created_by, status,
              created_at, updated_at, metadata
         FROM ${this.table('sessions')}
        WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    );
    const row = result.rows[0] as
      | {
          tenant_id: string;
          session_id: string;
          created_by: string;
          status: 'active' | 'closed';
          created_at: Date | string;
          updated_at: Date | string;
          metadata: JsonObject;
        }
      | undefined;
    return row
      ? {
          tenantId: row.tenant_id,
          createdBy: row.created_by,
          sessionId: row.session_id as SessionId,
          status: row.status,
          createdAt: asIso(row.created_at),
          updatedAt: asIso(row.updated_at),
          ...(Object.keys(row.metadata ?? {}).length > 0
            ? { metadata: asJsonObject(row.metadata) }
            : {}),
        }
      : null;
  }

  async listSessions(
    tenantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ sessions: AgentServerSessionRecord[]; nextCursor?: string }> {
    await this.initialize();
    const limit = options.limit ?? 50;
    const offset = options.cursor ? Number(options.cursor) : 0;
    if (
      !Number.isSafeInteger(offset)
      || offset < 0
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > 100
    ) {
      throw new RangeError('Session list pagination is invalid');
    }
    const result = await this.pool.query(
      `SELECT tenant_id, session_id, created_by, status,
              created_at, updated_at, metadata
         FROM ${this.table('sessions')}
        WHERE tenant_id = $1
        ORDER BY updated_at DESC, session_id ASC
        OFFSET $2 LIMIT $3`,
      [tenantId, offset, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit) as Array<{
      tenant_id: string;
      session_id: string;
      created_by: string;
      status: 'active' | 'closed';
      created_at: Date | string;
      updated_at: Date | string;
      metadata: JsonObject;
    }>;
    return {
      sessions: rows.map((row) => ({
        tenantId: row.tenant_id,
        createdBy: row.created_by,
        sessionId: row.session_id as SessionId,
        status: row.status,
        createdAt: asIso(row.created_at),
        updatedAt: asIso(row.updated_at),
        ...(Object.keys(row.metadata ?? {}).length > 0
          ? { metadata: asJsonObject(row.metadata) }
          : {}),
      })),
      ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  async appendEvent(
    tenantId: string,
    sessionId: SessionId,
    event: Omit<AgentServerEvent, 'eventId' | 'sequence'>,
  ): Promise<AgentServerEvent> {
    if (event.sessionId !== sessionId) {
      throw new RangeError('Event Session does not match the target event log');
    }
    await this.initialize();
    return this.transaction(async (client) => {
      const [stored] = await this.appendStream(
        client,
        tenantId,
        sessionId,
        'agent',
        undefined,
        [({ sequence, eventId, recordedAt }) => ({
          ...event,
          protocolVersion: AGENT_PROTOCOL_VERSION,
          eventId,
          sequence,
          occurredAt: event.occurredAt ?? recordedAt,
        })],
        this.maxAgentEventsPerSession,
      );
      return parseAgentServerEvent(stored);
    });
  }

  async readEvents(
    tenantId: string,
    sessionId: SessionId,
    options: { after?: number; limit?: number } = {},
  ): Promise<AgentEventPage> {
    const page = await this.readStream(
      tenantId,
      sessionId,
      'agent',
      options.after,
      options.limit,
    );
    const events = page.payloads.map((payload) =>
      parseAgentServerEvent(payload));
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

  async commitRuntimeTransaction(
    commit: RuntimeCommandCommit,
  ): Promise<RuntimeCommitResult> {
    await this.initialize();
    this.validateRuntimeCommit(commit);
    if (
      commit.projection
      && commit.events?.length
      && commit.projection.offset < 1
    ) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_INVALID_TRANSACTION',
        'Projection offset must reference a committed event',
      );
    }
    try {
      return await this.transaction(async (client) => {
        await this.lock(
          client,
          `command:${commit.tenantId}:${commit.command.commandId}`,
        );
        const commandResult = await client.query<CommandRow>(
          `SELECT command_fingerprint, lease_id, status, expires_at, result
             FROM ${this.table('commands')}
            WHERE tenant_id = $1 AND command_id = $2
            FOR UPDATE`,
          [commit.tenantId, commit.command.commandId],
        );
        const existing = commandResult.rows[0];
        if (
          existing
          && existing.command_fingerprint !== commit.command.fingerprint
        ) {
          throw new RuntimeStoreError(
            'RUNTIME_STORE_COMMAND_CONFLICT',
            `Command ${commit.command.commandId} has a different fingerprint`,
          );
        }
        if (existing?.result !== null && existing?.result !== undefined) {
          return this.loadCommittedRuntimeResult(client, commit);
        }
        if (commit.command.leaseId) {
          if (!existing || existing.lease_id !== commit.command.leaseId) {
            throw new RuntimeStoreError(
              'RUNTIME_STORE_LEASE_LOST',
              `Command lease ${commit.command.commandId}/${commit.command.leaseId} is not active`,
            );
          }
        } else if (existing) {
          throw new RuntimeStoreError(
            'RUNTIME_STORE_LEASE_LOST',
            `Command ${commit.command.commandId} already has an active receipt`,
          );
        } else {
          await client.query(
            `INSERT INTO ${this.table('commands')} (
               tenant_id, command_id, command_fingerprint, lease_id,
               status, expires_at, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, 'sealed', 'infinity', NOW(), NOW())`,
            [
              commit.tenantId,
              commit.command.commandId,
              commit.command.fingerprint,
              `atomic:${commit.command.commandId}`,
            ],
          );
        }

        const storedEvents = await this.appendDomainEvents(client, commit);
        const effects = await this.insertEffects(client, commit);
        const projection = commit.projection
          ? await this.writeProjection(client, commit)
          : undefined;

        const completed = await client.query(
          `UPDATE ${this.table('commands')}
              SET status = 'completed', expires_at = 'infinity',
                  result = $4::jsonb, updated_at = NOW()
            WHERE tenant_id = $1 AND command_id = $2
              AND command_fingerprint = $3`,
          [
            commit.tenantId,
            commit.command.commandId,
            commit.command.fingerprint,
            JSON.stringify(commit.command.result),
          ],
        );
        if (completed.rowCount !== 1) {
          throw new RuntimeStoreError(
            'RUNTIME_STORE_LEASE_LOST',
            `Command ${commit.command.commandId} could not be completed`,
          );
        }
        return {
          status: 'committed',
          events: storedEvents,
          effects,
          ...(projection ? { projection } : {}),
        };
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_COMMAND_CONFLICT',
          `Runtime transaction ${commit.command.commandId} reuses an event or effect identity`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async readDomainEvents(
    tenantId: string,
    sessionId: SessionId,
    options: { readonly after?: number; readonly limit?: number } = {},
  ): Promise<RuntimeDomainEventPage> {
    const page = await this.readStream(
      tenantId,
      sessionId,
      'domain',
      options.after,
      options.limit,
    );
    return {
      events: page.payloads.map((payload) =>
        structuredClone(payload) as unknown as RuntimeDomainEvent),
      headSequence: page.headSequence,
      hasMore: page.hasMore,
    };
  }

  async listEffects(
    tenantId: string,
    options: {
      readonly sessionId?: SessionId;
      readonly status?: RuntimeEffectStatus;
      readonly limit?: number;
    } = {},
  ): Promise<readonly RuntimeEffectRecord[]> {
    await this.initialize();
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('Effect list limit must be between 1 and 1000');
    }
    const values: unknown[] = [tenantId];
    const predicates = ['tenant_id = $1'];
    if (options.sessionId) {
      values.push(options.sessionId);
      predicates.push(`session_id = $${values.length}`);
    }
    if (options.status) {
      values.push(options.status);
      predicates.push(`status = $${values.length}`);
    }
    values.push(limit);
    const result = await this.pool.query<EffectRow>(
      `SELECT tenant_id, session_id, command_id, effect_id, effect_type,
              payload, idempotency_key, status, attempts, available_at,
              created_at, result, error
         FROM ${this.table('outbox')}
        WHERE ${predicates.join(' AND ')}
        ORDER BY created_at ASC, effect_id ASC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => this.effectRecord(row));
  }

  async getProjection(
    tenantId: string,
    sessionId: SessionId,
    name: string,
  ): Promise<RuntimeProjectionRecord | null> {
    await this.initialize();
    const result = await this.pool.query<ProjectionRow>(
      `SELECT projection_offset, state, updated_at
         FROM ${this.table('projections')}
        WHERE tenant_id = $1 AND session_id = $2 AND projection_name = $3`,
      [tenantId, sessionId, name],
    );
    const row = result.rows[0];
    return row
      ? {
          tenantId,
          sessionId,
          name,
          offset: asNumber(row.projection_offset),
          state: asJsonObject(row.state),
          updatedAt: asIso(row.updated_at),
        }
      : null;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
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
    return this.transaction(async (client) => {
      const previousSequence = await this.currentHead(
        client,
        tenantId,
        sessionId,
        'durable',
      );
      if (
        options.expectedLastSequence !== undefined
        && options.expectedLastSequence !== previousSequence
      ) {
        throw new DurableEventSequenceConflictError(
          options.expectedLastSequence,
          previousSequence === null
            ? null
            : EventSequence(previousSequence),
        );
      }
      const events = await this.appendStream(
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
      );
      const durableEvents = events.map((value) =>
        parseDurableEventEnvelope(value));
      const last = durableEvents.at(-1);
      if (!last) {
        throw new DurableEventStoreError(
          'DURABLE_EVENT_INVALID_APPEND',
          'A durable event append produced no events',
        );
      }
      return {
        events: durableEvents,
        previousSequence: previousSequence === null
          ? null
          : EventSequence(previousSequence),
        lastSequence: last.sequence,
      };
    });
  }

  async readDurableEvents(
    tenantId: string,
    sessionId: SessionId,
    options: DurableEventReadOptions = {},
  ): Promise<DurableEventPage> {
    options.signal?.throwIfAborted();
    const page = await this.readStream(
      tenantId,
      sessionId,
      'durable',
      options.after === undefined ? undefined : Number(options.after),
      options.limit,
    );
    const events = page.payloads.map((value) =>
      parseDurableEventEnvelope(value));
    const last = events.at(-1);
    return {
      events,
      headSequence: page.headSequence === null
        ? null
        : EventSequence(page.headSequence),
      nextCursor: last?.sequence ?? null,
      hasMore: page.hasMore,
    };
  }

  async getDurableHead(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<EventSequence | null> {
    await this.initialize();
    const result = await this.pool.query<StreamHeadRow>(
      `SELECT first_sequence, next_sequence
         FROM ${this.table('stream_heads')}
        WHERE tenant_id = $1 AND session_id = $2 AND stream_name = 'durable'`,
      [tenantId, sessionId],
    );
    const row = result.rows[0];
    return row ? EventSequence(asNumber(row.next_sequence) - 1) : null;
  }

  async loadSessionState(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<SessionState | null> {
    const projection = await this.getProjection(
      tenantId,
      sessionId,
      SESSION_PROJECTION,
    );
    return projection ? asSessionState(projection.state) : null;
  }

  async mutateSessionState<T>(
    tenantId: string,
    sessionId: SessionId,
    eventType: string,
    eventData: JsonObject,
    mutate: (state: SessionState, now: number) => T,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<T> {
    return this.mutateSessionStateBatch(
      tenantId,
      sessionId,
      [{ type: eventType, data: eventData }],
      mutate,
      subagentInfo,
    );
  }

  async mutateSessionStateBatch<T>(
    tenantId: string,
    sessionId: SessionId,
    events: readonly {
      readonly type: string;
      readonly data: JsonObject;
    }[],
    mutate: (state: SessionState, now: number) => T,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<T> {
    if (events.length === 0) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_INVALID_TRANSACTION',
        'A Session projection mutation requires at least one event',
      );
    }
    await this.initialize();
    return this.transaction(async (client) => {
      await this.lock(
        client,
        `projection:${tenantId}:${sessionId}:${SESSION_PROJECTION}`,
      );
      const projectionResult = await client.query<ProjectionRow>(
        `SELECT projection_offset, state, updated_at
           FROM ${this.table('projections')}
          WHERE tenant_id = $1 AND session_id = $2
            AND projection_name = $3
          FOR UPDATE`,
        [tenantId, sessionId, SESSION_PROJECTION],
      );
      const now = Date.now();
      const state = projectionResult.rows[0]
        ? asSessionState(projectionResult.rows[0].state)
        : initialSessionState(sessionId, now, subagentInfo);
      const result = mutate(state, now);
      const stored = await this.appendStream(
        client,
        tenantId,
        sessionId,
        'transcript',
        undefined,
        events.map((event) => ({ sequence, eventId, recordedAt }) => ({
          schemaVersion: RUNTIME_STORE_SCHEMA_VERSION,
          eventId,
          sequence,
          tenantId,
          sessionId,
          commandId: `transcript:${eventId}`,
          type: event.type,
          data: event.data,
          occurredAt: recordedAt,
          recordedAt,
        })),
      );
      const offset = stored.at(-1)?.sequence;
      if (offset === undefined) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          'A Session projection mutation produced no events',
        );
      }
      await client.query(
        `INSERT INTO ${this.table('projections')} (
           tenant_id, session_id, projection_name, projection_offset, state, updated_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
         ON CONFLICT (tenant_id, session_id, projection_name) DO UPDATE SET
           projection_offset = EXCLUDED.projection_offset,
           state = EXCLUDED.state,
           updated_at = NOW()`,
        [
          tenantId,
          sessionId,
          SESSION_PROJECTION,
          offset,
          JSON.stringify(state),
        ],
      );
      return result;
    });
  }

  async deleteSessionProjection(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<void> {
    await this.initialize();
    await this.transaction(async (client) => {
      await this.lock(
        client,
        `projection:${tenantId}:${sessionId}:${SESSION_PROJECTION}`,
      );
      await this.lock(
        client,
        `stream:${tenantId}:${sessionId}:transcript`,
      );
      await client.query(
        `DELETE FROM ${this.table('events')}
          WHERE tenant_id = $1 AND session_id = $2 AND stream_name = 'transcript'`,
        [tenantId, sessionId],
      );
      await client.query(
        `DELETE FROM ${this.table('stream_heads')}
          WHERE tenant_id = $1 AND session_id = $2 AND stream_name = 'transcript'`,
        [tenantId, sessionId],
      );
      await client.query(
        `DELETE FROM ${this.table('projections')}
          WHERE tenant_id = $1 AND session_id = $2
            AND projection_name = $3`,
        [tenantId, sessionId, SESSION_PROJECTION],
      );
    });
  }

  async listSessionProjectionIds(tenantId: string): Promise<string[]> {
    await this.initialize();
    const result = await this.pool.query(
      `SELECT session_id
         FROM ${this.table('projections')}
        WHERE tenant_id = $1 AND projection_name = $2
        ORDER BY session_id ASC`,
      [tenantId, SESSION_PROJECTION],
    );
    return result.rows.map((row) => String(row.session_id));
  }

  async cleanupSessionProjections(tenantId: string): Promise<void> {
    await this.initialize();
    const result = await this.pool.query(
      `SELECT session_id
         FROM ${this.table('projections')}
        WHERE tenant_id = $1 AND projection_name = $2
        ORDER BY (state->>'lastActivity')::bigint DESC, session_id ASC
        OFFSET $3`,
      [tenantId, SESSION_PROJECTION, this.maxSessionsPerTenant],
    );
    for (const row of result.rows) {
      await this.deleteSessionProjection(
        tenantId,
        String(row.session_id) as SessionId,
      );
    }
  }

  async sessionStorageStats(
    tenantId: string,
  ): Promise<SessionRepositoryStorageStats> {
    await this.initialize();
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS total_sessions,
              COALESCE(SUM(octet_length(state::text)), 0)::bigint AS total_size
         FROM ${this.table('projections')}
        WHERE tenant_id = $1 AND projection_name = $2`,
      [tenantId, SESSION_PROJECTION],
    );
    return {
      totalSessions: Number(result.rows[0]?.total_sessions ?? 0),
      totalSize: Number(result.rows[0]?.total_size ?? 0),
    };
  }

  private validateRuntimeCommit(commit: RuntimeCommandCommit): void {
    for (const [label, value] of [
      ['tenantId', commit.tenantId],
      ['sessionId', commit.sessionId],
      ['commandId', commit.command.commandId],
      ['command fingerprint', commit.command.fingerprint],
    ] as const) {
      if (!String(value).trim()) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          `${label} must not be empty`,
        );
      }
    }
    try {
      parseAgentCommandResult(commit.command.result);
    } catch (error) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_INVALID_TRANSACTION',
        'Command result is not a valid protocol result',
        { cause: error },
      );
    }
    if (
      commit.expectedLastSequence !== undefined
      && commit.expectedLastSequence !== null
      && (
        !Number.isSafeInteger(commit.expectedLastSequence)
        || commit.expectedLastSequence < 1
      )
    ) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_INVALID_TRANSACTION',
        'expectedLastSequence must be null or a positive safe integer',
      );
    }

    const eventIds = new Set<string>();
    for (const [index, event] of (commit.events ?? []).entries()) {
      if (!event.type.trim()) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          `Event type at index ${index} must not be empty`,
        );
      }
      assertJsonObject(event.data, `Event data at index ${index}`);
      if (event.eventId) {
        if (eventIds.has(event.eventId)) {
          throw new RuntimeStoreError(
            'RUNTIME_STORE_INVALID_TRANSACTION',
            `Duplicate eventId in transaction: ${event.eventId}`,
          );
        }
        eventIds.add(event.eventId);
      }
      if (
        event.occurredAt
        && !Number.isFinite(Date.parse(event.occurredAt))
      ) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          `Event occurredAt at index ${index} is invalid`,
        );
      }
    }

    const effectIds = new Set<string>();
    const idempotencyKeys = new Set<string>();
    for (const [index, effect] of (commit.effects ?? []).entries()) {
      if (
        !effect.effectId.trim()
        || !effect.type.trim()
        || !effect.idempotencyKey.trim()
      ) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          `Effect identifiers at index ${index} must not be empty`,
        );
      }
      if (
        effectIds.has(effect.effectId)
        || idempotencyKeys.has(effect.idempotencyKey)
      ) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          `Duplicate effect identity at index ${index}`,
        );
      }
      effectIds.add(effect.effectId);
      idempotencyKeys.add(effect.idempotencyKey);
      assertJsonObject(effect.payload, `Effect payload at index ${index}`);
      if (
        effect.availableAt
        && !Number.isFinite(Date.parse(effect.availableAt))
      ) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          `Effect availableAt at index ${index} is invalid`,
        );
      }
    }

    if (commit.projection) {
      if (
        !commit.projection.name.trim()
        || !Number.isSafeInteger(commit.projection.offset)
        || commit.projection.offset < 0
      ) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          'Projection name and offset are invalid',
        );
      }
      if (
        commit.projection.expectedOffset !== undefined
        && commit.projection.expectedOffset !== null
        && (
          !Number.isSafeInteger(commit.projection.expectedOffset)
          || commit.projection.expectedOffset < 0
        )
      ) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          'Projection expectedOffset is invalid',
        );
      }
      assertJsonObject(commit.projection.state, 'Projection state');
    }
  }

  private async createSchema(): Promise<void> {
    const client = await this.pool.connect();
    const lockKey = advisoryLockKey(
      `runtime-store-schema:${this.schema}:${this.prefix}`,
    );
    let lockAcquired = false;
    try {
      await client.query(
        'SELECT pg_advisory_lock($1, $2)',
        [lockKey[0], lockKey[1]],
      );
      lockAcquired = true;
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.table('metadata')} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${this.table('commands')} (
        tenant_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        command_fingerprint TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed', 'sealed', 'completed')),
        expires_at TIMESTAMPTZ NOT NULL,
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, command_id)
      );

      CREATE TABLE IF NOT EXISTS ${this.table('sessions')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (tenant_id, session_id)
      );

      CREATE INDEX IF NOT EXISTS ${this.prefix}_sessions_listing_idx
        ON ${this.table('sessions')} (
          tenant_id, updated_at DESC, session_id ASC
        );

      CREATE TABLE IF NOT EXISTS ${this.table('stream_heads')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        stream_name TEXT NOT NULL,
        first_sequence BIGINT NOT NULL DEFAULT 1,
        next_sequence BIGINT NOT NULL DEFAULT 1,
        PRIMARY KEY (tenant_id, session_id, stream_name)
      );

      CREATE TABLE IF NOT EXISTS ${this.table('events')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        stream_name TEXT NOT NULL,
        sequence BIGINT NOT NULL,
        event_id TEXT NOT NULL,
        command_id TEXT,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, session_id, stream_name, sequence),
        UNIQUE (tenant_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS ${this.prefix}_events_command_idx
        ON ${this.table('events')} (tenant_id, command_id)
        WHERE command_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS ${this.table('outbox')} (
        tenant_id TEXT NOT NULL,
        effect_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        effect_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        result JSONB,
        error JSONB,
        PRIMARY KEY (tenant_id, effect_id),
        UNIQUE (tenant_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS ${this.prefix}_outbox_pending_idx
        ON ${this.table('outbox')} (tenant_id, status, available_at);

      CREATE TABLE IF NOT EXISTS ${this.table('projections')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        projection_name TEXT NOT NULL,
        projection_offset BIGINT NOT NULL,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, session_id, projection_name)
      );
    `);
      await client.query(
        `INSERT INTO ${this.table('metadata')} (key, value)
         VALUES ('schema_version', $1)
         ON CONFLICT (key) DO NOTHING`,
        [String(RUNTIME_STORE_SCHEMA_VERSION)],
      );
      const version = await client.query(
        `SELECT value
           FROM ${this.table('metadata')}
          WHERE key = 'schema_version'`,
      );
      if (
        Number(version.rows[0]?.value) !== RUNTIME_STORE_SCHEMA_VERSION
      ) {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_INVALID_TRANSACTION',
          `Unsupported Runtime Store schema version: ${String(
            version.rows[0]?.value,
          )}`,
        );
      }
    } finally {
      if (lockAcquired) {
        await client.query(
          'SELECT pg_advisory_unlock($1, $2)',
          [lockKey[0], lockKey[1]],
        ).catch(() => undefined);
      }
      client.release();
    }
  }

  private table(suffix: string): string {
    return `${this.schema}.${quoteIdentifier(`${this.prefix}_${suffix}`, 'table')}`;
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lock(client: PoolClient, key: string): Promise<void> {
    const lockKey = advisoryLockKey(key);
    await client.query(
      'SELECT pg_advisory_xact_lock($1, $2)',
      [lockKey[0], lockKey[1]],
    );
  }

  private async currentHead(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    streamName: string,
  ): Promise<number | null> {
    await this.lock(client, `stream:${tenantId}:${sessionId}:${streamName}`);
    const result = await client.query<StreamHeadRow>(
      `SELECT first_sequence, next_sequence
         FROM ${this.table('stream_heads')}
        WHERE tenant_id = $1 AND session_id = $2 AND stream_name = $3
        FOR UPDATE`,
      [tenantId, sessionId, streamName],
    );
    return result.rows[0]
      ? asNumber(result.rows[0].next_sequence) - 1
      : null;
  }

  private async appendStream<TPayload extends {
    readonly eventId: string;
    readonly type: string;
    readonly occurredAt: string;
    readonly commandId?: string;
  }>(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    streamName: string,
    knownHead: number | null | undefined,
    factories: readonly ((fields: {
      sequence: number;
      eventId: string;
      recordedAt: string;
    }) => TPayload)[],
    retention?: number,
  ): Promise<TPayload[]> {
    const current = knownHead === undefined
      ? await this.currentHead(client, tenantId, sessionId, streamName)
      : knownHead;
    const firstSequence = (current ?? 0) + 1;
    const recordedAt = new Date().toISOString();
    const payloads = factories.map((factory, index) =>
      factory({
        sequence: firstSequence + index,
        eventId: nanoid(),
        recordedAt,
      }));
    if (payloads.length === 0) {
      return [];
    }
    const rows = payloads.map((payload, index) => ({
      tenant_id: tenantId,
      session_id: sessionId,
      stream_name: streamName,
      sequence: firstSequence + index,
      event_id: String(payload.eventId),
      command_id: typeof payload.commandId === 'string'
        ? payload.commandId
        : null,
      event_type: String(payload.type),
      payload,
      occurred_at: String(payload.occurredAt ?? recordedAt),
      recorded_at: recordedAt,
    }));
    await client.query(
      `INSERT INTO ${this.table('events')} (
         tenant_id, session_id, stream_name, sequence, event_id,
         command_id, event_type, payload, occurred_at, recorded_at
       )
       SELECT entry.tenant_id, entry.session_id, entry.stream_name,
              entry.sequence, entry.event_id, entry.command_id,
              entry.event_type, entry.payload, entry.occurred_at,
              entry.recorded_at
         FROM jsonb_to_recordset($1::jsonb) AS entry(
           tenant_id TEXT,
           session_id TEXT,
           stream_name TEXT,
           sequence BIGINT,
           event_id TEXT,
           command_id TEXT,
           event_type TEXT,
           payload JSONB,
           occurred_at TIMESTAMPTZ,
           recorded_at TIMESTAMPTZ
         )`,
      [JSON.stringify(rows)],
    );
    const nextSequence = firstSequence + payloads.length;
    const retainedFirst = retention
      ? Math.max(1, nextSequence - retention)
      : 1;
    await client.query(
      `INSERT INTO ${this.table('stream_heads')} (
         tenant_id, session_id, stream_name, first_sequence, next_sequence
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, session_id, stream_name) DO UPDATE SET
         first_sequence = EXCLUDED.first_sequence,
         next_sequence = EXCLUDED.next_sequence`,
      [tenantId, sessionId, streamName, retainedFirst, nextSequence],
    );
    if (retention) {
      await client.query(
        `DELETE FROM ${this.table('events')}
          WHERE tenant_id = $1 AND session_id = $2 AND stream_name = $3
            AND sequence < $4`,
        [tenantId, sessionId, streamName, retainedFirst],
      );
    }
    return payloads;
  }

  private async readStream(
    tenantId: string,
    sessionId: SessionId,
    streamName: string,
    after = 0,
    limit = 100,
  ): Promise<{
    payloads: JsonObject[];
    headSequence: number | null;
    hasMore: boolean;
  }> {
    await this.initialize();
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RangeError('Event cursor is invalid');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('Event page limit must be between 1 and 1000');
    }
    return this.transaction(async (client) => {
      await this.lock(
        client,
        `stream:${tenantId}:${sessionId}:${streamName}`,
      );
      const headResult = await client.query<StreamHeadRow>(
        `SELECT first_sequence, next_sequence
           FROM ${this.table('stream_heads')}
          WHERE tenant_id = $1 AND session_id = $2 AND stream_name = $3`,
        [tenantId, sessionId, streamName],
      );
      const head = headResult.rows[0];
      if (!head) {
        if (after > 0) {
          throw new RangeError('Event cursor is ahead of the session head');
        }
        return { payloads: [], headSequence: null, hasMore: false };
      }
      const firstSequence = asNumber(head.first_sequence);
      const nextSequence = asNumber(head.next_sequence);
      if (after < firstSequence - 1) {
        throw new RangeError('Event cursor is stale');
      }
      if (after >= nextSequence) {
        throw new RangeError('Event cursor is ahead of the session head');
      }
      const result = await client.query<PayloadRow>(
        `SELECT payload
           FROM ${this.table('events')}
          WHERE tenant_id = $1 AND session_id = $2 AND stream_name = $3
            AND sequence > $4
          ORDER BY sequence ASC
          LIMIT $5`,
        [tenantId, sessionId, streamName, after, limit + 1],
      );
      return {
        payloads: result.rows.slice(0, limit).map((row) =>
          asJsonObject(row.payload)),
        headSequence: nextSequence - 1,
        hasMore: result.rows.length > limit,
      };
    });
  }

  private async appendDomainEvents(
    client: PoolClient,
    commit: RuntimeCommandCommit,
  ): Promise<RuntimeDomainEvent[]> {
    const current = await this.currentHead(
      client,
      commit.tenantId,
      commit.sessionId,
      'domain',
    );
    if (
      commit.expectedLastSequence !== undefined
      && commit.expectedLastSequence !== current
    ) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_SEQUENCE_CONFLICT',
        `Expected runtime event sequence ${String(commit.expectedLastSequence)}, `
          + `but current sequence is ${String(current)}`,
      );
    }
    const payloads = await this.appendStream(
      client,
      commit.tenantId,
      commit.sessionId,
      'domain',
      current,
      (commit.events ?? []).map((draft) => ({ sequence, eventId, recordedAt }) => ({
        schemaVersion: RUNTIME_STORE_SCHEMA_VERSION,
        eventId: draft.eventId ?? eventId,
        tenantId: commit.tenantId,
        sessionId: commit.sessionId,
        commandId: commit.command.commandId,
        sequence,
        type: draft.type,
        data: draft.data,
        occurredAt: draft.occurredAt ?? recordedAt,
        recordedAt,
      })),
    );
    return payloads;
  }

  private async insertEffects(
    client: PoolClient,
    commit: RuntimeCommandCommit,
  ): Promise<RuntimeEffectRecord[]> {
    const effects: RuntimeEffectRecord[] = [];
    for (const effect of commit.effects ?? []) {
      const result = await client.query<EffectRow>(
        `INSERT INTO ${this.table('outbox')} (
           tenant_id, effect_id, session_id, command_id, effect_type,
           payload, idempotency_key, available_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING tenant_id, session_id, command_id, effect_id, effect_type,
                   payload, idempotency_key, status, attempts, available_at,
                   created_at, result, error`,
        [
          commit.tenantId,
          effect.effectId,
          commit.sessionId,
          commit.command.commandId,
          effect.type,
          JSON.stringify(effect.payload),
          effect.idempotencyKey,
          effect.availableAt ?? new Date().toISOString(),
        ],
      );
      const row = result.rows[0];
      if (row) {
        effects.push(this.effectRecord(row));
      }
    }
    return effects;
  }

  private async writeProjection(
    client: PoolClient,
    commit: RuntimeCommandCommit,
  ): Promise<RuntimeProjectionRecord> {
    const projection = commit.projection;
    if (!projection) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_INVALID_TRANSACTION',
        'Projection is required',
      );
    }
    const domainHead = await this.currentHead(
      client,
      commit.tenantId,
      commit.sessionId,
      'domain',
    );
    if (projection.offset !== (domainHead ?? 0)) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_INVALID_TRANSACTION',
        `Projection ${projection.name} offset ${projection.offset} `
          + `does not match domain head ${String(domainHead)}`,
      );
    }
    await this.lock(
      client,
      `projection:${commit.tenantId}:${commit.sessionId}:${projection.name}`,
    );
    const current = await client.query<ProjectionRow>(
      `SELECT projection_offset, state, updated_at
         FROM ${this.table('projections')}
        WHERE tenant_id = $1 AND session_id = $2 AND projection_name = $3
        FOR UPDATE`,
      [commit.tenantId, commit.sessionId, projection.name],
    );
    const currentOffset = current.rows[0]
      ? asNumber(current.rows[0].projection_offset)
      : null;
    if (
      projection.expectedOffset !== undefined
      && projection.expectedOffset !== currentOffset
    ) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_PROJECTION_CONFLICT',
        `Expected ${projection.name} offset ${String(projection.expectedOffset)}, `
          + `but current offset is ${String(currentOffset)}`,
      );
    }
    await client.query(
      `INSERT INTO ${this.table('projections')} (
         tenant_id, session_id, projection_name, projection_offset, state, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (tenant_id, session_id, projection_name) DO UPDATE SET
         projection_offset = EXCLUDED.projection_offset,
         state = EXCLUDED.state,
         updated_at = NOW()`,
      [
        commit.tenantId,
        commit.sessionId,
        projection.name,
        projection.offset,
        JSON.stringify(projection.state),
      ],
    );
    const stored = await this.getProjectionWithClient(
      client,
      commit.tenantId,
      commit.sessionId,
      projection.name,
    );
    if (!stored) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_INVALID_TRANSACTION',
        'Projection commit did not produce a record',
      );
    }
    return stored;
  }

  private async loadCommittedRuntimeResult(
    client: PoolClient,
    commit: RuntimeCommandCommit,
  ): Promise<RuntimeCommitResult> {
    const events = await client.query<PayloadRow>(
      `SELECT payload
         FROM ${this.table('events')}
        WHERE tenant_id = $1 AND session_id = $2
          AND stream_name = 'domain' AND command_id = $3
        ORDER BY sequence ASC`,
      [commit.tenantId, commit.sessionId, commit.command.commandId],
    );
    const effects = await client.query<EffectRow>(
      `SELECT tenant_id, session_id, command_id, effect_id, effect_type,
              payload, idempotency_key, status, attempts, available_at,
              created_at, result, error
         FROM ${this.table('outbox')}
        WHERE tenant_id = $1 AND session_id = $2 AND command_id = $3
        ORDER BY created_at ASC, effect_id ASC`,
      [commit.tenantId, commit.sessionId, commit.command.commandId],
    );
    const projection = commit.projection
      ? await this.getProjectionWithClient(
          client,
          commit.tenantId,
          commit.sessionId,
          commit.projection.name,
        )
      : null;
    return {
      status: 'replayed',
      events: events.rows.map((row) =>
        structuredClone(row.payload) as RuntimeDomainEvent),
      effects: effects.rows.map((row) => this.effectRecord(row)),
      ...(projection ? { projection } : {}),
    };
  }

  private async getProjectionWithClient(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    name: string,
  ): Promise<RuntimeProjectionRecord | null> {
    const result = await client.query<ProjectionRow>(
      `SELECT projection_offset, state, updated_at
         FROM ${this.table('projections')}
        WHERE tenant_id = $1 AND session_id = $2 AND projection_name = $3`,
      [tenantId, sessionId, name],
    );
    const row = result.rows[0];
    return row
      ? {
          tenantId,
          sessionId,
          name,
          offset: asNumber(row.projection_offset),
          state: asJsonObject(row.state),
          updatedAt: asIso(row.updated_at),
        }
      : null;
  }

  private effectRecord(row: EffectRow): RuntimeEffectRecord {
    return {
      tenantId: row.tenant_id,
      sessionId: row.session_id as SessionId,
      commandId: row.command_id,
      effectId: row.effect_id,
      type: row.effect_type,
      payload: asJsonObject(row.payload),
      idempotencyKey: row.idempotency_key,
      status: row.status,
      attempts: row.attempts,
      availableAt: asIso(row.available_at),
      createdAt: asIso(row.created_at),
      ...(row.result ? { result: asJsonObject(row.result) } : {}),
      ...(row.error ? { error: asJsonObject(row.error) } : {}),
    };
  }
}

class PostgresTenantRuntimeStore implements RuntimeTenantStore {
  constructor(
    private readonly runtime: PostgresRuntimeStore,
    private readonly tenantId: string,
  ) {}

  initialize(): Promise<void> {
    return this.runtime.initialize();
  }

  async createSession(
    sessionId: SessionId,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<void> {
    const existing = await this.runtime.loadSessionState(this.tenantId, sessionId);
    if (existing) {
      return;
    }
    await this.runtime.mutateSessionState(
      this.tenantId,
      sessionId,
      'transcript.session_created',
      {
        ...(subagentInfo
          ? {
              parentSessionId: subagentInfo.parentSessionId,
              subagentType: subagentInfo.subagentType,
              isSidechain: subagentInfo.isSidechain,
            }
          : {}),
      },
      () => initialSessionState(sessionId, Date.now(), subagentInfo),
      subagentInfo,
    );
  }

  async saveMessage(
    sessionId: SessionId,
    messageRole: MessageRole,
    content: string | ContentPart[],
    parentUuid: string | null = null,
    metadata?: SessionRepositoryMessageMetadata,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<string> {
    const messageId = MessageId(nanoid());
    return this.runtime.mutateSessionState(
      this.tenantId,
      sessionId,
      'transcript.message_saved',
      { messageId, role: messageRole },
      (state, now) => {
        appendMessage(
          state,
          messageId,
          {
            id: messageId,
            role: messageRole,
            content: structuredClone(content),
            reasoningContent: metadata?.reasoningContent,
            tool_calls: metadata?.toolCalls
              ? structuredClone(metadata.toolCalls)
              : undefined,
            metadata: messageMetadata(metadata),
            modelIdentity: metadata?.modelIdentity
              ? structuredClone(metadata.modelIdentity)
              : undefined,
          },
          now,
          parentUuid ?? undefined,
        );
        return messageId;
      },
      subagentInfo,
    );
  }

  async saveInputEnqueued(
    sessionId: SessionId,
    input: PendingInputInfo,
  ): Promise<void> {
    await this.runtime.mutateSessionState(
      this.tenantId,
      sessionId,
      'transcript.input_enqueued',
      { inputId: input.inputId },
      (state, now) => {
        state.pendingInputs = [
          ...state.pendingInputs.filter((item) => item.inputId !== input.inputId),
          {
            ...input,
            content: cloneJsonValue(input.content),
          },
        ];
        state.lastActivity = now;
      },
    );
  }

  async saveAppliedInputMessage(
    sessionId: SessionId,
    inputId: InputId,
    requestId: RequestId,
    content: string | ContentPart[],
    parentUuid: string | null = null,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<string> {
    const messageId = MessageId(nanoid());
    return this.runtime.mutateSessionState(
      this.tenantId,
      sessionId,
      'transcript.input_applied',
      { inputId, requestId, messageId },
      (state, now) => {
        state.pendingInputs = state.pendingInputs.filter(
          (input) => input.inputId !== inputId,
        );
        appendMessage(
          state,
          messageId,
          {
            id: messageId,
            role: 'user',
            content: structuredClone(content),
            metadata: { inputId, requestId },
          },
          now,
          parentUuid ?? undefined,
        );
        return messageId;
      },
      subagentInfo,
    );
  }

  async saveInputCancelled(
    sessionId: SessionId,
    inputId: InputId,
    reason: string,
  ): Promise<void> {
    await this.runtime.mutateSessionState(
      this.tenantId,
      sessionId,
      'transcript.input_cancelled',
      { inputId, reason },
      (state, now) => {
        state.pendingInputs = state.pendingInputs.filter(
          (input) => input.inputId !== inputId,
        );
        state.lastActivity = now;
      },
    );
  }

  async saveToolUse(
    sessionId: SessionId,
    toolName: string,
    toolInput: JsonValue,
    parentUuid: string | null = null,
    subagentInfo?: SessionRepositorySubagentInfo,
    requestedToolCallId?: string,
  ): Promise<PersistedToolUse> {
    const messageId = MessageId(nanoid());
    const toolCallId = requestedToolCallId ?? nanoid();
    return this.runtime.mutateSessionState(
      this.tenantId,
      sessionId,
      'transcript.tool_use_saved',
      { messageId, toolCallId, toolName },
      (state, now) => {
        appendMessage(
          state,
          messageId,
          {
            id: messageId,
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: toolCallId,
              type: 'function',
              function: {
                name: toolName,
                arguments: typeof toolInput === 'string'
                  ? toolInput
                  : JSON.stringify(toolInput),
              },
            }],
          },
          now,
          parentUuid ?? undefined,
        );
        state.toolCalls.push({
          id: toolCallId,
          name: toolName,
          input: cloneJsonValue(toolInput),
          messageId,
          timestamp: now,
          status: 'pending',
        });
        return { messageId, toolCallId };
      },
      subagentInfo,
    );
  }

  async saveToolResult(
    sessionId: SessionId,
    toolId: string,
    toolName: string,
    toolOutput: JsonValue,
    parentUuid: string | null = null,
    error?: string,
    subagentInfo?: SessionRepositorySubagentInfo,
    subagentRef?: SessionRepositorySubagentRef,
  ): Promise<string> {
    const messageId = MessageId(nanoid());
    return this.runtime.mutateSessionState(
      this.tenantId,
      sessionId,
      'transcript.tool_result_saved',
      { messageId, toolId, toolName },
      (state, now) => {
        appendMessage(
          state,
          messageId,
          {
            id: messageId,
            role: 'tool',
            content: error
              ? `Error: ${error}`
              : typeof toolOutput === 'string'
                ? toolOutput
                : JSON.stringify(toolOutput),
            tool_call_id: toolId,
            name: toolName,
          },
          now,
          parentUuid ?? undefined,
        );
        const call = [...state.toolCalls]
          .reverse()
          .find((item) => item.id === toolId && item.status === 'pending');
        if (call) {
          call.output = cloneJsonValue(toolOutput);
          call.error = error;
          call.status = error ? 'error' : 'success';
        }
        if (subagentRef) {
          state.subagentRefs.push({
            messageId,
            childSessionId: subagentRef.subagentSessionId,
            agentType: subagentRef.subagentType,
            status: subagentRef.subagentStatus,
            summary: subagentRef.subagentSummary,
            startedAt: new Date(now).toISOString(),
            finishedAt: subagentRef.subagentStatus === 'running'
              ? null
              : new Date(now).toISOString(),
          });
        }
        return messageId;
      },
      subagentInfo,
    );
  }

  async saveCompaction(
    sessionId: SessionId,
    summary: string,
    metadata: SessionRepositoryCompactionMetadata,
    parentUuid: string | null = null,
  ): Promise<string> {
    const messageId = MessageId(nanoid());
    return this.runtime.mutateSessionState(
      this.tenantId,
      sessionId,
      'transcript.compaction_saved',
      { messageId, trigger: metadata.trigger },
      (state, now) => {
        appendMessage(
          state,
          messageId,
          {
            id: messageId,
            role: 'system',
            content: summary,
            metadata: {
              ...metadata,
              _systemSource: 'compaction_summary',
            },
          },
          now,
          parentUuid ?? undefined,
        );
        state.summary = summary;
        state.summaryMessageIds.push(messageId);
        return messageId;
      },
    );
  }

  async saveContext(
    sessionId: SessionId,
    contextData: ContextData,
  ): Promise<void> {
    const messages = contextData.layers.conversation.messages.map((message) => ({
      messageId: MessageId(nanoid()),
      role: message.role,
      content: structuredClone(message.content),
    }));
    if (messages.length === 0) {
      return;
    }
    await this.runtime.mutateSessionStateBatch(
      this.tenantId,
      sessionId,
      messages.map(({ messageId, role }) => ({
        type: 'transcript.message_saved',
        data: { messageId, role },
      })),
      (state, now) => {
        for (const message of messages) {
          appendMessage(
            state,
            message.messageId,
            {
              id: message.messageId,
              role: message.role,
              content: message.content,
            },
            now,
          );
        }
      },
    );
  }

  loadState(sessionId: SessionId): Promise<SessionState | null> {
    return this.runtime.loadSessionState(this.tenantId, sessionId);
  }

  async loadMessages(sessionId: SessionId): Promise<Message[]> {
    const state = await this.loadState(sessionId);
    return state?.messages.map((message) => cloneMessage(message)) ?? [];
  }

  async forkState(
    sessionId: SessionId,
    options?: { messageId?: string },
  ): Promise<SessionSnapshot | null> {
    const state = await this.loadState(sessionId);
    if (!state) {
      return null;
    }
    let endIndex = state.timeline.length;
    if (options?.messageId) {
      const index = state.messageIds.indexOf(options.messageId);
      if (index === -1) {
        throw new Error(
          `Message with ID "${options.messageId}" not found in session history`,
        );
      }
      endIndex = index + 1;
    }
    const timeline = state.timeline.slice(0, endIndex);
    const messageIds = timeline.map((entry) => entry.id);
    return {
      sessionId,
      messages: timeline.map((entry) => cloneMessage(entry.message)),
      messageIds,
      lastActivity: timeline.at(-1)?.createdAt ?? state.createdAt,
      summary: [...timeline]
        .reverse()
        .find((entry) => state.summaryMessageIds.includes(entry.id))
        ?.message.content as string | undefined,
    };
  }

  listSessions(): Promise<string[]> {
    return this.runtime.listSessionProjectionIds(this.tenantId);
  }

  async getSessionSummary(
    sessionId: SessionId,
  ): Promise<SessionSummary | null> {
    const state = await this.loadState(sessionId);
    return state
      ? {
          sessionId,
          lastActivity: state.lastActivity,
          messageCount: state.messages.filter(
            (message) =>
              message.role === 'user' || message.role === 'assistant',
          ).length,
          topics: [],
          summaryText: state.summary,
        }
      : null;
  }

  deleteSession(sessionId: SessionId): Promise<void> {
    return this.runtime.deleteSessionProjection(this.tenantId, sessionId);
  }

  cleanupOldSessions(): Promise<void> {
    return this.runtime.cleanupSessionProjections(this.tenantId);
  }

  getStorageStats(): Promise<SessionRepositoryStorageStats> {
    return this.runtime.sessionStorageStats(this.tenantId);
  }

  async checkStorageHealth(): Promise<SessionRepositoryHealth> {
    const health = await this.runtime.healthCheck();
    return {
      isAvailable: health.ready,
      canWrite: health.ready,
      ...(!health.ready && health.details?.error
        ? { error: String(health.details.error) }
        : {}),
    };
  }

  append(
    sessionId: SessionId,
    events: readonly DurableEventDraft[],
    options?: DurableEventAppendOptions,
  ): Promise<DurableEventAppendResult> {
    return this.runtime.appendDurableEvents(
      this.tenantId,
      sessionId,
      events,
      options,
    );
  }

  read(
    sessionId: SessionId,
    options?: DurableEventReadOptions,
  ): Promise<DurableEventPage> {
    return this.runtime.readDurableEvents(
      this.tenantId,
      sessionId,
      options,
    );
  }

  getHeadSequence(sessionId: SessionId): Promise<EventSequence | null> {
    return this.runtime.getDurableHead(this.tenantId, sessionId);
  }
}
