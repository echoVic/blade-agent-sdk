import { createHash } from 'node:crypto';
import type { AsyncLocalStorage } from 'node:async_hooks';
import { nanoid } from 'nanoid';
import type {
  Pool,
  PoolClient,
  QueryResultRow,
} from 'pg';
import {
  DurableExecutionLeaseError,
  type DurableExecutionLease,
  type DurableExecutionLeaseAcquireOptions,
  type DurableExecutionFence,
} from '../session/events/DurableExecutionLeaseStore.js';
import type { DurableEventOperationOptions } from '../session/events/DurableEventStore.js';
import {
  ExecutionLeaseId,
  FencingToken,
  type SessionId,
  type WorkerId,
} from '../types/branded.js';
import type { JsonObject } from '../types/common.js';
import type {
  RuntimeEffectRecord,
  RuntimeEffectStatus,
} from './RuntimeStore.js';
import {
  assertRuntimeSessionTransition,
  type RuntimeEffectClaim,
  type RuntimeEffectClaimOptions,
  type RuntimeEffectExecutionMode,
  type RuntimeEffectFailureOptions,
  type RuntimeEffectLease,
  type RuntimeEffectReconciliation,
  type RuntimeRecoveryResult,
  type RuntimeSessionClaim,
  type RuntimeSessionClaimOptions,
  type RuntimeSessionRoute,
  type RuntimeSessionState,
  type RuntimeWorkerRecord,
  type RuntimeWorkerRegistration,
  WorkerRuntimeError,
  type WorkerRuntimeStore,
} from './WorkerRuntime.js';

const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATES: readonly RuntimeSessionState[] = [
  'provisioning',
  'running',
  'waiting_approval',
];

interface WorkerRow extends QueryResultRow {
  worker_id: string;
  status: 'active' | 'draining' | 'offline';
  capacity: number;
  active_sessions: number;
  metadata: unknown;
  registered_at: Date | string;
  last_heartbeat_at: Date | string;
  lease_expires_at: Date | string;
  draining_at: Date | string | null;
  heartbeat_active: boolean;
}

interface SessionRouteRow extends QueryResultRow {
  tenant_id: string;
  session_id: string;
  state: RuntimeSessionState;
  priority: number;
  attempt: number;
  fencing_token: string | number;
  worker_id: string | null;
  lease_id: string | null;
  lease_expires_at: Date | string | null;
  queued_at: Date | string;
  updated_at: Date | string;
  metadata: unknown;
  failure: unknown | null;
}

interface ExecutionLeaseRow extends QueryResultRow {
  tenant_id: string;
  session_id: string;
  fencing_token: string | number;
  lease_id: string;
  owner_id: string;
  acquired_at: Date | string;
  renewed_at: Date | string;
  expires_at: Date | string;
  released_at: Date | string | null;
  active: boolean;
}

interface EffectRow extends QueryResultRow {
  tenant_id: string;
  session_id: string;
  command_id: string;
  effect_id: string;
  effect_type: string;
  payload: unknown;
  idempotency_key: string;
  execution_mode: RuntimeEffectExecutionMode;
  status: RuntimeEffectStatus;
  attempts: number;
  available_at: Date | string;
  created_at: Date | string;
  worker_id: string | null;
  lease_id: string | null;
  fencing_token: string | number;
  lease_expires_at: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  result: unknown | null;
  error: unknown | null;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new RangeError('PostgreSQL identifier is invalid');
  }
  return `"${value}"`;
}

function asNumber(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new WorkerRuntimeError(
      'WORKER_INVALID',
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

function assertJsonObject(value: unknown, label: string): void {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, path: string): void => {
    if (
      item === null
      || typeof item === 'string'
      || typeof item === 'boolean'
    ) {
      return;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new WorkerRuntimeError(
          'WORKER_INVALID',
          `${path} contains a non-finite number`,
        );
      }
      return;
    }
    if (typeof item !== 'object') {
      throw new WorkerRuntimeError(
        'WORKER_INVALID',
        `${path} contains a non-JSON value`,
      );
    }
    if (seen.has(item)) {
      throw new WorkerRuntimeError(
        'WORKER_INVALID',
        `${path} contains a circular reference`,
      );
    }
    seen.add(item);
    if (Array.isArray(item)) {
      item.forEach((entry, index) => {
        visit(entry, `${path}[${index}]`);
      });
      seen.delete(item);
      return;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkerRuntimeError(
        'WORKER_INVALID',
        `${path} contains a non-plain object`,
      );
    }
    for (const [key, entry] of Object.entries(item)) {
      visit(entry, `${path}.${key}`);
    }
    seen.delete(item);
  };
  visit(value, label);
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new WorkerRuntimeError(
      'WORKER_INVALID',
      `${label} must be a JSON object`,
    );
  }
}

function lockKey(key: string): readonly [number, number] {
  const digest = createHash('sha256').update(key).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

function assertTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new WorkerRuntimeError(
      'WORKER_INVALID',
      `Lease ttlMs must be between 1 and ${MAX_LEASE_TTL_MS}`,
    );
  }
}

function assertCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new WorkerRuntimeError(
      'WORKER_INVALID',
      'Worker capacity must be a positive safe integer',
    );
  }
}

function assertPriority(priority: number): void {
  if (!Number.isSafeInteger(priority)) {
    throw new WorkerRuntimeError(
      'WORKER_INVALID',
      'Session priority must be a safe integer',
    );
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new WorkerRuntimeError(
      'WORKER_INVALID',
      'Effect claim limit must be between 1 and 100',
    );
  }
}

export class PostgresWorkerRuntime implements WorkerRuntimeStore {
  constructor(
    private readonly pool: Pool,
    private readonly schema: string,
    private readonly prefix: string,
    private readonly ensureInitialized: () => Promise<void>,
    private readonly transactionContext: AsyncLocalStorage<PoolClient>,
  ) {}

  async createSchema(
    client: PoolClient,
    previousSchemaVersion: number,
  ): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.table('workers')} (
        worker_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
          CHECK (status IN ('active', 'draining', 'offline')),
        capacity INTEGER NOT NULL CHECK (capacity > 0),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_expires_at TIMESTAMPTZ NOT NULL,
        draining_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS ${this.table('execution_leases')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
        lease_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL,
        renewed_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        released_at TIMESTAMPTZ,
        PRIMARY KEY (tenant_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS ${this.table('session_routes')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN (
            'queued', 'provisioning', 'running', 'waiting_approval',
            'suspended', 'completed', 'failed'
          )
        ),
        priority INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
        worker_id TEXT,
        lease_id TEXT,
        lease_expires_at TIMESTAMPTZ,
        queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        failure JSONB,
        PRIMARY KEY (tenant_id, session_id)
      );

      CREATE INDEX IF NOT EXISTS ${this.prefix}_session_routes_queue_idx
        ON ${this.table('session_routes')} (
          state, priority DESC, queued_at ASC, tenant_id, session_id
        );

      CREATE INDEX IF NOT EXISTS ${this.prefix}_session_routes_worker_idx
        ON ${this.table('session_routes')} (worker_id, state, lease_expires_at);

      ALTER TABLE ${this.table('outbox')}
        ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'idempotent',
        ADD COLUMN IF NOT EXISTS worker_id TEXT,
        ADD COLUMN IF NOT EXISTS lease_id TEXT,
        ADD COLUMN IF NOT EXISTS fencing_token BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS ${this.prefix}_outbox_claim_idx
        ON ${this.table('outbox')} (
          status, available_at, tenant_id, created_at, effect_id
        );
    `);
    if (previousSchemaVersion === 1) {
      await client.query(`
        ALTER TABLE ${this.table('outbox')}
          DROP CONSTRAINT IF EXISTS ${this.prefix}_outbox_status_check;

        ALTER TABLE ${this.table('outbox')}
          ADD CONSTRAINT ${this.prefix}_outbox_status_check CHECK (
            status IN (
              'pending', 'claimed', 'executing',
              'completed', 'failed', 'uncertain'
            )
          );

        ALTER TABLE ${this.table('outbox')}
          DROP CONSTRAINT IF EXISTS ${this.prefix}_outbox_execution_mode_check;

        ALTER TABLE ${this.table('outbox')}
          ADD CONSTRAINT ${this.prefix}_outbox_execution_mode_check CHECK (
            execution_mode IN ('idempotent', 'at_most_once')
          );
      `);
    }
  }

  async registerWorker(
    registration: RuntimeWorkerRegistration,
  ): Promise<RuntimeWorkerRecord> {
    this.assertWorkerId(registration.workerId);
    assertCapacity(registration.capacity);
    assertTtl(registration.ttlMs);
    assertJsonObject(registration.metadata ?? {}, 'Worker metadata');
    await this.ensureInitialized();
    await this.queryClient().query(
      `INSERT INTO ${this.table('workers')} (
         worker_id, status, capacity, metadata, registered_at,
         last_heartbeat_at, lease_expires_at, draining_at
       ) VALUES (
         $1, 'active', $2, $3::jsonb, NOW(), NOW(),
         NOW() + ($4 * INTERVAL '1 millisecond'), NULL
       )
       ON CONFLICT (worker_id) DO UPDATE SET
         status = 'active',
         capacity = EXCLUDED.capacity,
         metadata = EXCLUDED.metadata,
         last_heartbeat_at = NOW(),
         lease_expires_at = EXCLUDED.lease_expires_at,
         draining_at = NULL`,
      [
        registration.workerId,
        registration.capacity,
        JSON.stringify(registration.metadata ?? {}),
        registration.ttlMs,
      ],
    );
    return this.requireWorker(registration.workerId);
  }

  async heartbeatWorker(
    workerId: WorkerId,
    ttlMs: number,
  ): Promise<RuntimeWorkerRecord> {
    this.assertWorkerId(workerId);
    assertTtl(ttlMs);
    await this.ensureInitialized();
    const result = await this.queryClient().query(
      `UPDATE ${this.table('workers')}
          SET last_heartbeat_at = NOW(),
              lease_expires_at = NOW() + ($2 * INTERVAL '1 millisecond')
        WHERE worker_id = $1 AND status IN ('active', 'draining')
        RETURNING worker_id`,
      [workerId, ttlMs],
    );
    if (result.rowCount !== 1) {
      throw new WorkerRuntimeError(
        'WORKER_UNAVAILABLE',
        `Worker ${workerId} is not registered or is offline`,
      );
    }
    return this.requireWorker(workerId);
  }

  async drainWorker(workerId: WorkerId): Promise<RuntimeWorkerRecord> {
    this.assertWorkerId(workerId);
    await this.ensureInitialized();
    const result = await this.queryClient().query(
      `UPDATE ${this.table('workers')}
          SET status = 'draining',
              draining_at = COALESCE(draining_at, NOW())
        WHERE worker_id = $1 AND status <> 'offline'
        RETURNING worker_id`,
      [workerId],
    );
    if (result.rowCount !== 1) {
      throw new WorkerRuntimeError(
        'WORKER_NOT_FOUND',
        `Worker ${workerId} was not found`,
      );
    }
    return this.requireWorker(workerId);
  }

  async getWorker(workerId: WorkerId): Promise<RuntimeWorkerRecord | null> {
    this.assertWorkerId(workerId);
    await this.ensureInitialized();
    const result = await this.queryClient().query<WorkerRow>(
      `SELECT worker_id, status, capacity, metadata, registered_at,
              last_heartbeat_at, lease_expires_at, draining_at,
              (
                SELECT COUNT(*)::int
                  FROM ${this.table('session_routes')} routes
                 WHERE routes.worker_id = workers.worker_id
                   AND routes.state = ANY($2::text[])
                   AND routes.lease_expires_at > NOW()
              ) AS active_sessions
         FROM ${this.table('workers')} workers
        WHERE worker_id = $1`,
      [workerId, ACTIVE_SESSION_STATES],
    );
    const row = result.rows[0];
    return row ? this.workerRecord(row) : null;
  }

  async enqueueSession(
    tenantId: string,
    sessionId: SessionId,
    options: {
      readonly priority?: number;
      readonly metadata?: JsonObject;
    } = {},
  ): Promise<RuntimeSessionRoute> {
    this.assertTenantSession(tenantId, sessionId);
    const priority = options.priority ?? 0;
    assertPriority(priority);
    assertJsonObject(options.metadata ?? {}, 'Session route metadata');
    await this.ensureInitialized();
    return this.transaction(async (client) => {
      await this.lock(client, `execution:${tenantId}:${sessionId}`);
      const executionLease = await this.loadExecutionLease(
        client,
        tenantId,
        sessionId,
        true,
      );
      if (executionLease?.active) {
        throw new WorkerRuntimeError(
          'SESSION_STATE_CONFLICT',
          `Session ${sessionId} has an active execution lease`,
        );
      }
      const current = await this.loadRoute(client, tenantId, sessionId, true);
      if (
        current
        && current.state !== 'queued'
        && current.state !== 'suspended'
      ) {
        throw new WorkerRuntimeError(
          'SESSION_STATE_CONFLICT',
          `Session ${sessionId} cannot be queued from ${current.state}`,
        );
      }
      if (current?.lease_id) {
        await this.releaseExecutionLeaseRow(
          client,
          tenantId,
          sessionId,
          current.lease_id as ExecutionLeaseId,
          FencingToken(asNumber(current.fencing_token)),
        );
      }
      const result = await client.query<SessionRouteRow>(
        `INSERT INTO ${this.table('session_routes')} (
           tenant_id, session_id, state, priority, queued_at, updated_at,
           metadata, failure
         ) VALUES ($1, $2, 'queued', $3, NOW(), NOW(), $4::jsonb, NULL)
         ON CONFLICT (tenant_id, session_id) DO UPDATE SET
           state = 'queued',
           priority = EXCLUDED.priority,
           worker_id = NULL,
           lease_id = NULL,
           lease_expires_at = NULL,
           queued_at = NOW(),
           updated_at = NOW(),
           metadata = EXCLUDED.metadata,
           failure = NULL
         RETURNING *`,
        [tenantId, sessionId, priority, JSON.stringify(options.metadata ?? {})],
      );
      return this.routeRecord(result.rows[0]);
    });
  }

  async claimSession(
    options: RuntimeSessionClaimOptions,
  ): Promise<RuntimeSessionClaim | null> {
    this.assertWorkerId(options.ownerId);
    if (!options.leaseId.trim()) {
      throw new WorkerRuntimeError('WORKER_INVALID', 'Session leaseId must not be empty');
    }
    assertTtl(options.ttlMs);
    if (options.tenantId !== undefined && !options.tenantId.trim()) {
      throw new WorkerRuntimeError('WORKER_INVALID', 'tenantId must not be empty');
    }
    options.signal?.throwIfAborted();
    await this.ensureInitialized();
    await this.recoverExpiredWork();
    const claim = await this.transaction(async (client) => {
      options.signal?.throwIfAborted();
      const worker = await this.lockAvailableWorker(client, options.ownerId);
      const active = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM ${this.table('session_routes')}
          WHERE worker_id = $1
            AND state = ANY($2::text[])
            AND lease_expires_at > NOW()`,
        [options.ownerId, ACTIVE_SESSION_STATES],
      );
      if (Number(active.rows[0]?.count ?? 0) >= worker.capacity) {
        return null;
      }
      const candidates = await client.query<SessionRouteRow>(
        `SELECT *
           FROM ${this.table('session_routes')}
          WHERE state IN ('queued', 'suspended')
            AND worker_id IS NULL
            AND ($1::text IS NULL OR tenant_id = $1)
          ORDER BY priority DESC, queued_at ASC, tenant_id ASC, session_id ASC
          LIMIT 16`,
        [options.tenantId ?? null],
      );
      for (const candidate of candidates.rows) {
        const sessionId = candidate.session_id as SessionId;
        await this.lock(
          client,
          `execution:${candidate.tenant_id}:${sessionId}`,
        );
        const row = await this.loadRoute(
          client,
          candidate.tenant_id,
          sessionId,
          true,
        );
        if (
          !row
          || (row.state !== 'queued' && row.state !== 'suspended')
          || row.worker_id !== null
        ) {
          continue;
        }
        const currentLease = await this.loadExecutionLease(
          client,
          row.tenant_id,
          sessionId,
          true,
        );
        if (currentLease?.active) {
          continue;
        }
        const nextToken = this.nextFencingToken(
          sessionId,
          Math.max(
            asNumber(row.fencing_token),
            currentLease ? asNumber(currentLease.fencing_token) : 0,
          ),
        );
        const updated = await client.query<SessionRouteRow>(
          `UPDATE ${this.table('session_routes')}
              SET state = 'provisioning',
                  attempt = attempt + 1,
                  fencing_token = $3,
                  worker_id = $4,
                  lease_id = $5,
                  lease_expires_at = NOW() + ($6 * INTERVAL '1 millisecond'),
                  updated_at = NOW(),
                  failure = NULL
            WHERE tenant_id = $1 AND session_id = $2
              AND state IN ('queued', 'suspended')
              AND worker_id IS NULL
            RETURNING *`,
          [
            row.tenant_id,
            row.session_id,
            nextToken,
            options.ownerId,
            options.leaseId,
            options.ttlMs,
          ],
        );
        if (!updated.rows[0]) {
          continue;
        }
        const route = this.routeRecord(updated.rows[0]);
        const lease = await this.upsertExecutionLease(
          client,
          route.tenantId,
          route.sessionId,
          options,
          route.fencingToken,
        );
        return { route, lease };
      }
      return null;
    });
    options.signal?.throwIfAborted();
    return claim;
  }

  async renewSessionLease(
    tenantId: string,
    lease: DurableExecutionLease,
    ttlMs: number,
  ): Promise<RuntimeSessionClaim> {
    const renewed = await this.renewExecutionLease(tenantId, lease, ttlMs);
    const route = await this.getSessionRoute(tenantId, lease.sessionId);
    if (!route) {
      throw new WorkerRuntimeError(
        'SESSION_ROUTE_NOT_FOUND',
        `Session route ${tenantId}/${lease.sessionId} was not found`,
      );
    }
    return { route, lease: renewed };
  }

  async transitionSession(
    tenantId: string,
    lease: DurableExecutionLease,
    transition: {
      readonly expectedState: RuntimeSessionState;
      readonly state: RuntimeSessionState;
      readonly metadata?: JsonObject;
      readonly failure?: JsonObject;
    },
  ): Promise<RuntimeSessionRoute> {
    this.assertTenantSession(tenantId, lease.sessionId);
    if (transition.metadata) {
      assertJsonObject(transition.metadata, 'Session transition metadata');
    }
    if (transition.failure) {
      assertJsonObject(transition.failure, 'Session transition failure');
    }
    await this.ensureInitialized();
    return this.transaction(async (client) => {
      await this.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      await this.assertExecutionLeaseWithClient(client, tenantId, lease, true);
      const current = await this.loadRoute(client, tenantId, lease.sessionId, true);
      if (!current) {
        throw new WorkerRuntimeError(
          'SESSION_ROUTE_NOT_FOUND',
          `Session route ${tenantId}/${lease.sessionId} was not found`,
        );
      }
      if (current.state !== transition.expectedState) {
        throw new WorkerRuntimeError(
          'SESSION_STATE_CONFLICT',
          `Expected Session ${lease.sessionId} in ${transition.expectedState}, `
            + `but found ${current.state}`,
        );
      }
      assertRuntimeSessionTransition(current.state, transition.state);
      const terminal =
        transition.state === 'completed'
        || transition.state === 'failed'
        || transition.state === 'suspended';
      const updated = await client.query<SessionRouteRow>(
        `UPDATE ${this.table('session_routes')}
            SET state = $5,
                worker_id = CASE WHEN $6 THEN NULL ELSE worker_id END,
                lease_id = CASE WHEN $6 THEN NULL ELSE lease_id END,
                lease_expires_at = CASE WHEN $6 THEN NULL ELSE lease_expires_at END,
                metadata = COALESCE($7::jsonb, metadata),
                failure = $8::jsonb,
                updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2
            AND lease_id = $3 AND fencing_token = $4
          RETURNING *`,
        [
          tenantId,
          lease.sessionId,
          lease.leaseId,
          lease.fencingToken,
          transition.state,
          terminal,
          transition.metadata ? JSON.stringify(transition.metadata) : null,
          transition.failure ? JSON.stringify(transition.failure) : null,
        ],
      );
      const row = updated.rows[0];
      if (!row) {
        throw this.leaseLost(lease);
      }
      if (terminal) {
        await this.releaseExecutionLeaseRow(
          client,
          tenantId,
          lease.sessionId,
          lease.leaseId,
          lease.fencingToken,
        );
      }
      return this.routeRecord(row);
    });
  }

  async handoffSession(
    tenantId: string,
    lease: DurableExecutionLease,
    metadata?: JsonObject,
  ): Promise<RuntimeSessionRoute> {
    this.assertTenantSession(tenantId, lease.sessionId);
    if (metadata) {
      assertJsonObject(metadata, 'Session handoff metadata');
    }
    await this.ensureInitialized();
    return this.transaction(async (client) => {
      await this.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      const persistedLease = await this.loadExecutionLease(
        client,
        tenantId,
        lease.sessionId,
        true,
      );
      const current = await this.loadRoute(client, tenantId, lease.sessionId, true);
      if (!current) {
        throw new WorkerRuntimeError(
          'SESSION_ROUTE_NOT_FOUND',
          `Session route ${tenantId}/${lease.sessionId} was not found`,
        );
      }
      if (
        persistedLease?.released_at
        && persistedLease.lease_id === lease.leaseId
        && asNumber(persistedLease.fencing_token) === lease.fencingToken
        && current.state === 'suspended'
      ) {
        if (!metadata) {
          return this.routeRecord(current);
        }
        const replayed = await client.query<SessionRouteRow>(
          `UPDATE ${this.table('session_routes')}
              SET metadata = $3::jsonb, updated_at = NOW()
            WHERE tenant_id = $1 AND session_id = $2
            RETURNING *`,
          [tenantId, lease.sessionId, JSON.stringify(metadata)],
        );
        return this.routeRecord(replayed.rows[0]);
      }
      await this.assertExecutionLeaseWithClient(client, tenantId, lease, true);
      if (!ACTIVE_SESSION_STATES.includes(current.state)) {
        throw new WorkerRuntimeError(
          'SESSION_STATE_CONFLICT',
          `Session ${lease.sessionId} cannot hand off from ${current.state}`,
        );
      }
      const updated = await client.query<SessionRouteRow>(
        `UPDATE ${this.table('session_routes')}
            SET state = 'suspended',
                worker_id = NULL,
                lease_id = NULL,
                lease_expires_at = NULL,
                metadata = COALESCE($5::jsonb, metadata),
                updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2
            AND lease_id = $3 AND fencing_token = $4
          RETURNING *`,
        [
          tenantId,
          lease.sessionId,
          lease.leaseId,
          lease.fencingToken,
          metadata ? JSON.stringify(metadata) : null,
        ],
      );
      if (!updated.rows[0]) {
        throw this.leaseLost(lease);
      }
      await this.releaseExecutionLeaseRow(
        client,
        tenantId,
        lease.sessionId,
        lease.leaseId,
        lease.fencingToken,
      );
      return this.routeRecord(updated.rows[0]);
    });
  }

  async preemptSession(
    tenantId: string,
    sessionId: SessionId,
    options: {
      readonly reason?: JsonObject;
      readonly requeue?: boolean;
    } = {},
  ): Promise<RuntimeSessionRoute> {
    this.assertTenantSession(tenantId, sessionId);
    if (options.reason) {
      assertJsonObject(options.reason, 'Session preemption reason');
    }
    await this.ensureInitialized();
    return this.transaction(async (client) => {
      await this.lock(client, `execution:${tenantId}:${sessionId}`);
      const current = await this.loadRoute(client, tenantId, sessionId, true);
      if (!current) {
        throw new WorkerRuntimeError(
          'SESSION_ROUTE_NOT_FOUND',
          `Session route ${tenantId}/${sessionId} was not found`,
        );
      }
      if (current.state === 'completed' || current.state === 'failed') {
        throw new WorkerRuntimeError(
          'SESSION_STATE_CONFLICT',
          `Terminal Session ${sessionId} cannot be preempted`,
        );
      }
      if (current.lease_id) {
        await this.releaseExecutionLeaseRow(
          client,
          tenantId,
          sessionId,
          current.lease_id as ExecutionLeaseId,
          FencingToken(asNumber(current.fencing_token)),
        );
      }
      const updated = await client.query<SessionRouteRow>(
        `UPDATE ${this.table('session_routes')}
            SET state = $3,
                worker_id = NULL,
                lease_id = NULL,
                lease_expires_at = NULL,
                queued_at = CASE WHEN $3 = 'queued' THEN NOW() ELSE queued_at END,
                failure = $4::jsonb,
                updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2
          RETURNING *`,
        [
          tenantId,
          sessionId,
          options.requeue ? 'queued' : 'suspended',
          options.reason ? JSON.stringify(options.reason) : null,
        ],
      );
      return this.routeRecord(updated.rows[0]);
    });
  }

  async getSessionRoute(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<RuntimeSessionRoute | null> {
    this.assertTenantSession(tenantId, sessionId);
    await this.ensureInitialized();
    const result = await this.queryClient().query<SessionRouteRow>(
      `SELECT *
         FROM ${this.table('session_routes')}
        WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    );
    return result.rows[0] ? this.routeRecord(result.rows[0]) : null;
  }

  async listWorkerSessions(
    workerId: WorkerId,
  ): Promise<readonly RuntimeSessionRoute[]> {
    this.assertWorkerId(workerId);
    await this.ensureInitialized();
    const result = await this.queryClient().query<SessionRouteRow>(
      `SELECT *
         FROM ${this.table('session_routes')}
        WHERE worker_id = $1
        ORDER BY updated_at ASC, tenant_id ASC, session_id ASC`,
      [workerId],
    );
    return result.rows.map((row) => this.routeRecord(row));
  }

  async recoverExpiredWork(): Promise<RuntimeRecoveryResult> {
    await this.ensureInitialized();
    return this.transaction(async (client) => {
      const offlineWorkers = await client.query(
        `UPDATE ${this.table('workers')}
            SET status = 'offline'
          WHERE status <> 'offline' AND lease_expires_at <= NOW()`,
      );
      await client.query(
        `UPDATE ${this.table('execution_leases')} leases
            SET released_at = COALESCE(released_at, NOW())
          WHERE released_at IS NULL
            AND (
              expires_at <= NOW()
              OR EXISTS (
                SELECT 1
                  FROM ${this.table('workers')} workers
                 WHERE workers.worker_id = leases.owner_id
                   AND workers.status = 'offline'
              )
            )`,
      );
      const suspendedSessions = await client.query(
        `UPDATE ${this.table('session_routes')} routes
            SET state = 'suspended',
                worker_id = NULL,
                lease_id = NULL,
                lease_expires_at = NULL,
                updated_at = NOW(),
                failure = COALESCE(
                  failure,
                  '{"reason":"worker_lease_expired"}'::jsonb
                )
          WHERE state = ANY($1::text[])
            AND (
              lease_expires_at <= NOW()
              OR EXISTS (
                SELECT 1
                  FROM ${this.table('workers')} workers
                 WHERE workers.worker_id = routes.worker_id
                   AND workers.status = 'offline'
              )
            )`,
        [ACTIVE_SESSION_STATES],
      );
      const uncertainEffects = await client.query(
        `UPDATE ${this.table('outbox')} effects
            SET status = 'uncertain',
                completed_at = NOW(),
                error = COALESCE(
                  error,
                  '{"reason":"worker_lease_expired_after_start"}'::jsonb
                )
          WHERE status = 'executing'
            AND execution_mode = 'at_most_once'
            AND (
              lease_expires_at <= NOW()
              OR EXISTS (
                SELECT 1
                  FROM ${this.table('workers')} workers
                 WHERE workers.worker_id = effects.worker_id
                   AND workers.status = 'offline'
              )
            )`,
      );
      const requeuedEffects = await client.query(
        `UPDATE ${this.table('outbox')} effects
            SET status = 'pending',
                worker_id = NULL,
                lease_id = NULL,
                lease_expires_at = NULL,
                available_at = NOW()
          WHERE (
            status = 'claimed'
            OR (status = 'executing' AND execution_mode = 'idempotent')
          )
            AND (
              lease_expires_at <= NOW()
              OR EXISTS (
                SELECT 1
                  FROM ${this.table('workers')} workers
                 WHERE workers.worker_id = effects.worker_id
                   AND workers.status = 'offline'
              )
            )`,
      );
      return {
        offlineWorkers: offlineWorkers.rowCount ?? 0,
        suspendedSessions: suspendedSessions.rowCount ?? 0,
        requeuedEffects: requeuedEffects.rowCount ?? 0,
        uncertainEffects: uncertainEffects.rowCount ?? 0,
      };
    });
  }

  async claimEffects(
    options: RuntimeEffectClaimOptions,
  ): Promise<readonly RuntimeEffectClaim[]> {
    this.assertWorkerId(options.workerId);
    assertTtl(options.ttlMs);
    const limit = options.limit ?? 10;
    assertLimit(limit);
    if (options.leaseId !== undefined && !options.leaseId.trim()) {
      throw new WorkerRuntimeError(
        'WORKER_INVALID',
        'Effect leaseId must not be empty',
      );
    }
    if (options.tenantId !== undefined && !options.tenantId.trim()) {
      throw new WorkerRuntimeError('WORKER_INVALID', 'tenantId must not be empty');
    }
    await this.ensureInitialized();
    await this.recoverExpiredWork();
    return this.transaction(async (client) => {
      await this.lockAvailableWorker(client, options.workerId);
      const leaseId = options.leaseId ?? ExecutionLeaseId(nanoid());
      const result = await client.query<EffectRow>(
        `WITH candidates AS (
           SELECT tenant_id, effect_id
             FROM ${this.table('outbox')}
            WHERE status = 'pending'
              AND available_at <= NOW()
              AND ($1::text IS NULL OR tenant_id = $1)
            ORDER BY available_at ASC, created_at ASC, tenant_id ASC, effect_id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE ${this.table('outbox')} effects
            SET status = 'claimed',
                worker_id = $3,
                lease_id = $4,
                fencing_token = effects.fencing_token + 1,
                lease_expires_at = NOW() + ($5 * INTERVAL '1 millisecond')
           FROM candidates
          WHERE effects.tenant_id = candidates.tenant_id
            AND effects.effect_id = candidates.effect_id
         RETURNING effects.*`,
        [
          options.tenantId ?? null,
          limit,
          options.workerId,
          leaseId,
          options.ttlMs,
        ],
      );
      return result.rows.map((row) => this.effectClaim(row));
    });
  }

  async renewEffectLease(
    lease: RuntimeEffectLease,
    ttlMs: number,
  ): Promise<RuntimeEffectRecord> {
    assertTtl(ttlMs);
    await this.ensureInitialized();
    const result = await this.queryClient().query<EffectRow>(
      `UPDATE ${this.table('outbox')} effects
          SET lease_expires_at = NOW() + ($6 * INTERVAL '1 millisecond')
         FROM ${this.table('workers')} workers
        WHERE effects.tenant_id = $1
          AND effects.effect_id = $2
          AND effects.worker_id = $3
          AND effects.lease_id = $4
          AND effects.fencing_token = $5
          AND effects.status IN ('claimed', 'executing')
          AND effects.lease_expires_at > NOW()
          AND workers.worker_id = effects.worker_id
          AND workers.status IN ('active', 'draining')
          AND workers.lease_expires_at > NOW()
        RETURNING effects.*`,
      [
        lease.tenantId,
        lease.effectId,
        lease.workerId,
        lease.leaseId,
        lease.fencingToken,
        ttlMs,
      ],
    );
    return this.requireEffectMutation(result.rows[0], lease);
  }

  async startEffect(lease: RuntimeEffectLease): Promise<RuntimeEffectRecord> {
    await this.ensureInitialized();
    const result = await this.queryClient().query<EffectRow>(
      `UPDATE ${this.table('outbox')} effects
          SET status = 'executing',
              attempts = attempts + 1,
              started_at = COALESCE(started_at, NOW())
         FROM ${this.table('workers')} workers
        WHERE effects.tenant_id = $1
          AND effects.effect_id = $2
          AND effects.worker_id = $3
          AND effects.lease_id = $4
          AND effects.fencing_token = $5
          AND effects.status = 'claimed'
          AND effects.lease_expires_at > NOW()
          AND workers.worker_id = effects.worker_id
          AND workers.status IN ('active', 'draining')
          AND workers.lease_expires_at > NOW()
        RETURNING effects.*`,
      [
        lease.tenantId,
        lease.effectId,
        lease.workerId,
        lease.leaseId,
        lease.fencingToken,
      ],
    );
    return this.requireEffectMutation(result.rows[0], lease);
  }

  async completeEffect(
    lease: RuntimeEffectLease,
    result?: JsonObject,
  ): Promise<RuntimeEffectRecord> {
    assertJsonObject(result ?? {}, 'Effect result');
    await this.ensureInitialized();
    const updated = await this.queryClient().query<EffectRow>(
      `UPDATE ${this.table('outbox')}
          SET status = 'completed',
              result = $6::jsonb,
              error = NULL,
              completed_at = NOW()
        WHERE tenant_id = $1
          AND effect_id = $2
          AND worker_id = $3
          AND lease_id = $4
          AND fencing_token = $5
          AND status = 'executing'
        RETURNING *`,
      [
        lease.tenantId,
        lease.effectId,
        lease.workerId,
        lease.leaseId,
        lease.fencingToken,
        JSON.stringify(result ?? {}),
      ],
    );
    return this.requireEffectMutation(updated.rows[0], lease);
  }

  async failEffect(
    lease: RuntimeEffectLease,
    error: JsonObject,
    options: RuntimeEffectFailureOptions = {},
  ): Promise<RuntimeEffectRecord> {
    assertJsonObject(error, 'Effect error');
    if (
      options.retryAt
      && !Number.isFinite(Date.parse(options.retryAt))
    ) {
      throw new WorkerRuntimeError(
        'WORKER_INVALID',
        'Effect retryAt must be an ISO timestamp',
      );
    }
    await this.ensureInitialized();
    return this.transaction(async (client) => {
      const current = await client.query<EffectRow>(
        `SELECT *
           FROM ${this.table('outbox')}
          WHERE tenant_id = $1 AND effect_id = $2
          FOR UPDATE`,
        [lease.tenantId, lease.effectId],
      );
      const row = current.rows[0];
      this.assertEffectLease(row, lease, 'executing');
      if (options.retryAt && row.execution_mode !== 'idempotent') {
        throw new WorkerRuntimeError(
          'EFFECT_RETRY_NOT_ALLOWED',
          `At-most-once effect ${lease.effectId} cannot be retried`,
        );
      }
      const retry = options.retryAt !== undefined;
      const updated = await client.query<EffectRow>(
        `UPDATE ${this.table('outbox')}
            SET status = $6,
                error = $7::jsonb,
                available_at = CASE WHEN $6 = 'pending' THEN $8 ELSE available_at END,
                worker_id = CASE WHEN $6 = 'pending' THEN NULL ELSE worker_id END,
                lease_id = CASE WHEN $6 = 'pending' THEN NULL ELSE lease_id END,
                lease_expires_at = CASE WHEN $6 = 'pending' THEN NULL ELSE lease_expires_at END,
                completed_at = CASE WHEN $6 = 'failed' THEN NOW() ELSE NULL END
          WHERE tenant_id = $1
            AND effect_id = $2
            AND worker_id = $3
            AND lease_id = $4
            AND fencing_token = $5
          RETURNING *`,
        [
          lease.tenantId,
          lease.effectId,
          lease.workerId,
          lease.leaseId,
          lease.fencingToken,
          retry ? 'pending' : 'failed',
          JSON.stringify(error),
          options.retryAt ?? null,
        ],
      );
      return this.requireEffectMutation(updated.rows[0], lease);
    });
  }

  async reconcileEffect(
    tenantId: string,
    effectId: string,
    outcome: RuntimeEffectReconciliation,
  ): Promise<RuntimeEffectRecord> {
    if (!tenantId.trim() || !effectId.trim()) {
      throw new WorkerRuntimeError(
        'WORKER_INVALID',
        'tenantId and effectId must not be empty',
      );
    }
    if (outcome.status === 'completed') {
      assertJsonObject(outcome.result ?? {}, 'Effect reconciliation result');
    } else {
      assertJsonObject(outcome.error, 'Effect reconciliation error');
    }
    await this.ensureInitialized();
    const result = await this.queryClient().query<EffectRow>(
      `UPDATE ${this.table('outbox')}
          SET status = $3,
              result = $4::jsonb,
              error = $5::jsonb,
              completed_at = NOW()
        WHERE tenant_id = $1 AND effect_id = $2
          AND status = 'uncertain'
        RETURNING *`,
      [
        tenantId,
        effectId,
        outcome.status,
        outcome.status === 'completed'
          ? JSON.stringify(outcome.result ?? {})
          : null,
        outcome.status === 'failed'
          ? JSON.stringify(outcome.error)
          : null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new WorkerRuntimeError(
        'EFFECT_NOT_FOUND',
        `Uncertain effect ${tenantId}/${effectId} was not found`,
      );
    }
    return this.effectRecord(row);
  }

  async requiresExecutionLease(
    tenantId: string,
    sessionId: SessionId,
    options: DurableEventOperationOptions = {},
  ): Promise<boolean> {
    this.assertTenantSession(tenantId, sessionId);
    options.signal?.throwIfAborted();
    await this.ensureInitialized();
    const result = await this.queryClient().query(
      `SELECT 1
         FROM ${this.table('execution_leases')}
        WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    );
    options.signal?.throwIfAborted();
    return result.rowCount === 1;
  }

  async acquireExecutionLease(
    tenantId: string,
    sessionId: SessionId,
    options: DurableExecutionLeaseAcquireOptions,
  ): Promise<DurableExecutionLease> {
    this.assertTenantSession(tenantId, sessionId);
    this.assertLeaseIdentity(sessionId, options);
    assertTtl(options.ttlMs);
    options.signal?.throwIfAborted();
    await this.ensureInitialized();
    return this.transaction(async (client) => {
      await this.lock(client, `execution:${tenantId}:${sessionId}`);
      const current = await this.loadExecutionLease(client, tenantId, sessionId, true);
      if (
        current?.active
        && (
          current.lease_id !== options.leaseId
          || current.owner_id !== options.ownerId
        )
      ) {
        throw new DurableExecutionLeaseError(
          'DURABLE_EXECUTION_LEASE_CONFLICT',
          `Session ${sessionId} is leased by worker ${current.owner_id}`,
          {
            sessionId,
            leaseId: options.leaseId,
            fencingToken: FencingToken(asNumber(current.fencing_token)),
            activeLease: this.executionLease(current),
          },
        );
      }
      const reusesActiveLease =
        current?.active === true
        && current.lease_id === options.leaseId
        && current.owner_id === options.ownerId;
      const fencingToken = reusesActiveLease && current
        ? FencingToken(asNumber(current.fencing_token))
        : this.nextFencingToken(
            sessionId,
            current ? asNumber(current.fencing_token) : 0,
          );
      return this.upsertExecutionLease(
        client,
        tenantId,
        sessionId,
        options,
        fencingToken,
        reusesActiveLease && current ? asIso(current.acquired_at) : undefined,
      );
    });
  }

  async renewExecutionLease(
    tenantId: string,
    lease: DurableExecutionLease,
    ttlMs: number,
    options: DurableEventOperationOptions = {},
  ): Promise<DurableExecutionLease> {
    this.assertTenantSession(tenantId, lease.sessionId);
    this.assertLeaseIdentity(lease.sessionId, lease);
    assertTtl(ttlMs);
    options.signal?.throwIfAborted();
    await this.ensureInitialized();
    return this.transaction(async (client) => {
      await this.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      await this.assertExecutionLeaseWithClient(client, tenantId, lease, true);
      const result = await client.query<ExecutionLeaseRow>(
        `UPDATE ${this.table('execution_leases')}
            SET renewed_at = NOW(),
                expires_at = NOW() + ($5 * INTERVAL '1 millisecond')
          WHERE tenant_id = $1 AND session_id = $2
            AND lease_id = $3 AND fencing_token = $4
          RETURNING *`,
        [
          tenantId,
          lease.sessionId,
          lease.leaseId,
          lease.fencingToken,
          ttlMs,
        ],
      );
      const renewed = result.rows[0];
      if (!renewed) {
        throw this.leaseLost(lease);
      }
      await client.query(
        `UPDATE ${this.table('session_routes')}
            SET lease_expires_at = $5, updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2
            AND lease_id = $3 AND fencing_token = $4`,
        [
          tenantId,
          lease.sessionId,
          lease.leaseId,
          lease.fencingToken,
          renewed.expires_at,
        ],
      );
      options.signal?.throwIfAborted();
      return this.executionLease(renewed);
    });
  }

  async assertExecutionLease(
    tenantId: string,
    lease: DurableExecutionLease,
    options: DurableEventOperationOptions = {},
  ): Promise<void> {
    this.assertTenantSession(tenantId, lease.sessionId);
    options.signal?.throwIfAborted();
    await this.ensureInitialized();
    await this.transaction(async (client) => {
      await this.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      await this.assertExecutionLeaseWithClient(client, tenantId, lease, true);
    });
    options.signal?.throwIfAborted();
  }

  async assertExecutionFenceWithClient(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    fence: DurableExecutionFence | undefined,
  ): Promise<void> {
    await this.lock(client, `execution:${tenantId}:${sessionId}`);
    const current = await this.loadExecutionLease(
      client,
      tenantId,
      sessionId,
      true,
    );
    if (!current) {
      if (fence) {
        throw this.leaseLost({ ...fence, sessionId });
      }
      return;
    }
    if (!fence) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_REQUIRED',
        `Session ${sessionId} requires an execution lease`,
        {
          sessionId,
          ...(current.active
            ? { activeLease: this.executionLease(current) }
            : {}),
        },
      );
    }
    await this.assertExecutionLeaseWithClient(
      client,
      tenantId,
      { ...fence, sessionId },
      true,
    );
  }

  async withExecutionLease<T>(
    tenantId: string,
    lease: DurableExecutionLease,
    operation: () => Promise<T>,
    options: DurableEventOperationOptions = {},
  ): Promise<T> {
    this.assertTenantSession(tenantId, lease.sessionId);
    options.signal?.throwIfAborted();
    await this.ensureInitialized();
    return this.transaction(async (client) => {
      await this.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      await this.assertExecutionLeaseWithClient(client, tenantId, lease, true);
      options.signal?.throwIfAborted();
      const result = await operation();
      options.signal?.throwIfAborted();
      return result;
    });
  }

  async releaseExecutionLease(
    tenantId: string,
    lease: DurableExecutionLease,
    options: DurableEventOperationOptions = {},
  ): Promise<void> {
    this.assertTenantSession(tenantId, lease.sessionId);
    options.signal?.throwIfAborted();
    await this.ensureInitialized();
    await this.transaction(async (client) => {
      await this.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      const current = await this.loadExecutionLease(
        client,
        tenantId,
        lease.sessionId,
        true,
      );
      if (
        current?.released_at
        && current.lease_id === lease.leaseId
        && asNumber(current.fencing_token) === lease.fencingToken
      ) {
        return;
      }
      await this.assertExecutionLeaseWithClient(client, tenantId, lease, false);
      await this.releaseExecutionLeaseRow(
        client,
        tenantId,
        lease.sessionId,
        lease.leaseId,
        lease.fencingToken,
      );
      await client.query(
        `UPDATE ${this.table('session_routes')}
            SET state = CASE
                  WHEN state = ANY($5::text[]) THEN 'suspended'
                  ELSE state
                END,
                worker_id = NULL,
                lease_id = NULL,
                lease_expires_at = NULL,
                updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2
            AND lease_id = $3 AND fencing_token = $4`,
        [
          tenantId,
          lease.sessionId,
          lease.leaseId,
          lease.fencingToken,
          ACTIVE_SESSION_STATES,
        ],
      );
    });
    options.signal?.throwIfAborted();
  }

  private async requireWorker(workerId: WorkerId): Promise<RuntimeWorkerRecord> {
    const worker = await this.getWorker(workerId);
    if (!worker) {
      throw new WorkerRuntimeError(
        'WORKER_NOT_FOUND',
        `Worker ${workerId} was not found`,
      );
    }
    return worker;
  }

  private async lockAvailableWorker(
    client: PoolClient,
    workerId: WorkerId,
  ): Promise<{ capacity: number }> {
    const result = await client.query<WorkerRow>(
      `SELECT *, 0::int AS active_sessions,
              lease_expires_at > NOW() AS heartbeat_active
         FROM ${this.table('workers')}
        WHERE worker_id = $1
        FOR UPDATE`,
      [workerId],
    );
    const worker = result.rows[0];
    if (!worker) {
      throw new WorkerRuntimeError(
        'WORKER_NOT_FOUND',
        `Worker ${workerId} was not found`,
      );
    }
    if (worker.status !== 'active' || !worker.heartbeat_active) {
      throw new WorkerRuntimeError(
        'WORKER_UNAVAILABLE',
        `Worker ${workerId} is draining or its heartbeat expired`,
      );
    }
    return { capacity: worker.capacity };
  }

  private async loadRoute(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    forUpdate: boolean,
  ): Promise<SessionRouteRow | null> {
    const result = await client.query<SessionRouteRow>(
      `SELECT *
         FROM ${this.table('session_routes')}
        WHERE tenant_id = $1 AND session_id = $2
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, sessionId],
    );
    return result.rows[0] ?? null;
  }

  private async loadExecutionLease(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    forUpdate: boolean,
  ): Promise<ExecutionLeaseRow | null> {
    const result = await client.query<ExecutionLeaseRow>(
      `SELECT *,
              released_at IS NULL AND expires_at > NOW() AS active
         FROM ${this.table('execution_leases')}
        WHERE tenant_id = $1 AND session_id = $2
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, sessionId],
    );
    return result.rows[0] ?? null;
  }

  private async upsertExecutionLease(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    options: DurableExecutionLeaseAcquireOptions,
    fencingToken: FencingToken,
    acquiredAt?: string,
  ): Promise<DurableExecutionLease> {
    const result = await client.query<ExecutionLeaseRow>(
      `INSERT INTO ${this.table('execution_leases')} (
         tenant_id, session_id, fencing_token, lease_id, owner_id,
         acquired_at, renewed_at, expires_at, released_at
       ) VALUES (
         $1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), NOW(),
         NOW() + ($7 * INTERVAL '1 millisecond'), NULL
       )
       ON CONFLICT (tenant_id, session_id) DO UPDATE SET
         fencing_token = EXCLUDED.fencing_token,
         lease_id = EXCLUDED.lease_id,
         owner_id = EXCLUDED.owner_id,
         acquired_at = EXCLUDED.acquired_at,
         renewed_at = EXCLUDED.renewed_at,
         expires_at = EXCLUDED.expires_at,
         released_at = NULL
       RETURNING *`,
      [
        tenantId,
        sessionId,
        fencingToken,
        options.leaseId,
        options.ownerId,
        acquiredAt ?? null,
        options.ttlMs,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new WorkerRuntimeError(
        'WORKER_INVALID',
        `Execution lease for Session ${sessionId} was not stored`,
      );
    }
    return this.executionLease(row);
  }

  private async assertExecutionLeaseWithClient(
    client: PoolClient,
    tenantId: string,
    lease: DurableExecutionFence & {
      readonly sessionId: SessionId;
      readonly ownerId?: WorkerId;
    },
    requireUnexpired: boolean,
  ): Promise<ExecutionLeaseRow> {
    const current = await this.loadExecutionLease(
      client,
      tenantId,
      lease.sessionId,
      true,
    );
    if (
      !current
      || current.released_at !== null
      || current.lease_id !== lease.leaseId
      || asNumber(current.fencing_token) !== lease.fencingToken
      || (lease.ownerId !== undefined && current.owner_id !== lease.ownerId)
      || (requireUnexpired && !current.active)
    ) {
      throw this.leaseLost(lease);
    }
    return current;
  }

  private async releaseExecutionLeaseRow(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    leaseId: ExecutionLeaseId,
    fencingToken: FencingToken,
  ): Promise<void> {
    await client.query(
      `UPDATE ${this.table('execution_leases')}
          SET released_at = COALESCE(released_at, NOW())
        WHERE tenant_id = $1 AND session_id = $2
          AND lease_id = $3 AND fencing_token = $4`,
      [tenantId, sessionId, leaseId, fencingToken],
    );
  }

  private assertEffectLease(
    row: EffectRow | undefined,
    lease: RuntimeEffectLease,
    status: RuntimeEffectStatus,
  ): asserts row is EffectRow {
    if (
      !row
      || row.worker_id !== lease.workerId
      || row.lease_id !== lease.leaseId
      || asNumber(row.fencing_token) !== lease.fencingToken
      || row.status !== status
    ) {
      throw new WorkerRuntimeError(
        row ? 'EFFECT_LEASE_LOST' : 'EFFECT_NOT_FOUND',
        `Effect lease ${lease.tenantId}/${lease.effectId} is not active`,
      );
    }
  }

  private requireEffectMutation(
    row: EffectRow | undefined,
    lease: RuntimeEffectLease,
  ): RuntimeEffectRecord {
    if (!row) {
      throw new WorkerRuntimeError(
        'EFFECT_LEASE_LOST',
        `Effect lease ${lease.tenantId}/${lease.effectId} is not active`,
      );
    }
    return this.effectRecord(row);
  }

  private workerRecord(row: WorkerRow): RuntimeWorkerRecord {
    return {
      workerId: row.worker_id as WorkerId,
      status: row.status,
      capacity: row.capacity,
      activeSessions: row.active_sessions,
      metadata: asJsonObject(row.metadata),
      registeredAt: asIso(row.registered_at),
      lastHeartbeatAt: asIso(row.last_heartbeat_at),
      leaseExpiresAt: asIso(row.lease_expires_at),
      ...(row.draining_at ? { drainingAt: asIso(row.draining_at) } : {}),
    };
  }

  private routeRecord(row: SessionRouteRow | undefined): RuntimeSessionRoute {
    if (!row) {
      throw new WorkerRuntimeError(
        'SESSION_ROUTE_NOT_FOUND',
        'Session route mutation did not return a record',
      );
    }
    return {
      tenantId: row.tenant_id,
      sessionId: row.session_id as SessionId,
      state: row.state,
      priority: row.priority,
      attempt: row.attempt,
      fencingToken: FencingToken(asNumber(row.fencing_token)),
      ...(row.worker_id ? { workerId: row.worker_id as WorkerId } : {}),
      ...(row.lease_id ? { leaseId: row.lease_id as ExecutionLeaseId } : {}),
      ...(row.lease_expires_at
        ? { leaseExpiresAt: asIso(row.lease_expires_at) }
        : {}),
      queuedAt: asIso(row.queued_at),
      updatedAt: asIso(row.updated_at),
      metadata: asJsonObject(row.metadata),
      ...(row.failure ? { failure: asJsonObject(row.failure) } : {}),
    };
  }

  private executionLease(row: ExecutionLeaseRow): DurableExecutionLease {
    return {
      sessionId: row.session_id as SessionId,
      leaseId: row.lease_id as ExecutionLeaseId,
      ownerId: row.owner_id as WorkerId,
      fencingToken: FencingToken(asNumber(row.fencing_token)),
      acquiredAt: asIso(row.acquired_at),
      renewedAt: asIso(row.renewed_at),
      expiresAt: asIso(row.expires_at),
    };
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
      executionMode: row.execution_mode,
      status: row.status,
      attempts: row.attempts,
      availableAt: asIso(row.available_at),
      createdAt: asIso(row.created_at),
      ...(row.worker_id ? { workerId: row.worker_id as WorkerId } : {}),
      ...(row.lease_id ? { leaseId: row.lease_id as ExecutionLeaseId } : {}),
      ...(asNumber(row.fencing_token) > 0
        ? { fencingToken: FencingToken(asNumber(row.fencing_token)) }
        : {}),
      ...(row.lease_expires_at
        ? { leaseExpiresAt: asIso(row.lease_expires_at) }
        : {}),
      ...(row.started_at ? { startedAt: asIso(row.started_at) } : {}),
      ...(row.completed_at ? { completedAt: asIso(row.completed_at) } : {}),
      ...(row.result ? { result: asJsonObject(row.result) } : {}),
      ...(row.error ? { error: asJsonObject(row.error) } : {}),
    };
  }

  private effectClaim(row: EffectRow): RuntimeEffectClaim {
    const record = this.effectRecord(row);
    if (
      record.status !== 'claimed'
      || !record.workerId
      || !record.leaseId
      || record.fencingToken === undefined
      || !record.leaseExpiresAt
    ) {
      throw new WorkerRuntimeError(
        'WORKER_INVALID',
        `Claimed effect ${record.effectId} is missing lease fields`,
      );
    }
    return {
      ...record,
      status: 'claimed',
      workerId: record.workerId,
      leaseId: record.leaseId,
      fencingToken: record.fencingToken,
      leaseExpiresAt: record.leaseExpiresAt,
    };
  }

  private leaseLost(
    lease: DurableExecutionFence & {
      readonly sessionId: SessionId;
      readonly ownerId?: WorkerId;
    },
  ): DurableExecutionLeaseError {
    return new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      `Execution lease ${lease.leaseId} is not active for Session ${lease.sessionId}`,
      {
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      },
    );
  }

  private nextFencingToken(
    sessionId: SessionId,
    current: number,
  ): FencingToken {
    const next = current + 1;
    if (!Number.isSafeInteger(next) || next < 1) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Execution lease fencing token is exhausted for Session ${sessionId}`,
        { sessionId },
      );
    }
    return FencingToken(next);
  }

  private assertWorkerId(workerId: WorkerId): void {
    if (!workerId.trim()) {
      throw new WorkerRuntimeError('WORKER_INVALID', 'workerId must not be empty');
    }
  }

  private assertTenantSession(tenantId: string, sessionId: SessionId): void {
    if (!tenantId.trim() || !sessionId.trim()) {
      throw new WorkerRuntimeError(
        'WORKER_INVALID',
        'tenantId and sessionId must not be empty',
      );
    }
  }

  private assertLeaseIdentity(
    sessionId: SessionId,
    lease: {
      readonly sessionId?: SessionId;
      readonly leaseId: ExecutionLeaseId;
      readonly ownerId: WorkerId;
    },
  ): void {
    if (
      !lease.leaseId.trim()
      || !lease.ownerId.trim()
      || (lease.sessionId !== undefined && lease.sessionId !== sessionId)
    ) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Invalid execution lease identity for Session ${sessionId}`,
        { sessionId, leaseId: lease.leaseId },
      );
    }
  }

  private table(suffix: string): string {
    return `${this.schema}.${quoteIdentifier(`${this.prefix}_${suffix}`)}`;
  }

  private queryClient(): Pool | PoolClient {
    return this.transactionContext.getStore() ?? this.pool;
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const activeClient = this.transactionContext.getStore();
    if (activeClient) {
      return operation(activeClient);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.transactionContext.run(
        client,
        () => operation(client),
      );
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
    const [first, second] = lockKey(key);
    await client.query(
      'SELECT pg_advisory_xact_lock($1, $2)',
      [first, second],
    );
  }
}
