import type { PoolClient, QueryResultRow } from 'pg';
import type { DurableExecutionLease } from '../session/events/DurableExecutionLeaseStore.js';
import { ExecutionLeaseId, FencingToken, SessionId, WorkerId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import { postgresInteger, postgresJsonObject, postgresTimestamp } from './PostgresContext.js';
import { PostgresExecutionLeases } from './PostgresExecutionLeases.js';
import {
  assertRuntimeSessionTransition,
  type RuntimeRecoveryResult,
  type RuntimeSessionClaim,
  type RuntimeSessionClaimOptions,
  type RuntimeSessionRoute,
  type RuntimeSessionSettlement,
  type RuntimeSessionState,
  type RuntimeWorkerRecord,
  type RuntimeWorkerRegistration,
  SEALED_COMMAND_ABANDON_AFTER_MS,
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

function assertJsonObject(value: unknown, label: string): void {
  try {
    postgresJsonObject(value, label);
  } catch (cause) {
    throw new WorkerRuntimeError('WORKER_INVALID', `${label} must be a JSON object`, { cause });
  }
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
    throw new WorkerRuntimeError('WORKER_INVALID', 'Session priority must be a safe integer');
  }
}

export abstract class PostgresWorkerRuntime
  extends PostgresExecutionLeases
  implements WorkerRuntimeStore
{
  async createWorkerSchema(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.db.table('workers')} (
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

      CREATE TABLE IF NOT EXISTS ${this.db.table('execution_leases')} (
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

      CREATE TABLE IF NOT EXISTS ${this.db.table('session_routes')} (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN (
            'queued', 'provisioning', 'running', 'waiting_approval',
              'suspended', 'idle', 'completed', 'failed'
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

      CREATE INDEX IF NOT EXISTS ${this.db.prefix}_session_routes_queue_idx
        ON ${this.db.table('session_routes')} (
          state, priority DESC, queued_at ASC, tenant_id, session_id
        );

      CREATE INDEX IF NOT EXISTS ${this.db.prefix}_session_routes_worker_idx
        ON ${this.db.table('session_routes')} (worker_id, state, lease_expires_at);
    `);
  }

  async registerWorker(registration: RuntimeWorkerRegistration): Promise<RuntimeWorkerRecord> {
    this.assertWorkerId(registration.workerId);
    assertCapacity(registration.capacity);
    assertTtl(registration.ttlMs);
    assertJsonObject(registration.metadata ?? {}, 'Worker metadata');
    await this.initialize();
    const result = await this.db.client().query<WorkerRow>(
      `INSERT INTO ${this.db.table('workers')} (
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
         draining_at = NULL
       RETURNING *, 0::int AS active_sessions, TRUE AS heartbeat_active`,
      [
        registration.workerId,
        registration.capacity,
        JSON.stringify(registration.metadata ?? {}),
        registration.ttlMs,
      ],
    );
    return this.workerRecord(result.rows[0]);
  }

  async heartbeatWorker(workerId: WorkerId, ttlMs: number): Promise<RuntimeWorkerRecord> {
    this.assertWorkerId(workerId);
    assertTtl(ttlMs);
    await this.initialize();
    const result = await this.db.client().query<WorkerRow>(
      `UPDATE ${this.db.table('workers')}
          SET last_heartbeat_at = NOW(),
              lease_expires_at = NOW() + ($2 * INTERVAL '1 millisecond')
        WHERE worker_id = $1 AND status IN ('active', 'draining')
        RETURNING *, 0::int AS active_sessions, TRUE AS heartbeat_active`,
      [workerId, ttlMs],
    );
    if (result.rowCount !== 1) {
      throw new WorkerRuntimeError(
        'WORKER_UNAVAILABLE',
        `Worker ${workerId} is not registered or is offline`,
      );
    }
    return this.workerRecord(result.rows[0]);
  }

  async drainWorker(workerId: WorkerId): Promise<RuntimeWorkerRecord> {
    this.assertWorkerId(workerId);
    await this.initialize();
    const result = await this.db.client().query<WorkerRow>(
      `UPDATE ${this.db.table('workers')}
          SET status = 'draining',
              draining_at = COALESCE(draining_at, NOW())
        WHERE worker_id = $1 AND status <> 'offline'
        RETURNING *, 0::int AS active_sessions, TRUE AS heartbeat_active`,
      [workerId],
    );
    if (result.rowCount !== 1) {
      throw new WorkerRuntimeError('WORKER_NOT_FOUND', `Worker ${workerId} was not found`);
    }
    return this.workerRecord(result.rows[0]);
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
    await this.initialize();
    return this.db.transaction(async (client) => {
      await this.db.lock(client, `execution:${tenantId}:${sessionId}`);
      const executionLease = await this.loadExecutionLease(client, tenantId, sessionId, true);
      if (executionLease?.active) {
        throw new WorkerRuntimeError(
          'SESSION_STATE_CONFLICT',
          `Session ${sessionId} has an active execution lease`,
        );
      }
      const current = await this.loadRoute(client, tenantId, sessionId, true);
      if (
        current &&
        current.state !== 'queued' &&
        current.state !== 'suspended' &&
        current.state !== 'idle'
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
          ExecutionLeaseId(current.lease_id),
          FencingToken(postgresInteger(current.fencing_token)),
        );
      }
      const result = await client.query<SessionRouteRow>(
        `INSERT INTO ${this.db.table('session_routes')} (
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

  async claimSession(options: RuntimeSessionClaimOptions): Promise<RuntimeSessionClaim | null> {
    this.assertWorkerId(options.ownerId);
    if (!options.leaseId.trim()) {
      throw new WorkerRuntimeError('WORKER_INVALID', 'Session leaseId must not be empty');
    }
    assertTtl(options.ttlMs);
    if (options.tenantId !== undefined && !options.tenantId.trim()) {
      throw new WorkerRuntimeError('WORKER_INVALID', 'tenantId must not be empty');
    }
    options.signal?.throwIfAborted();
    await this.initialize();
    await this.recoverExpiredWork();
    const claim = await this.db.transaction(async (client) => {
      options.signal?.throwIfAborted();
      const worker = await this.lockAvailableWorker(client, options.ownerId);
      const active = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM ${this.db.table('session_routes')}
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
           FROM ${this.db.table('session_routes')}
          WHERE state IN ('queued', 'suspended')
            AND worker_id IS NULL
            AND ($1::text IS NULL OR tenant_id = $1)
          ORDER BY priority DESC, queued_at ASC, tenant_id ASC, session_id ASC
          LIMIT 16`,
        [options.tenantId ?? null],
      );
      for (const candidate of candidates.rows) {
        const sessionId = SessionId(candidate.session_id);
        await this.db.lock(client, `execution:${candidate.tenant_id}:${sessionId}`);
        const row = await this.loadRoute(client, candidate.tenant_id, sessionId, true);
        if (
          !row ||
          (row.state !== 'queued' && row.state !== 'suspended') ||
          row.worker_id !== null
        ) {
          continue;
        }
        const currentLease = await this.loadExecutionLease(client, row.tenant_id, sessionId, true);
        if (currentLease?.active) {
          continue;
        }
        const nextToken = this.nextFencingToken(
          sessionId,
          Math.max(
            postgresInteger(row.fencing_token),
            currentLease ? postgresInteger(currentLease.fencing_token) : 0,
          ),
        );
        const updated = await client.query<SessionRouteRow>(
          `UPDATE ${this.db.table('session_routes')}
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
    this.assertRoutePayload(transition.metadata, transition.failure);
    return this.changeSession(tenantId, lease, transition.state, {
      expectedState: transition.expectedState,
      metadata: transition.metadata,
      failure: transition.failure,
    });
  }

  async settleSession(
    tenantId: string,
    lease: DurableExecutionLease,
    settlement: RuntimeSessionSettlement,
  ): Promise<RuntimeSessionRoute> {
    this.assertTenantSession(tenantId, lease.sessionId);
    this.assertRoutePayload(settlement.metadata, settlement.failure);
    if (settlement.state === 'failed' && !settlement.failure) {
      throw new WorkerRuntimeError(
        'WORKER_INVALID',
        'Failed Session settlement requires failure details',
      );
    }
    return this.changeSession(tenantId, lease, settlement.state, {
      allowReleased: true,
      metadata: settlement.metadata,
      failure: settlement.failure,
    });
  }

  async handoffSession(
    tenantId: string,
    lease: DurableExecutionLease,
    metadata?: JsonObject,
  ): Promise<RuntimeSessionRoute> {
    this.assertTenantSession(tenantId, lease.sessionId);
    this.assertRoutePayload(metadata);
    return this.changeSession(tenantId, lease, 'suspended', {
      allowReleased: true,
      metadata,
    });
  }

  private async changeSession(
    tenantId: string,
    lease: DurableExecutionLease,
    state: RuntimeSessionState,
    options: {
      expectedState?: RuntimeSessionState;
      allowReleased?: boolean;
      metadata?: JsonObject;
      failure?: JsonObject;
    },
  ): Promise<RuntimeSessionRoute> {
    await this.initialize();
    return this.db.transaction(async (client) => {
      await this.db.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      const [route, persisted] = await Promise.all([
        this.loadRoute(client, tenantId, lease.sessionId, true),
        this.loadExecutionLease(client, tenantId, lease.sessionId, true),
      ]);
      if (!route) {
        throw new WorkerRuntimeError(
          'SESSION_ROUTE_NOT_FOUND',
          `Session route ${tenantId}/${lease.sessionId} was not found`,
        );
      }
      const sameLease =
        persisted?.lease_id === lease.leaseId &&
        persisted.owner_id === lease.ownerId &&
        postgresInteger(persisted.fencing_token) === lease.fencingToken;
      const replay = options.allowReleased && sameLease && persisted.released_at !== null;
      if (!replay) {
        await this.assertExecutionLeaseWithClient(client, tenantId, lease, true);
      }
      if (options.expectedState && route.state !== options.expectedState) {
        throw new WorkerRuntimeError(
          'SESSION_STATE_CONFLICT',
          `Expected Session ${lease.sessionId} in ${options.expectedState}, but found ${route.state}`,
        );
      }
      assertRuntimeSessionTransition(route.state, state);
      const terminal = ['idle', 'completed', 'failed', 'suspended'].includes(state);
      const result = await client.query<SessionRouteRow>(
        `UPDATE ${this.db.table('session_routes')}
            SET state = $5,
                worker_id = CASE WHEN $6 THEN NULL ELSE worker_id END,
                lease_id = CASE WHEN $6 THEN NULL ELSE lease_id END,
                lease_expires_at = CASE WHEN $6 THEN NULL ELSE lease_expires_at END,
                metadata = COALESCE($7::jsonb, metadata),
                failure = COALESCE($8::jsonb, failure),
                updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2 AND fencing_token = $4
            AND (lease_id = $3 OR ($9 AND lease_id IS NULL))
          RETURNING *`,
        [
          tenantId,
          lease.sessionId,
          lease.leaseId,
          lease.fencingToken,
          state,
          terminal,
          options.metadata ? JSON.stringify(options.metadata) : null,
          options.failure ? JSON.stringify(options.failure) : null,
          replay,
        ],
      );
      if (!result.rows[0]) {
        throw this.leaseLost(lease);
      }
      if (terminal && !replay) {
        await this.releaseExecutionLeaseRow(
          client,
          tenantId,
          lease.sessionId,
          lease.leaseId,
          lease.fencingToken,
        );
      }
      return this.routeRecord(result.rows[0]);
    });
  }

  async getSessionRoute(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<RuntimeSessionRoute | null> {
    this.assertTenantSession(tenantId, sessionId);
    await this.initialize();
    const result = await this.db.client().query<SessionRouteRow>(
      `SELECT *
         FROM ${this.db.table('session_routes')}
        WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    );
    return result.rows[0] ? this.routeRecord(result.rows[0]) : null;
  }

  async listWorkerSessions(workerId: WorkerId): Promise<readonly RuntimeSessionRoute[]> {
    this.assertWorkerId(workerId);
    await this.initialize();
    const result = await this.db.client().query<SessionRouteRow>(
      `SELECT * FROM ${this.db.table('session_routes')}
        WHERE worker_id = $1 ORDER BY updated_at, tenant_id, session_id`,
      [workerId],
    );
    return result.rows.map((row) => this.routeRecord(row));
  }

  async recoverExpiredWork(): Promise<RuntimeRecoveryResult> {
    // See the abandonment statement below for why this window exists.
    await this.initialize();
    return this.db.transaction(async (client) => {
      const offlineWorkers = await client.query(
        `UPDATE ${this.db.table('workers')}
            SET status = 'offline'
          WHERE status <> 'offline' AND lease_expires_at <= NOW()`,
      );
      await client.query(
        `UPDATE ${this.db.table('execution_leases')} leases
            SET released_at = COALESCE(released_at, NOW())
          WHERE released_at IS NULL
            AND (
              expires_at <= NOW()
              OR EXISTS (
                SELECT 1
                  FROM ${this.db.table('workers')} workers
                 WHERE workers.worker_id = leases.owner_id
                   AND workers.status = 'offline'
              )
            )`,
      );
      const suspendedSessions = await client.query(
        `UPDATE ${this.db.table('session_routes')} routes
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
                  FROM ${this.db.table('workers')} workers
                 WHERE workers.worker_id = routes.worker_id
                   AND workers.status = 'offline'
              )
            )`,
        [ACTIVE_SESSION_STATES],
      );
      // A command sealed before its side effect and never completed would answer
      // `in_progress` forever. Its lease cannot expire (sealing sets no deadline),
      // so the only safe resolution is to abandon it after a generous window and
      // let the caller reconcile. The side effect may have happened, which is why
      // it is never re-executed.
      const abandonedCommands = await client.query(
        `UPDATE ${this.db.table('commands')}
            SET status = 'abandoned',
                abandon_reason = 'sealed command did not complete within the abandonment window',
                updated_at = NOW()
          WHERE status = 'sealed'
            AND result IS NULL
            AND updated_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
        [SEALED_COMMAND_ABANDON_AFTER_MS],
      );
      return {
        offlineWorkers: offlineWorkers.rowCount ?? 0,
        suspendedSessions: suspendedSessions.rowCount ?? 0,
        abandonedCommands: abandonedCommands.rowCount ?? 0,
      };
    });
  }

  private async lockAvailableWorker(
    client: PoolClient,
    workerId: WorkerId,
  ): Promise<{ capacity: number }> {
    const result = await client.query<WorkerRow>(
      `SELECT *, 0::int AS active_sessions,
              lease_expires_at > NOW() AS heartbeat_active
         FROM ${this.db.table('workers')}
        WHERE worker_id = $1
        FOR UPDATE`,
      [workerId],
    );
    const worker = result.rows[0];
    if (!worker) {
      throw new WorkerRuntimeError('WORKER_NOT_FOUND', `Worker ${workerId} was not found`);
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
         FROM ${this.db.table('session_routes')}
        WHERE tenant_id = $1 AND session_id = $2
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, sessionId],
    );
    return result.rows[0] ?? null;
  }

  private workerRecord(row: WorkerRow): RuntimeWorkerRecord {
    return {
      workerId: WorkerId(row.worker_id),
      status: row.status,
      capacity: row.capacity,
      activeSessions: row.active_sessions,
      metadata: postgresJsonObject(row.metadata),
      registeredAt: postgresTimestamp(row.registered_at),
      lastHeartbeatAt: postgresTimestamp(row.last_heartbeat_at),
      leaseExpiresAt: postgresTimestamp(row.lease_expires_at),
      ...(row.draining_at ? { drainingAt: postgresTimestamp(row.draining_at) } : {}),
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
      sessionId: SessionId(row.session_id),
      state: row.state,
      priority: row.priority,
      attempt: row.attempt,
      fencingToken: FencingToken(postgresInteger(row.fencing_token)),
      ...(row.worker_id ? { workerId: WorkerId(row.worker_id) } : {}),
      ...(row.lease_id ? { leaseId: ExecutionLeaseId(row.lease_id) } : {}),
      ...(row.lease_expires_at ? { leaseExpiresAt: postgresTimestamp(row.lease_expires_at) } : {}),
      queuedAt: postgresTimestamp(row.queued_at),
      updatedAt: postgresTimestamp(row.updated_at),
      metadata: postgresJsonObject(row.metadata),
      ...(row.failure ? { failure: postgresJsonObject(row.failure) } : {}),
    };
  }

  private assertWorkerId(workerId: WorkerId): void {
    if (!workerId.trim()) {
      throw new WorkerRuntimeError('WORKER_INVALID', 'workerId must not be empty');
    }
  }

  private assertRoutePayload(metadata?: JsonObject, failure?: JsonObject): void {
    if (metadata) assertJsonObject(metadata, 'Session route metadata');
    if (failure) assertJsonObject(failure, 'Session route failure');
  }
}
