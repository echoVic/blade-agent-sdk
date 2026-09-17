import type { PoolClient, QueryResultRow } from 'pg';
import type { DurableEventOperationOptions } from '../session/events/DurableEventStore.js';
import {
  type DurableExecutionFence,
  type DurableExecutionLease,
  type DurableExecutionLeaseAcquireOptions,
  DurableExecutionLeaseError,
} from '../session/events/DurableExecutionLeaseStore.js';
import { ExecutionLeaseId, FencingToken, SessionId, WorkerId } from '../types/identifiers.js';
import { type PostgresContext, postgresInteger, postgresTimestamp } from './PostgresContext.js';

const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATES = ['provisioning', 'running', 'waiting_approval'];

interface ExecutionLeaseRow extends QueryResultRow {
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

export abstract class PostgresExecutionLeases {
  constructor(protected readonly db: PostgresContext) {}

  abstract initialize(): Promise<void>;

  async requiresExecutionLease(
    tenantId: string,
    sessionId: SessionId,
    options: DurableEventOperationOptions = {},
  ): Promise<boolean> {
    this.assertTenantSession(tenantId, sessionId);
    options.signal?.throwIfAborted();
    await this.initialize();
    const result = await this.db.client().query(
      `SELECT 1 FROM ${this.db.table('execution_leases')}
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
    await this.initialize();
    return this.db.transaction(async (client) => {
      await this.db.lock(client, `execution:${tenantId}:${sessionId}`);
      const current = await this.loadExecutionLease(client, tenantId, sessionId, true);
      if (
        current?.active &&
        (current.lease_id !== options.leaseId || current.owner_id !== options.ownerId)
      ) {
        throw new DurableExecutionLeaseError(
          'DURABLE_EXECUTION_LEASE_CONFLICT',
          `Session ${sessionId} is leased by worker ${current.owner_id}`,
          {
            sessionId,
            leaseId: options.leaseId,
            fencingToken: FencingToken(postgresInteger(current.fencing_token)),
            activeLease: this.executionLease(current),
          },
        );
      }
      const reuse =
        current?.active === true &&
        current.lease_id === options.leaseId &&
        current.owner_id === options.ownerId;
      const fencingToken =
        reuse && current
          ? FencingToken(postgresInteger(current.fencing_token))
          : this.nextFencingToken(sessionId, current ? postgresInteger(current.fencing_token) : 0);
      return this.upsertExecutionLease(
        client,
        tenantId,
        sessionId,
        options,
        fencingToken,
        reuse && current ? postgresTimestamp(current.acquired_at) : undefined,
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
    await this.initialize();
    return this.db.transaction(async (client) => {
      await this.db.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      await this.assertExecutionLeaseWithClient(client, tenantId, lease, true);
      const result = await client.query<ExecutionLeaseRow>(
        `UPDATE ${this.db.table('execution_leases')}
            SET renewed_at = NOW(), expires_at = NOW() + ($5 * INTERVAL '1 millisecond')
          WHERE tenant_id = $1 AND session_id = $2 AND lease_id = $3 AND fencing_token = $4
          RETURNING *`,
        [tenantId, lease.sessionId, lease.leaseId, lease.fencingToken, ttlMs],
      );
      const renewed = result.rows[0];
      if (!renewed) throw this.leaseLost(lease);
      await client.query(
        `UPDATE ${this.db.table('session_routes')} SET lease_expires_at = $5, updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2 AND lease_id = $3 AND fencing_token = $4`,
        [tenantId, lease.sessionId, lease.leaseId, lease.fencingToken, renewed.expires_at],
      );
      return this.executionLease(renewed);
    });
  }

  async assertExecutionLease(
    tenantId: string,
    lease: DurableExecutionLease,
    options: DurableEventOperationOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    await this.initialize();
    await this.db.transaction(async (client) => {
      await this.db.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      await this.assertExecutionLeaseWithClient(client, tenantId, lease, true);
    });
  }

  async withExecutionLease<T>(
    tenantId: string,
    lease: DurableExecutionLease,
    operation: () => Promise<T>,
    options: DurableEventOperationOptions = {},
  ): Promise<T> {
    options.signal?.throwIfAborted();
    await this.initialize();
    return this.db.transaction(async (client) => {
      await this.db.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      await this.assertExecutionLeaseWithClient(client, tenantId, lease, true);
      return operation();
    });
  }

  async releaseExecutionLease(
    tenantId: string,
    lease: DurableExecutionLease,
    options: DurableEventOperationOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    await this.initialize();
    await this.db.transaction(async (client) => {
      await this.db.lock(client, `execution:${tenantId}:${lease.sessionId}`);
      const current = await this.loadExecutionLease(client, tenantId, lease.sessionId, true);
      if (
        current?.released_at &&
        current.lease_id === lease.leaseId &&
        postgresInteger(current.fencing_token) === lease.fencingToken
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
        `UPDATE ${this.db.table('session_routes')}
            SET state = CASE WHEN state = ANY($5::text[]) THEN 'suspended' ELSE state END,
                worker_id = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2 AND lease_id = $3 AND fencing_token = $4`,
        [tenantId, lease.sessionId, lease.leaseId, lease.fencingToken, ACTIVE_SESSION_STATES],
      );
    });
  }

  async assertExecutionFenceWithClient(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    fence: DurableExecutionFence | undefined,
  ): Promise<void> {
    await this.db.lock(client, `execution:${tenantId}:${sessionId}`);
    const current = await this.loadExecutionLease(client, tenantId, sessionId, true);
    if (!current) {
      if (fence) throw this.leaseLost({ ...fence, sessionId });
      return;
    }
    if (!fence) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_REQUIRED',
        `Session ${sessionId} requires an execution lease`,
        { sessionId, ...(current.active ? { activeLease: this.executionLease(current) } : {}) },
      );
    }
    await this.assertExecutionLeaseWithClient(client, tenantId, { ...fence, sessionId }, true);
  }

  protected async loadExecutionLease(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    forUpdate: boolean,
  ): Promise<ExecutionLeaseRow | null> {
    const result = await client.query<ExecutionLeaseRow>(
      `SELECT *, released_at IS NULL AND expires_at > NOW() AS active
         FROM ${this.db.table('execution_leases')}
        WHERE tenant_id = $1 AND session_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, sessionId],
    );
    return result.rows[0] ?? null;
  }

  protected async upsertExecutionLease(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    options: DurableExecutionLeaseAcquireOptions,
    fencingToken: FencingToken,
    acquiredAt?: string,
  ): Promise<DurableExecutionLease> {
    const result = await client.query<ExecutionLeaseRow>(
      `INSERT INTO ${this.db.table('execution_leases')} (
         tenant_id, session_id, fencing_token, lease_id, owner_id,
         acquired_at, renewed_at, expires_at, released_at
       ) VALUES (
         $1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), NOW(),
         NOW() + ($7 * INTERVAL '1 millisecond'), NULL
       ) ON CONFLICT (tenant_id, session_id) DO UPDATE SET
         fencing_token = EXCLUDED.fencing_token, lease_id = EXCLUDED.lease_id,
         owner_id = EXCLUDED.owner_id, acquired_at = EXCLUDED.acquired_at,
         renewed_at = EXCLUDED.renewed_at, expires_at = EXCLUDED.expires_at, released_at = NULL
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
    if (!result.rows[0]) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_WRITE_FAILED',
        `Execution lease for Session ${sessionId} was not stored`,
        { sessionId, leaseId: options.leaseId },
      );
    }
    return this.executionLease(result.rows[0]);
  }

  protected async assertExecutionLeaseWithClient(
    client: PoolClient,
    tenantId: string,
    lease: DurableExecutionFence & { sessionId: SessionId; ownerId?: WorkerId },
    requireUnexpired: boolean,
  ): Promise<ExecutionLeaseRow> {
    const current = await this.loadExecutionLease(client, tenantId, lease.sessionId, true);
    if (
      !current ||
      current.released_at !== null ||
      current.lease_id !== lease.leaseId ||
      postgresInteger(current.fencing_token) !== lease.fencingToken ||
      (lease.ownerId && current.owner_id !== lease.ownerId) ||
      (requireUnexpired && !current.active)
    ) {
      throw this.leaseLost(lease);
    }
    return current;
  }

  protected async releaseExecutionLeaseRow(
    client: PoolClient,
    tenantId: string,
    sessionId: SessionId,
    leaseId: ExecutionLeaseId,
    fencingToken: FencingToken,
  ): Promise<void> {
    await client.query(
      `UPDATE ${this.db.table('execution_leases')} SET released_at = COALESCE(released_at, NOW())
        WHERE tenant_id = $1 AND session_id = $2 AND lease_id = $3 AND fencing_token = $4`,
      [tenantId, sessionId, leaseId, fencingToken],
    );
  }

  protected executionLease(row: ExecutionLeaseRow): DurableExecutionLease {
    return {
      sessionId: SessionId(row.session_id),
      leaseId: ExecutionLeaseId(row.lease_id),
      ownerId: WorkerId(row.owner_id),
      fencingToken: FencingToken(postgresInteger(row.fencing_token)),
      acquiredAt: postgresTimestamp(row.acquired_at),
      renewedAt: postgresTimestamp(row.renewed_at),
      expiresAt: postgresTimestamp(row.expires_at),
    };
  }

  protected leaseLost(
    lease: DurableExecutionFence & { sessionId: SessionId },
  ): DurableExecutionLeaseError {
    return new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      `Execution lease ${lease.leaseId} is not active for Session ${lease.sessionId}`,
      { sessionId: lease.sessionId, leaseId: lease.leaseId, fencingToken: lease.fencingToken },
    );
  }

  protected nextFencingToken(sessionId: SessionId, current: number): FencingToken {
    const next = current + 1;
    if (!Number.isSafeInteger(next)) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Execution lease fencing token is exhausted for Session ${sessionId}`,
        { sessionId },
      );
    }
    return FencingToken(next);
  }

  protected assertTenantSession(tenantId: string, sessionId: SessionId): void {
    if (!tenantId.trim() || !sessionId.trim()) {
      throw new TypeError('tenantId and sessionId must not be empty');
    }
  }

  private assertLeaseIdentity(
    sessionId: SessionId,
    lease: { sessionId?: SessionId; leaseId: ExecutionLeaseId; ownerId: WorkerId },
  ): void {
    if (
      !lease.leaseId.trim() ||
      !lease.ownerId.trim() ||
      (lease.sessionId && lease.sessionId !== sessionId)
    ) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Invalid execution lease identity for Session ${sessionId}`,
        { sessionId, leaseId: lease.leaseId },
      );
    }
  }
}

function assertTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new RangeError(`Lease ttlMs must be between 1 and ${MAX_LEASE_TTL_MS}`);
  }
}
