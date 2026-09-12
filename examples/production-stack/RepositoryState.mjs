import pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { AgentProtocolError } from '@blade-ai/agent-sdk/protocol';

/** Example-owned control records. SDK transcripts, events and fencing stay in RuntimeStore. */
export class RepositoryState {
  constructor({ connectionString, schema }) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new TypeError('Invalid schema');
    this.pool = new pg.Pool({ connectionString, max: 4 });
    this.prefix = `"${schema}"`;
  }

  async initialize() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.prefix}`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.prefix}.repository_state (
      session_id text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.prefix}.repository_permissions (
      session_id text NOT NULL, permission_id text NOT NULL, request_id text NOT NULL,
      request jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', decision jsonb,
      PRIMARY KEY (session_id, permission_id)
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.prefix}.repository_cancellations (
      session_id text NOT NULL, request_id text NOT NULL, status text NOT NULL DEFAULT 'requested',
      PRIMARY KEY (session_id, request_id)
    )`);
  }

  async get(sessionId) {
    const { rows } = await this.pool.query(
      `SELECT value FROM ${this.prefix}.repository_state WHERE session_id = $1`, [sessionId],
    );
    return rows[0]?.value ?? {};
  }

  async update(sessionId, patch) {
    const { rows } = await this.pool.query(
      `INSERT INTO ${this.prefix}.repository_state AS s (session_id, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET value = s.value || EXCLUDED.value RETURNING value`,
      [sessionId, JSON.stringify(patch)],
    );
    return rows[0].value;
  }

  async requestPermission({ sessionId, requestId, permissionRequestId, request }) {
    await this.pool.query(
      `INSERT INTO ${this.prefix}.repository_permissions (session_id, permission_id, request_id, request)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
      [sessionId, permissionRequestId, requestId, JSON.stringify(request)],
    );
    const record = await this.getPermission(sessionId, permissionRequestId);
    if (record.requestId !== requestId || record.request.toolName !== request.toolName
        || !isDeepStrictEqual(record.request.input, request.input)) {
      throw new Error('Permission ID cannot be reused for another operation');
    }
    return record;
  }

  async getPermission(sessionId, permissionRequestId) {
    const { rows } = await this.pool.query(
      `SELECT session_id AS "sessionId", permission_id AS "permissionRequestId", request_id AS "requestId",
       request, status, decision FROM ${this.prefix}.repository_permissions
       WHERE session_id = $1 AND permission_id = $2`, [sessionId, permissionRequestId],
    );
    return rows[0] ?? null;
  }

  async resolvePermission(sessionId, requestId, permissionRequestId, decision) {
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.prefix}.repository_permissions SET status = 'resolved', decision = $4::jsonb
       WHERE session_id = $1 AND request_id = $2 AND permission_id = $3 AND status = 'pending'`,
      [sessionId, requestId, permissionRequestId, JSON.stringify(decision)],
    );
    if (!rowCount) {
      throw new AgentProtocolError('PERMISSION_NOT_FOUND', 'This permission is no longer pending', 404);
    }
  }

  async retirePermissions(sessionId, requestId) {
    await this.pool.query(
      `UPDATE ${this.prefix}.repository_permissions SET status = 'retired'
       WHERE session_id = $1 AND request_id = $2 AND status = 'pending'`, [sessionId, requestId],
    );
  }

  async requestCancel(sessionId, requestId) {
    await this.pool.query(
      `INSERT INTO ${this.prefix}.repository_cancellations (session_id, request_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [sessionId, requestId],
    );
    return this.getCancellation(sessionId, requestId);
  }

  async getCancellation(sessionId, requestId) {
    const { rows } = await this.pool.query(
      `SELECT status FROM ${this.prefix}.repository_cancellations WHERE session_id = $1 AND request_id = $2`,
      [sessionId, requestId],
    );
    return rows[0] ?? null;
  }

  async isCancelled(sessionId, requestId) {
    return Boolean(await this.getCancellation(sessionId, requestId));
  }

  async markCancelled(sessionId, requestId) {
    await this.pool.query(
      `UPDATE ${this.prefix}.repository_cancellations SET status = 'completed'
       WHERE session_id = $1 AND request_id = $2`, [sessionId, requestId],
    );
  }

  async close() { await this.pool.end(); }
}
